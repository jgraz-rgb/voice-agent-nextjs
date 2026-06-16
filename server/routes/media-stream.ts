import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { callManager } from '../services/call-manager.js';
import { numberLeaseManager } from '../services/number-lease-manager.js';
import { logger } from '../utils/logger.js';
import type { TwilioMediaMessage } from '../types/index.js';
import { eventBroadcaster } from './events.js';
import { createSarvamStream, isSpeakable, isValidHindiTranscript, TextChunker } from '../services/sarvam-tts.js';

// ── G.711 μ-law ↔ PCM16 conversion ──────────────────────────────────────────

const MULAW_DECODE: Int16Array = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xff;
    const sign = u & 0x80;
    const exp  = (u >> 4) & 0x07;
    const mant = u & 0x0f;
    let s = ((mant << 3) + 0x84) << exp;
    s -= 0x84;
    t[i] = sign ? -s : s;
  }
  return t;
})();

function mulawToPcm16(src: Buffer): Buffer {
  const dst = Buffer.allocUnsafe(src.length * 2);
  for (let i = 0; i < src.length; i++) dst.writeInt16LE(MULAW_DECODE[src[i]], i * 2);
  return dst;
}

function upsample8to24(src: Buffer): Buffer {
  const samples = src.length >> 1;
  const dst = Buffer.allocUnsafe(samples * 3 * 2);
  for (let i = 0; i < samples; i++) {
    const s0 = src.readInt16LE(i * 2);
    const s1 = i + 1 < samples ? src.readInt16LE((i + 1) * 2) : s0;
    dst.writeInt16LE(s0, (i * 3) * 2);
    dst.writeInt16LE(Math.round(s0 + (s1 - s0) / 3), (i * 3 + 1) * 2);
    dst.writeInt16LE(Math.round(s0 + (s1 - s0) * 2 / 3), (i * 3 + 2) * 2);
  }
  return dst;
}

function downsample24to8(src: Buffer): Buffer {
  const samples = src.length >> 1;
  const outSamples = Math.floor(samples / 3);
  const dst = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const s0 = src.readInt16LE((i * 3) * 2);
    const s1 = src.readInt16LE((i * 3 + 1) * 2);
    const s2 = src.readInt16LE((i * 3 + 2) * 2);
    dst.writeInt16LE(Math.round((s0 + s1 + s2) / 3), i * 2);
  }
  return dst;
}

