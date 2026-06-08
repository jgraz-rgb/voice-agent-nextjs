import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const SARVAM_WSS_URL = 'wss://api.sarvam.ai/text-to-speech/ws';
const SAMPLE_RATE = 8000;
// Send an empty-text ping every 20 s to keep the WS alive between responses.
const KEEPALIVE_INTERVAL_MS = 20_000;

// ── Persistent Sarvam TTS session (one per call) ──────────────────────────────
// The WebSocket stays open for the lifetime of the call. Between responses we
// send periodic empty-text pings so the server doesn't close the idle socket.
// Each response is delimited by flush(); the server emits a "final" event when
// it has finished streaming audio for that flush.

export interface SarvamStreamSession {
  /** Send a text chunk for the current response. */
  send(text: string): void;
  /** Signal end-of-response; Sarvam will emit a "final" event after all audio. */
  flush(): void;
  /** Replace the per-response callbacks (call at the start of each new response). */
  setCallbacks(onAudio: (mulaw: Buffer) => void, onDone: () => void): void;
  /** Hard-close the WS (call only when the phone call ends). */
  destroy(): void;
}

// Characters Sarvam's hi-IN model accepts: Devanagari, Latin (A-Z, a-z),
// digits, and common punctuation. Reject text that contains none of these
// so we never send pure CJK/Cyrillic/etc. that causes a 422 and kills the WS.
const SPEAKABLE_RE = /[ऀ-ॿa-zA-Z0-9]/;

export function isSpeakable(text: string): boolean {
  const t = text.trim();
  // Reject JSON objects/arrays (tool call outputs leaked as text)
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return false; } catch { /* not valid JSON, fall through */ }
  }
  return SPEAKABLE_RE.test(t);
}

// ── LIC transcript noise gate ─────────────────────────────────────────────────
// On phone calls with background noise, gpt-4o-transcribe hallucinates short
// foreign-language phrases or very short Latin words ("Hello", "Yes", "Hi",
// "Kingdom.") for silence/ambient sound. We reject a transcript if:
//  1. It contains no Devanagari (Hindi script) AND
//  2. Its Latin-only word count is ≤ 2 (short noise bursts)
// This keeps real English words mid-Hindi conversation ("Yes, I want home loan")
// while dropping isolated one/two-word Latin hallucinations.
const DEVANAGARI_RE = /[ऀ-ॿ]/;
const WORD_RE       = /\S+/g;

export function isValidHindiTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Has Devanagari → always valid
  if (DEVANAGARI_RE.test(trimmed)) return true;
  // Latin-only: require at least 3 words to trust it as real speech
  const wordCount = (trimmed.match(WORD_RE) ?? []).length;
  return wordCount >= 3;
}