function pcm16ToMulaw(src: Buffer): Buffer {
  const MULAW_MAX  = 0x1FFF;
  const MULAW_BIAS = 33;
  const dst = Buffer.allocUnsafe(src.length >> 1);
  for (let i = 0; i < dst.length; i++) {
    let sample = src.readInt16LE(i * 2);
    let sign = 0;
    if (sample < 0) { sign = 0x80; sample = -sample; }
    sample += MULAW_BIAS;
    if (sample > MULAW_MAX) sample = MULAW_MAX;
    let exp = 7;
    let mask = 0x1000;
    while ((sample & mask) === 0 && exp > 0) { exp--; mask >>= 1; }
    const mantissa = (sample >> (exp + 1)) & 0x0F;
    dst[i] = ~(sign | (exp << 4) | mantissa) & 0xFF;
  }
  return dst;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LIC_AGENT_KEY = 'licSales';

// For the greeting turn, force text output with no tools so OpenAI speaks instead of calling a function.
// gpt-realtime-1.5 (client-secrets model) is configured at session creation time — session.update
// with modalities/tools is not supported. Instead, override per-response with tool_choice: 'none'.
function buildGreetingResponse() {
  return {
    type: 'response.create',
    response: {
      tool_choice: 'none',
    },
  };
}

// Build the args for the automatic end-of-call createZendeskTicket, matched to
// each agent's handler. LIC builds the ticket from collected state and only needs
// lead_category/call_disposition; AAA/Kotak/Health expect a subject plus a status
// field and read the remaining details from the shared session state file. Sending
// the wrong shape yields an undefined subject and a rejected/malformed ticket — the
// reason non-LIC phone calls weren't producing real Zendesk tickets on drop.
function buildCallEndTicketArgs(agentKey: string): Record<string, unknown> {
  switch (agentKey) {
    case LIC_AGENT_KEY:
      return { lead_category: 'COLD', call_disposition: 'dropped' };
    case 'usHealthInsurance':
      return { subject: 'Phone call dropped — Health Insurance Renewal', renewal_status: 'dropped' };
    case 'aaaInsurance':
    case 'kotakInsurance':
    default:
      return { subject: `Phone call dropped — ${agentKey}`, application_status: 'dropped' };
  }
}

// ── Warm connection store ─────────────────────────────────────────────────────

interface WarmEntry {
  ws: WebSocket;
  ready: boolean;
  greetingDone: boolean;
  agentSpeaking: boolean;
  isLic: boolean;
  greetingBuffer: Buffer[];
  liveFlush: ((mulaw: Buffer) => void) | null;
  onGreetingDone: (() => void) | null;  // called when TTS queue drains after pickup
  // LIC only: prewarm TTS objects handed off to live path if pickup happens mid-response
  prewarmSarvam: ReturnType<typeof createSarvamStream> | null;
  prewarmChunker: TextChunker | null;
}

const warmStore = new Map<string, WarmEntry>();

// Called by lease.ts immediately after makeCall() — warms OpenAI while the phone rings.
export async function prewarmOpenAI(callSid: string, agentKey: string): Promise<void> {
  const isLic = agentKey === LIC_AGENT_KEY;
  logger.info('[PREWARM] Starting warm OpenAI connection', { callSid, agentKey, isLic });

  const entry: WarmEntry = {
    ws: null as unknown as WebSocket,
    ready: false,
    greetingDone: false,
    agentSpeaking: false,
    isLic,
    greetingBuffer: [],
    liveFlush: null,
    onGreetingDone: null,
    prewarmSarvam: null,
    prewarmChunker: null,
  };
  warmStore.set(callSid, entry);

  try {
    const outputModalities = isLic ? ['text'] : ['audio'];

    // Fetch tool schemas from the local Next.js API (resolves from allAgentSets,
    // same source as the browser). The external backend lacks schemas for locally-
    // defined agents (e.g. aaaInsurance), so we always prefer the local source.
    let agentTools: unknown[] | undefined;
    try {
      const toolsRes = await fetch(`https://bfsi.searchunify.com/bfsi-agentic-suite/api/schemas?agentKey=${agentKey}`);
      if (toolsRes.ok) {
        const toolsData = await toolsRes.json();
        if (Array.isArray(toolsData.tools) && toolsData.tools.length > 0) {
          agentTools = toolsData.tools;
          logger.info('[PREWARM] Fetched tool schemas', { callSid, agentKey, count: agentTools!.length });
        }
      }
    } catch (err: any) {
      logger.warn('[PREWARM] Could not fetch tool schemas — proceeding without tools', { callSid, agentKey, err: err.message });
    }

    const sessionRes = await fetch('https://bfsi.searchunify.com/bfsi-agentic-suite/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentKey, output_modalities: outputModalities, inject_lead_state: isLic, ...(agentTools ? { tools: agentTools } : {}) }),
    });
    const sessionData = await sessionRes.json();

    if (!sessionData.client_secret?.value) {
      logger.error('[PREWARM] No ephemeral key', sessionData);
      warmStore.delete(callSid);
      return;
    }

    const ephemeralKey = sessionData.client_secret.value;
    const realtimeModel = sessionData.session?.model ?? 'gpt-realtime-1.5';

    logger.info('[PREWARM] Opening OpenAI Realtime WS', { callSid, model: realtimeModel });
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${realtimeModel}`,
      { headers: { Authorization: `Bearer ${ephemeralKey}` } }
    );
    entry.ws = ws;

    // For LIC: open one persistent Sarvam WS for the entire call duration.
    // The WS stays open (keepalive pings keep it alive between responses).
    // Audio during prewarm goes into greetingBuffer; once pickup wires liveFlush,
    // subsequent chunks go directly to Twilio.
    const sarvamSession = isLic ? createSarvamStream(
      (mulaw) => {
        if (entry.liveFlush) {
          entry.liveFlush(mulaw);
          logger.info('[PREWARM] Streamed Sarvam chunk to live call', { callSid, bytes: mulaw.length });
        } else {
          entry.greetingBuffer.push(mulaw);
          logger.info('[PREWARM] Buffered Sarvam greeting chunk', { callSid, chunks: entry.greetingBuffer.length });
        }
      },
      () => {
        // Greeting "final" — all greeting audio emitted. WS stays open for subsequent responses.
        logger.info('[PREWARM] Sarvam greeting done', { callSid });
        entry.greetingDone = true;
        entry.onGreetingDone?.();
      },
      (err) => logger.error('[PREWARM] Sarvam stream error', { callSid, err: err.message }),
    ) : null;

    const chunker = isLic ? new TextChunker((text) => {
      if (isSpeakable(text)) {
        sarvamSession!.send(text);
      } else {
        logger.warn('[Sarvam][PREWARM] Skipping non-speakable chunk', { preview: text.slice(0, 60) });
      }
    }) : null;

    // Store references so the live path can continue using the same persistent session.
    entry.prewarmSarvam = sarvamSession;
    entry.prewarmChunker = chunker;

    ws.on('open', () => {
      logger.info('[PREWARM] OpenAI WS open', { callSid });
      entry.ready = true;
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi!' }] },
      }));
      ws.send(JSON.stringify(isLic ? buildGreetingResponse() : { type: 'response.create' }));
    });

    let prewarmIsToolCallItem = false;

    ws.on('message', (rawMsg: Buffer | string) => {
      try {
        const event = JSON.parse(rawMsg.toString());
        const NOISY = new Set(['response.audio.delta', 'response.output_audio.delta', 'input_audio_buffer.appended', 'response.output_text.delta']);
        if (!NOISY.has(event.type)) {
          logger.info('[PREWARM] OpenAI event', { callSid, type: event.type });
        }

        if (event.type === 'response.created') {
          prewarmIsToolCallItem = false;
        }
        if (event.type === 'response.output_item.added') {
          prewarmIsToolCallItem = event.item?.type === 'function_call';
        }

        if (isLic) {
          // LIC: buffer text → Sarvam TTS → μ-law (skip function_call arg deltas)
          if (!prewarmIsToolCallItem && event.type === 'response.output_text.delta' && event.delta) {
            chunker!.push(event.delta);
          }
          if (!prewarmIsToolCallItem && event.type === 'response.output_text.done') {
            chunker!.flush();
          }
        } else {
          // Audio modality: buffer μ-law directly
          const audioPayload = event.type === 'response.output_audio.delta'
            ? (event.delta ?? event.audio)
            : event.type === 'response.audio.delta' ? event.delta : null;

          if (audioPayload) {
            entry.agentSpeaking = true;
            const pcm24 = Buffer.from(audioPayload, 'base64');
            const mulaw = pcm16ToMulaw(downsample24to8(pcm24));
            entry.greetingBuffer.push(mulaw);
          }
        }

        if (event.type === 'response.done') {
          entry.agentSpeaking = false;
          // For LIC, greetingDone is set by Sarvam stream's onDone callback (after all audio emitted).
          // For non-LIC, OpenAI audio ends with response.done.
          if (!isLic && !entry.greetingDone) {
            entry.greetingDone = true;
            logger.info('[PREWARM] Greeting complete', { callSid, bufferedChunks: entry.greetingBuffer.length });
          }
          // Flush remaining text then tell Sarvam we're done sending so it emits a "final" event.
          // Do NOT close the WS here — Sarvam needs time to synthesize and stream audio back.
          // The WS is closed inside onDone (after "final" event) or on cancel/barge-in.
          if (isLic && chunker && sarvamSession) {
            chunker.flush();
            sarvamSession.flush();
          }
        }

        if (event.type === 'error') {
          logger.error('[PREWARM] OpenAI error', { callSid, error: event.error });
        }
      } catch (err) {
        logger.error('[PREWARM] Failed to parse OpenAI message', err);
      }
    });

    ws.on('error', (err) => logger.error('[PREWARM] OpenAI WS error', { callSid, err: err.message }));
    ws.on('close', (code) => logger.info('[PREWARM] OpenAI WS closed', { callSid, code }));

  } catch (err: any) {
    logger.error('[PREWARM] Failed to warm connection', { callSid, err: err.message });
    warmStore.delete(callSid);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function mediaStreamRoute(fastify: FastifyInstance) {
  fastify.get('/twilio/media-stream', { websocket: true }, (_twilioWs, _request) => {
    const twilioWs = _twilioWs as unknown as WebSocket;
    logger.info('Twilio media-stream WS connected');

    let callSid: string | null = null;
    let streamSid: string | null = null;
    let openaiWs: WebSocket | null = null;
    let openaiReady = false;
    let greetingDone = false;
    let agentSpeaking = false;
    let responseActive = false;
    let responseCancelled = false;
    let responseFlushed = false;
    let isLic = false;
    let activeAgentKey = 'aaaInsurance';
    // Persistent Sarvam session for the call lifetime (LIC only); destroyed on call end.
    let callSarvam: ReturnType<typeof createSarvamStream> | null = null;

    // Bidirectional audio counters for logging
    let twilioChunksReceived = 0;
    let openaiChunksSent = 0;
    let lastTwilioLogAt = 0;
    let lastOpenaiLogAt = 0;
    const AUDIO_LOG_INTERVAL_MS = 3000;

    const sendToOpenAI = (event: object) => {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify(event));
      }
    };

    // Twilio requires μ-law audio in 160-byte (20ms @ 8kHz) chunks.
    // Sending a large blob at once causes Twilio to drop or misplay it.
    const TWILIO_CHUNK_BYTES = 160;

    const sendMulawToTwilio = (mulaw: Buffer) => {
      if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
      for (let offset = 0; offset < mulaw.length; offset += TWILIO_CHUNK_BYTES) {
        const chunk = mulaw.subarray(offset, offset + TWILIO_CHUNK_BYTES);
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: chunk.toString('base64') },
        }));
        openaiChunksSent++;
      }
      const now = Date.now();
      if (now - lastOpenaiLogAt >= AUDIO_LOG_INTERVAL_MS) {
        logger.info('[AUDIO] Agent→Twilio', { callSid, chunksSent: openaiChunksSent, mulawBytes: mulaw.length });
        openaiChunksSent = 0;
        lastOpenaiLogAt = now;
      }
    };

    // Attaches live event handlers to an OpenAI WS (warm or cold).
    // Always strips existing listeners first to prevent prewarm handlers firing.
    // handoffSarvam/handoffChunker: if pickup happened mid-greeting-response, reuse the
    // prewarm Sarvam session & chunker so in-flight text deltas are not lost.
    const attachOpenAIHandlers = (
      ws: WebSocket,
      initialGreetingDone: boolean,
      initialAgentSpeaking: boolean,
      warmGreetingBytes = 0,
      handoffSarvam: ReturnType<typeof createSarvamStream> | null = null,
      handoffChunker: TextChunker | null = null,
    ) => {
      ws.removeAllListeners();
      openaiWs = ws;
      greetingDone = initialGreetingDone;
      agentSpeaking = initialAgentSpeaking;

      if (ws.readyState === WebSocket.OPEN) openaiReady = true;

      // agentSpeaking: extend timer each time a μ-law chunk arrives so mic stays
      // gated until audio finishes playing (+200ms safety margin).
      let speakingTimer: ReturnType<typeof setTimeout> | null = null;
      const markSpeakingFor = (mulawBytes: number) => {
        agentSpeaking = true;
        if (speakingTimer) clearTimeout(speakingTimer);
        const durationMs = Math.ceil((mulawBytes / 8000) * 1000) + 100;
        speakingTimer = setTimeout(() => { agentSpeaking = false; }, durationMs);
      };

      // If we flushed warm greeting audio just before this call, start the timer now.
      if (warmGreetingBytes > 0) markSpeakingFor(warmGreetingBytes);

      // One persistent Sarvam session per call, handed off from prewarm.
      // Between responses we only swap callbacks via setCallbacks(); the WS stays open.
      // On call end, destroy() closes the WS cleanly.
      const sarvam = handoffSarvam ?? null;
      callSarvam = sarvam;
      if (sarvam) {
        // Rewire audio chunks to go to Twilio now (prewarm routed via entry.liveFlush already).
        sarvam.setCallbacks(
          (mulaw) => { if (streamSid) { markSpeakingFor(mulaw.length); sendMulawToTwilio(mulaw); } },
          () => {
            if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null; }
            agentSpeaking = false;
            if (!greetingDone) {
              greetingDone = true;
              logger.info('Greeting done — mic open (Sarvam stream complete)', { callSid });
            }
            logger.info('[Sarvam] Response audio complete', { callSid });
          },
        );
        logger.info('[HANDOFF] Rewired prewarm Sarvam callbacks for live call', { callSid });
      }

      // Called at the start of each new response: update Sarvam callbacks for this response.
      const prepareSarvamForResponse = () => {
        sarvam?.setCallbacks(
          (mulaw) => { if (streamSid) { markSpeakingFor(mulaw.length); sendMulawToTwilio(mulaw); } },
          () => {
            if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null; }
            agentSpeaking = false;
            if (!greetingDone) {
              greetingDone = true;
              logger.info('Greeting done — mic open (Sarvam stream complete)', { callSid });
            }
            logger.info('[Sarvam] Response audio complete', { callSid });
          },
        );
      };

      // Chunker sends text to the persistent Sarvam session.
      // isSpeakable guards against sending pure JSON, Cyrillic, CJK, etc. that
      // would cause Sarvam to return a 422 and close the WebSocket.
      const chunker = isLic ? (handoffChunker ?? new TextChunker((text) => {
        if (isSpeakable(text)) {
          sarvam?.send(text);
        } else {
          logger.warn('[Sarvam][LIVE] Skipping non-speakable chunk', { preview: text.slice(0, 60) });
        }
      })) : null;

      ws.on('open', () => {
        logger.info('OpenAI Realtime WS open (cold path)', { callSid, isLic });
        openaiReady = true;
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi!' }] },
        }));
        ws.send(JSON.stringify(isLic ? buildGreetingResponse() : { type: 'response.create' }));
      });

      // Track whether the current response output item is a function_call so we
      // skip feeding its argument deltas (JSON) into the Sarvam TTS chunker.
      let isToolCallItem = false;

      // After a tool result we must trigger a follow-up response. If the response
      // that issued the tool call is still active, OpenAI rejects an immediate
      // response.create with `conversation_already_has_active_response` and drops
      // it silently — the call then hangs ("nothing after [TOOL] Done"). We set
      // this flag, send the response.create as soon as the active response ends.
      let pendingToolResponse = false;
      const triggerToolResponse = () => {
        pendingToolResponse = false;
        logger.info('[TOOL] Triggering follow-up response', { callSid });
        sendToOpenAI({ type: 'response.create' });
      };

      ws.on('message', (rawMsg: Buffer | string) => {
        try {
          const event = JSON.parse(rawMsg.toString());
          const NOISY = new Set(['response.audio.delta', 'response.output_audio.delta', 'input_audio_buffer.appended', 'response.output_text.delta']);
          if (!NOISY.has(event.type)) {
            logger.info('OpenAI event', { type: event.type, ...(event.error ? { error: event.error } : {}) });
          }

          if (event.type === 'response.created') {
            responseActive = true;
            responseCancelled = false;
            responseFlushed = false;
            isToolCallItem = false;
            if (isLic) {
              chunker?.reset();
              prepareSarvamForResponse();
            }
          }

          // Detect function_call output items so their JSON argument deltas are
          // not sent to Sarvam TTS. A single response can contain both a
          // function_call item AND a message item — set the flag per item so a
          // message item that follows a function_call is still spoken.
          if (event.type === 'response.output_item.added') {
            isToolCallItem = event.item?.type === 'function_call';
          }
          // When a text/message item completes, clear the flag so the NEXT item
          // (or the response.done flush) is not wrongly treated as a tool call.
          if (event.type === 'response.output_item.done' && event.item?.type !== 'function_call') {
            isToolCallItem = false;
          }

          if (event.type === 'input_audio_buffer.speech_started') {
            logger.info('[INTERRUPT] User speech detected', { callSid, responseActive, agentSpeaking, greetingDone });
            if (greetingDone) {
              // Hard-stop: cancel any in-flight response and clear Twilio audio immediately.
              // We do this whether or not responseActive — Sarvam may still be streaming audio
              // for a response that already completed from OpenAI's perspective.
              if (responseActive) {
                responseActive = false;
                responseCancelled = true;
                sendToOpenAI({ type: 'response.cancel' });
              }
              chunker?.cancel();
              if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null; }
              agentSpeaking = false;
              if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
              }
            }
          }

          if (event.type === 'response.done') {
            responseActive = false;
            if (!isLic) {
              agentSpeaking = false;
              if (!greetingDone) {
                greetingDone = true;
                logger.info('Greeting done — mic open for caller', { responseStatus: event.response?.status });
              }
            }
            // LIC: flush chunker then flush Sarvam so it synthesizes remaining text
            // and emits a "final" event. WS stays open for next response.
            // Guard with responseFlushed so a second response.done for the same
            // response (e.g. after a barge-in race) doesn't trigger a double-flush.
            if (isLic && chunker && !responseCancelled && !responseFlushed) {
              responseFlushed = true;
              chunker.flush();
              sarvam?.flush();
            }
            responseCancelled = false;

            // A tool result was queued during this response — now that it has
            // ended, it's safe to ask OpenAI for the follow-up response.
            if (pendingToolResponse) triggerToolResponse();
          }

          // ── LIC: text → Sarvam streaming TTS ───────────────────────────────
          // Skip text deltas that belong to function_call items (JSON args, not speech).
          // Also skip response.output_text.done whose full text is a JSON tool-call output.
          if (isLic && chunker && !isToolCallItem) {
            if (event.type === 'response.output_text.delta' && event.delta) {
              chunker.push(event.delta);
            }
            if (event.type === 'response.output_text.done') {
              // If the entire completed text is a JSON/tool-output blob, cancel rather than flush.
              const fullText: string = event.text ?? '';
              if (fullText && !isSpeakable(fullText)) {
                logger.warn('[Sarvam][LIVE] Dropping tool-output text from TTS', { preview: fullText.slice(0, 80) });
                chunker.cancel();
              } else {
                chunker.flush();
              }
            }
          }

          // ── Audio modality: PCM24 → μ-law → Twilio ──────────────────────────
          if (!isLic) {
            const audioPayload = event.type === 'response.output_audio.delta'
              ? (event.delta ?? event.audio)
              : event.type === 'response.audio.delta' ? event.delta : null;

            if (audioPayload && streamSid) {
              agentSpeaking = true;
              const pcm24 = Buffer.from(audioPayload, 'base64');
              const mulaw = pcm16ToMulaw(downsample24to8(pcm24));
              sendMulawToTwilio(mulaw);
            }
          }

          if (event.type === 'session.updated') {
            logger.info('Session updated', {
              modalities: event.session?.modalities,
              input_fmt: event.session?.input_audio_format,
            });
          }

          // ── Server-side tool call execution ────────────────────────────────
          // OpenAI Realtime emits response.function_call_arguments.done when a
          // tool call is complete. Forward to /api/tools so all agents' tools
          // run correctly on phone calls (browser mode runs execute() client-side).
          if (event.type === 'response.function_call_arguments.done') {
            const callId: string = event.call_id ?? '';
            const fnName: string = event.name ?? '';
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(event.arguments ?? '{}'); } catch { /* ignore */ }
            logger.info('[TOOL] Function call', { agentKey: activeAgentKey, fnName, callId, args });

            (async () => {
              let result: unknown = { success: true };
              try {
                const res = await fetch('https://bfsi.searchunify.com/bfsi-agentic-suite/api/tools', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ agentKey: activeAgentKey, toolName: fnName, args }),
                });
                result = res.ok ? await res.json() : { success: false, error: `Tool API returned ${res.status}` };
                logger.info('[TOOL] Done', { fnName, result });
              } catch (err: any) {
                logger.error('[TOOL] Execution error', { fnName, err: err.message });
                result = { success: false, error: err.message };
              }

              // Queue the tool result (adding a conversation item is always allowed,
              // even mid-response).
              sendToOpenAI({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output: JSON.stringify(result),
                },
              });
              // Only create the follow-up response once no response is active.
              // If the tool-call response is still streaming/finishing, defer to
              // response.done; otherwise fire immediately.
              if (responseActive) {
                pendingToolResponse = true;
                logger.info('[TOOL] Response still active — deferring follow-up', { callSid });
              } else {
                triggerToolResponse();
              }
            })();
          }

          if (
            event.type === 'conversation.item.input_audio_transcription.completed' ||
            event.type === 'response.audio_transcript.done' ||
            event.type === 'response.output_text.done'
          ) {
            logger.info('Transcript', { type: event.type, text: event.transcript ?? event.text });
            eventBroadcaster.broadcast({ type: 'transcript', callSid, event });
          }

          // LIC noise gate: if the user transcription contains no Hindi/Latin characters
          // it is hallucinated noise (Russian, Korean, Spanish, etc.). Cancel the response
          // that OpenAI already started so the agent doesn't react to phantom speech.
          if (isLic && event.type === 'conversation.item.input_audio_transcription.completed') {
            const text: string = event.transcript ?? '';
            if (!isValidHindiTranscript(text)) {
              logger.warn('[VAD] Noise transcript dropped — cancelling response', { text });
              if (responseActive) {
                responseActive = false;
                responseCancelled = true;
                sendToOpenAI({ type: 'response.cancel' });
                chunker?.cancel();
                if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null; }
                if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                  twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
                }
                agentSpeaking = false;
              }
            }
          }

          if (event.type === 'error') {
            // response_cancel_not_active is a benign race: speech_started fired at the
            // same instant response.done arrived, so the cancel reached OpenAI too late.
            if (event.error?.code === 'response_cancel_not_active') {
              logger.warn('OpenAI cancel race (benign)', { code: event.error.code });
            } else if (event.error?.code === 'conversation_already_has_active_response') {
              // Our follow-up response.create lost the race with an active response.
              // Re-queue it so the tool result still gets spoken once the active one ends.
              logger.warn('[TOOL] Follow-up hit active-response race — re-queuing', { callSid });
              pendingToolResponse = true;
            } else {
              logger.error('OpenAI error event', event.error);
            }
          }
        } catch (err) {
          logger.error('Failed to parse OpenAI message', err);
        }
      });

      ws.on('close', (code, reason) => {
        logger.info('OpenAI Realtime WS closed', { callSid, code, reason: reason.toString() });
        openaiReady = false;
      });

      ws.on('error', (err) => {
        logger.error('OpenAI Realtime WS error', { callSid, err: err.message });
      });
    };

    const connectToOpenAICold = async (agentKey: string) => {
      logger.info('Cold-connecting to OpenAI', { callSid, agentKey, isLic });
      try {
        const outputModalities = isLic ? ['text'] : ['audio'];

        let coldTools: unknown[] | undefined;
        try {
          const toolsRes = await fetch(`https://bfsi.searchunify.com/bfsi-agentic-suite/api/schemas?agentKey=${agentKey}`);
          if (toolsRes.ok) {
            const toolsData = await toolsRes.json();
            if (Array.isArray(toolsData.tools) && toolsData.tools.length > 0) coldTools = toolsData.tools;
          }
        } catch { /* proceed without tools */ }

        const sessionRes = await fetch('https://bfsi.searchunify.com/bfsi-agentic-suite/api/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentKey, output_modalities: outputModalities, ...(coldTools ? { tools: coldTools } : {}) }),
        });
        const sessionData = await sessionRes.json();
        if (!sessionData.client_secret?.value) {
          logger.error('No ephemeral key in session response', sessionData);
          twilioWs.close();
          return;
        }
        const ephemeralKey = sessionData.client_secret.value;
        const realtimeModel = sessionData.session?.model ?? 'gpt-realtime-1.5';
        const ws = new WebSocket(
          `wss://api.openai.com/v1/realtime?model=${realtimeModel}`,
          { headers: { Authorization: `Bearer ${ephemeralKey}` } }
        );
        attachOpenAIHandlers(ws, false, false);
      } catch (err: any) {
        logger.error('connectToOpenAICold threw', { message: err.message });
        twilioWs.close();
      }
    };

    const onCallEnd = () => {
      if (!callSid) return;
      const call = callManager.getCall(callSid);
      if (call && call.status !== 'completed') {
        callManager.updateCall(callSid, { status: 'completed' });
        numberLeaseManager.postCall();
        eventBroadcaster.broadcast({ type: 'call_ended', callSid });
        logger.info('Call ended, lease → post_call', { callSid });
        callSarvam?.destroy();
        callSarvam = null;

        // Mirror what browser mode does on disconnect: create a Zendesk ticket
        // with whatever state was collected. The tools route deduplicates via
        // zendesk_ticket_created, so this is a no-op if the agent already called
        // createZendeskTicket during the conversation.
        //
        // Only LIC and AAA fire an automatic end-of-call ticket; Kotak/Health
        // create tickets only when the agent itself calls createZendeskTicket
        // mid-conversation. Each handler expects a different args shape, so
        // buildCallEndTicketArgs returns the correct one per agentKey (LIC uses
        // lead_category/call_disposition; AAA uses subject + application_status).
        const AUTO_TICKET_AGENTS = new Set([LIC_AGENT_KEY, 'aaaInsurance']);
        if (AUTO_TICKET_AGENTS.has(activeAgentKey)) {
          const ticketArgs = buildCallEndTicketArgs(activeAgentKey);
          fetch('https://bfsi.searchunify.com/bfsi-agentic-suite/api/tools', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentKey: activeAgentKey,
              toolName: 'createZendeskTicket',
              args: ticketArgs,
            }),
          }).then(res => res.json()).then(result => {
            logger.info('[CALL END] Zendesk ticket result', { callSid, agentKey: activeAgentKey, result });
          }).catch(err => {
            logger.error('[CALL END] Zendesk ticket error', { callSid, err: err.message });
          });
        } else {
          logger.info('[CALL END] Skipping auto Zendesk ticket (non-LIC/AAA agent)', { callSid, agentKey: activeAgentKey });
        }
      }
    };

    twilioWs.on('message', (rawMsg: Buffer | string) => {
      try {
        const msg: TwilioMediaMessage = JSON.parse(rawMsg.toString());

        if (msg.event !== 'media') {
          logger.info('Twilio WS message', { event: msg.event, raw: rawMsg.toString().slice(0, 200) });
        }

        switch (msg.event) {
          case 'connected':
            logger.info('Twilio stream event: connected');
            break;

          case 'start': {
            streamSid = msg.start?.streamSid ?? null;
            const params = msg.start?.customParameters ?? {};
            callSid   = params.callSid ?? null;
            const agentKey = params.agentKey ?? 'aaaInsurance';
            isLic = agentKey === LIC_AGENT_KEY;
            activeAgentKey = agentKey;

            logger.info('Twilio stream started', { callSid, streamSid, agentKey, isLic });

            if (callSid) {
              callManager.addCall({ callSid, from: '', agentKey, startedAt: new Date(), status: 'in-progress' });
            }

            // Try warm path first
            const warm = callSid ? warmStore.get(callSid) : undefined;
            if (warm && warm.ws) {
              warmStore.delete(callSid!);
              logger.info('[PREWARM] Warm connection claimed', {
                callSid, wsReady: warm.ready,
                greetingDone: warm.greetingDone,
                bufferedChunks: warm.greetingBuffer.length,
                isLic: warm.isLic,
              });

              const sendChunked = (mulaw: Buffer) => {
                const CHUNK = 160;
                for (let off = 0; off < mulaw.length; off += CHUNK) {
                  twilioWs.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: mulaw.subarray(off, off + CHUNK).toString('base64') },
                  }));
                }
              };

              // Flush already-buffered greeting chunks.
              let totalGreetingBytes = 0;
              if (warm.greetingBuffer.length > 0 && streamSid && twilioWs.readyState === WebSocket.OPEN) {
                logger.info('[PREWARM] Flushing buffered greeting audio', { callSid, chunks: warm.greetingBuffer.length });
                for (const mulaw of warm.greetingBuffer) {
                  totalGreetingBytes += mulaw.length;
                  sendChunked(mulaw);
                }
              }

              // Wire liveFlush so any in-flight Sarvam TTS calls that finish after
              // pickup stream directly here instead of buffering into the deleted entry.
              if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                warm.liveFlush = (mulaw) => {
                  totalGreetingBytes += mulaw.length;
                  sendChunked(mulaw);
                };
              }

              isLic = warm.isLic;
              // Pass prewarm Sarvam/chunker so the live path continues any in-flight greeting response.
              attachOpenAIHandlers(warm.ws, warm.greetingDone, totalGreetingBytes > 0, totalGreetingBytes, warm.prewarmSarvam, warm.prewarmChunker);
              openaiReady = warm.ready;

              // If TTS wasn't done yet at pickup, open the mic once it drains.
              if (!warm.greetingDone) {
                warm.onGreetingDone = () => {
                  greetingDone = true;
                  logger.info('Mic opened — late TTS drain complete', { callSid });
                };
              }
            } else {
              if (warm && !warm.ws) {
                warmStore.delete(callSid!);
                logger.warn('[PREWARM] Warm entry had null WS — falling back to cold connect', { callSid });
              }
              connectToOpenAICold(agentKey);
            }
            break;
          }

          case 'media': {
            if (!msg.media?.payload) break;

            // In LIC mode, suppress mic while agent is speaking to prevent echo/noise.
            if (openaiReady && greetingDone && !agentSpeaking && openaiWs?.readyState === WebSocket.OPEN) {
              const mulaw = Buffer.from(msg.media.payload, 'base64');
              const pcm24 = upsample8to24(mulawToPcm16(mulaw));
              openaiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: pcm24.toString('base64'),
              }));
              twilioChunksReceived++;
              const now = Date.now();
              if (now - lastTwilioLogAt >= AUDIO_LOG_INTERVAL_MS) {
                logger.info('[AUDIO] Twilio→OpenAI (user speaking)', {
                  callSid, chunksReceivedSinceLastLog: twilioChunksReceived,
                  mulawBytes: mulaw.length, pcm24Bytes: pcm24.length,
                });
                twilioChunksReceived = 0;
                lastTwilioLogAt = now;
              }
            }
            break;
          }

          case 'stop':
            logger.info('Twilio stream stopped', { callSid });
            onCallEnd();
            openaiWs?.close();
            break;
        }
      } catch (err) {
        logger.error('Error handling Twilio message', err);
      }
    });

    twilioWs.on('close', () => {
      logger.info('Twilio WS closed', { callSid });
      openaiWs?.close();
      onCallEnd();
    });

    twilioWs.on('error', (err) => {
      logger.error('Twilio WS error', err);
    });
  });
}