export function createSarvamStream(
  onAudio: (mulaw: Buffer) => void,
  onDone: () => void,
  onError?: (err: Error) => void,
): SarvamStreamSession {
  const apiKey = process.env.SARVAM_API_KEY || '';
  if (!apiKey) {
    logger.error('[Sarvam] SARVAM_API_KEY not set');
    return { send: () => {}, flush: () => {}, setCallbacks: () => {}, destroy: () => {} };
  }

  let configSent = false;
  let pendingText: string[] = [];
  let pendingFlush = false;
  let destroyed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let currentOnAudio = onAudio;
  let currentOnDone  = onDone;
  let activeWs: WebSocket | null = null;

  const openWs = (): WebSocket => {
    const ws = new WebSocket(
      `${SARVAM_WSS_URL}?model=bulbul:v3&send_completion_event=true`,
      [`api-subscription-key.${apiKey}`],
    );
    activeWs = ws;

    ws.on('open', () => {
      logger.info('[Sarvam] WS open');
      configSent = false;
      sendConfig(ws);
    });

    ws.on('message', (raw: Buffer | string) => {
      if (destroyed) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'audio' || msg.type === 'AudioOutput') {
          const b64: string = msg.data?.audio ?? msg.audio ?? '';
          if (b64) currentOnAudio(Buffer.from(b64, 'base64'));
        } else if (msg.type === 'event' || msg.type === 'EventResponse') {
          const eventType: string = msg.data?.event_type ?? msg.event_type ?? '';
          logger.info('[Sarvam] WS event', { eventType });
          if (eventType === 'final') {
            logger.info('[Sarvam] Response done (final)');
            currentOnDone();
          }
        } else if (msg.type === 'error') {
          const errCode: number = msg.data?.code ?? 0;
          logger.error('[Sarvam] Stream error', { msg });
          // 422 = bad language in text; reconnect so future responses work.
          // Don't call onError — the call is still alive, just skip this response.
          if (errCode === 422) {
            logger.warn('[Sarvam] Language 422 — reconnecting WS, skipping current response');
            pendingText = [];
            pendingFlush = false;
            configSent = false;
            // onDone so the call doesn't hang waiting for audio that will never come.
            currentOnDone();
          } else {
            onError?.(new Error(JSON.stringify(msg)));
          }
        } else {
          logger.info('[Sarvam] Unknown WS message', { raw: raw.toString().slice(0, 120) });
        }
      } catch (e: any) {
        logger.warn('[Sarvam] Failed to parse WS message', { err: e.message });
      }
    });

    ws.on('error', (err) => {
      logger.error('[Sarvam] WS error', { err: err.message });
      onError?.(err);
    });

    ws.on('close', (code) => {
      logger.info('[Sarvam] WS closed', { code });
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      configSent = false;
      // Auto-reconnect on unexpected close (not triggered by destroy()).
      if (!destroyed) {
        logger.info('[Sarvam] Unexpected close — reconnecting');
        openWs();
      }
    });

    return ws;
  };

  const sendConfig = (ws: WebSocket) => {
    const sendRaw = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    sendRaw({
      type: 'config',
      data: {
        target_language_code: 'hi-IN',
        speaker: 'ratan',
        pace: 1.1,
        pitch: 0.0,
        loudness: 1.0,
        speech_sample_rate: SAMPLE_RATE,
        enable_preprocessing: true,
        output_audio_codec: 'mulaw',
        min_buffer_size: 50,
        max_chunk_length: 200,
      },
    });
    configSent = true;

    logger.info('[Sarvam] WS ready, draining pending', { count: pendingText.length, pendingFlush });
    for (const t of pendingText) sendRaw({ type: 'text', data: { text: t } });
    pendingText = [];
    if (pendingFlush) {
      sendRaw({ type: 'flush' });
      pendingFlush = false;
    }

    keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        logger.info('[Sarvam] keepalive ping');
        ws.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  openWs();

  return {
    send(text: string) {
      if (destroyed) return;
      const ws = activeWs;
      logger.info('[Sarvam] send()', { chars: text.length, preview: text.slice(0, 60), wsState: ws?.readyState, configSent });
      if (!configSent || ws?.readyState !== WebSocket.OPEN) {
        pendingText.push(text);
        logger.info('[Sarvam] queued (WS not ready)', { pending: pendingText.length });
        return;
      }
      ws.send(JSON.stringify({ type: 'text', data: { text } }));
    },

    flush() {
      if (destroyed) return;
      const ws = activeWs;
      logger.info('[Sarvam] flush()');
      if (!configSent || ws?.readyState !== WebSocket.OPEN) {
        pendingFlush = true;
        return;
      }
      ws.send(JSON.stringify({ type: 'flush' }));
    },

    setCallbacks(newOnAudio: (mulaw: Buffer) => void, newOnDone: () => void) {
      currentOnAudio = newOnAudio;
      currentOnDone  = newOnDone;
      logger.info('[Sarvam] callbacks updated for new response');
    },

    destroy() {
      destroyed = true;
      if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
      const ws = activeWs;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000);
      }
      logger.info('[Sarvam] session destroyed');
    },
  };
}

// ── μ-law encoding ────────────────────────────────────────────────────────────
const MULAW_MAX  = 0x1FFF;
const MULAW_BIAS = 33;

export function pcm16ToMulaw(src: Buffer): Buffer {
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

// ── Text chunking ─────────────────────────────────────────────────────────────
const SENTENCE_MIN = 15;
const CLAUSE_MIN   = 40;
const FORCE_FLUSH  = 80;
const SENTENCE_RE  = /[।?!.]/;
const CLAUSE_RE    = /[,;:.]/;

export class TextChunker {
  private buf = '';
  private readonly onChunk: (text: string) => void;
  private cancelled = false;

  queue: Promise<void> = Promise.resolve();

  constructor(onChunk: (text: string) => void) {
    this.onChunk = onChunk;
  }

  push(delta: string) {
    this.buf += delta;
    this.maybeFlush(false);
  }

  flush() {
    this.maybeFlush(true);
  }

  cancel() {
    this.cancelled = true;
    this.buf = '';
  }

  reset() {
    this.cancelled = false;
    this.buf = '';
  }

  private maybeFlush(force: boolean) {
    const t = this.buf.trim();
    if (!t) return;
    const last = this.buf[this.buf.length - 1];
    const atSentence = SENTENCE_RE.test(last);
    const atClause   = CLAUSE_RE.test(last);
    const should =
      force ||
      (t.length >= SENTENCE_MIN && atSentence) ||
      (t.length >= CLAUSE_MIN   && atClause)   ||
      t.length >= FORCE_FLUSH;

    if (should) {
      this.buf = '';
      if (!this.cancelled) this.onChunk(t);
    }
  }
}
