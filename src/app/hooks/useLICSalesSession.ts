'use client';
import { useCallback, useRef, useState } from 'react';
import {
  RealtimeSession,
  RealtimeAgent,
  OpenAIRealtimeWebRTC,
} from '@openai/agents/realtime';

import { applyCodecPreferences } from '../lib/codecUtils';
import { useEvent } from '../contexts/EventContext';
import { useHandleSessionHistory } from './useHandleSessionHistory';
import { useTTSAudioPlayer } from './useTTSAudioPlayer';
import { SessionStatus } from '../types';

// ─── Configuration ────────────────────────────────────────────────────────────

/** External TTS WebSocket endpoint */
// const TTS_WS_URL = 'ws://59.144.102.130:7007/audio/tts-stream';
const TTS_WS_URL = 'ws://192.168.0.92:7007/audio/tts-stream';
/**
 * Minimum number of characters to buffer before sending a chunk to TTS.
 * We only flush mid-stream at a word boundary (space/punctuation) once this
 * threshold is exceeded, so TTS always receives meaningful phrases rather than
 * individual characters — eliminating synthesis pauses between micro-chunks.
 */
const TTS_CHUNK_MIN_CHARS = 40;

/**
 * Normalise text before sending to TTS:
 * - "LIC" → "एल आई सी" so the Hindi TTS pronounces it as three letters
 *   rather than the word "lic".
 * - Strip markdown bold/italic markers that would be spoken literally.
 */
function normaliseTTSText(text: string): string {
  return text
    .replace(/\bLIC\b/g, 'एल आई सी')
    .replace(/\bLICHFL\b/g, 'एल आई सी एच एफ एल')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LICSalesSessionCallbacks {
  onConnectionChange?: (status: SessionStatus) => void;
  onAgentHandoff?: (agentName: string) => void;
  onAgentSpeakingChange?: (speaking: boolean) => void;
}

export interface LICSalesConnectOptions {
  getEphemeralKey: () => Promise<string>;
  initialAgents: RealtimeAgent[];
  /** No audioElement needed — output comes from TTS WS, not OpenAI audio */
  extraContext?: Record<string, any>;
  outputGuardrails?: any[];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useLICSalesSession
 *
 * Like useRealtimeSession but wired for TEXT-only output from the Realtime API.
 * Text deltas are forwarded to an external TTS WebSocket at TTS_WS_URL.
 * The WS responds with base64 audio chunks which are played via useTTSAudioPlayer
 * with overlap-scheduled, gapless playback.
 *
 * Session modality is forced to ["text"] via session.update immediately after
 * connect so OpenAI never synthesises audio — saving bandwidth and latency.
 */
export function useLICSalesSession(callbacks: LICSalesSessionCallbacks = {}) {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<SessionStatus>('DISCONNECTED');

  const { logClientEvent, logServerEvent } = useEvent();
  const historyHandlersRef = useHandleSessionHistory();
  const { enqueue: enqueueAudio, stop: stopAudio, setMuted } = useTTSAudioPlayer();

  // Tracks whether we're currently accumulating a text response
  const responseTextRef = useRef('');
  const finalTranscriptRef = useRef('');
  const currentItemIdRef = useRef<string | null>(null);
  const lastAppendedSentenceRef = useRef('');
  const agentSpeakingRef = useRef(false);

  // Buffer for text deltas that arrive before the WS is OPEN
  const pendingTextRef = useRef<string>('');

  // Accumulation buffer — holds deltas until a word boundary + min-size threshold
  // is reached, so TTS always gets meaningful phrases rather than 1-3 char chunks.
  const chunkBufferRef = useRef<string>('');

  /**
   * Generation counter — incremented every time a new response begins.
   * Audio chunks arriving from the TTS server carry the generation they were
   * synthesised for. If the generation has already moved on (new response
   * started or an interrupt occurred), stale audio chunks are discarded,
   * preventing audio from response N bleeding into response N+1.
   */
  const generationRef = useRef<number>(0);

  // ── Status helper ──────────────────────────────────────────────────────────

  const updateStatus = useCallback(
    (s: SessionStatus) => {
      setStatus(s);
      callbacks.onConnectionChange?.(s);
      logClientEvent({}, s);
    },
    [callbacks],
  );

  // ── TTS WebSocket ──────────────────────────────────────────────────────────

  const openTTSSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState < WebSocket.CLOSING) return;

    const ws = new WebSocket(TTS_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[LICSales TTS] WebSocket connected to', TTS_WS_URL);
      // Flush any text that arrived while the WS was still connecting
      const pending = normaliseTTSText(pendingTextRef.current);
      pendingTextRef.current = '';
      if (pending) {
        console.log('[LICSales TTS] flushing buffered text on open:', JSON.stringify(pending));
        ws.send(JSON.stringify({ text: pending }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          audio_base64?: string;
          sample_rate?: number;
          mime_type?: string;   // 'audio/mpeg' for MP3, 'audio/pcm' for raw PCM
          format?: string;      // alternate key some servers use ('mp3' | 'pcm')
          sentence?: string;
          done?: boolean;
          error?: string;
        };

        if (msg.error) {
          console.error('[LICSales TTS] Server error:', msg.error);
          return;
        }

        // Discard audio that belongs to a cancelled/superseded response.
        // The server echoes back the generation tag we sent with the text.
        const msgGeneration: number | undefined = (msg as any).generation;
        const isStale = msgGeneration !== undefined && msgGeneration !== generationRef.current;

        if (msg.audio_base64) {
          if (isStale) {
            console.log('[LICSales TTS] discarding stale audio chunk (gen', msgGeneration, ', current', generationRef.current, ')');
          } else {
            const mimeType = msg.format === 'pcm' ? 'audio/pcm' : 'audio/mpeg';
            console.log('[LICSales TTS] audio chunk received, sentence:', msg.sentence, '| sample_rate:', msg.sample_rate, '| format:', msg.format);
            enqueueAudio(msg.audio_base64, mimeType, msg.sample_rate || 22050);

            if (!agentSpeakingRef.current) {
              agentSpeakingRef.current = true;
              callbacks.onAgentSpeakingChange?.(true);
            }

            if (msg.sentence && msg.sentence !== lastAppendedSentenceRef.current && currentItemIdRef.current) {
              const deltaText = lastAppendedSentenceRef.current ? " " + msg.sentence : msg.sentence;
              historyHandlersRef.current.handleTranscriptionDelta({
                item_id: currentItemIdRef.current,
                delta: deltaText,
              });
              lastAppendedSentenceRef.current = msg.sentence;
            }
          }
        }

        if (msg.done && !isStale) {
          console.log('[LICSales TTS] stream done (gen', msgGeneration, ')');
          agentSpeakingRef.current = false;
          callbacks.onAgentSpeakingChange?.(false);

          if (currentItemIdRef.current) {
            historyHandlersRef.current.handleTranscriptionCompleted({
              item_id: currentItemIdRef.current,
              transcript: finalTranscriptRef.current,
            });
            currentItemIdRef.current = null;
          }
        }
      } catch {
        // Non-JSON frame — ignore
      }
    };

    ws.onerror = (err) => {
      console.error('[LICSales TTS] WebSocket error:', err);
    };

    ws.onclose = (ev) => {
      console.log('[LICSales TTS] WebSocket closed:', ev.code, ev.reason);
      wsRef.current = null;
      // Auto-reconnect after a short delay so the TTS socket stays alive
      setTimeout(() => {
        if (wsRef.current === null) {
          console.log('[LICSales TTS] Auto-reconnecting WebSocket...');
          openTTSSocket();
        }
      }, 1000);
    };
  }, [enqueueAudio, callbacks]);

  /** Flush the chunk buffer to the TTS WS immediately (internal helper) */
  const flushChunkBuffer = useCallback((generation: number) => {
    if (!chunkBufferRef.current) return;
    const normalised = normaliseTTSText(chunkBufferRef.current);
    chunkBufferRef.current = '';
    if (!normalised) return;

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      pendingTextRef.current += normalised;
      return;
    }
    const toSend = pendingTextRef.current + normalised;
    pendingTextRef.current = '';
    console.log('[LICSales TTS] sending chunk (gen', generation, '):', JSON.stringify(toSend));
    wsRef.current.send(JSON.stringify({ text: toSend, generation }));
  }, []);

  /** Send a text chunk to the TTS WS for synthesis */
  const sendTextToTTS = useCallback((text: string, isFinal: boolean) => {
    const generation = generationRef.current;

    if (isFinal) {
      // Flush any remaining chunk buffer first, then tell TTS server to flush
      flushChunkBuffer(generation);
      chunkBufferRef.current = '';
      pendingTextRef.current = '';
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        console.log('[LICSales TTS] sending flush (gen', generation, ')');
        wsRef.current.send(JSON.stringify({ flush: true, generation }));
      }
      return;
    }

    if (!text) return;

    // Accumulate into chunk buffer
    chunkBufferRef.current += text;

    // Only dispatch once we have enough text AND we're at a natural word/phrase
    // boundary — space, punctuation, or Devanagari phrase-end characters.
    // This ensures TTS receives meaningful phrases, not 1-3 char micro-chunks.
    const buf = chunkBufferRef.current;
    const lastChar = buf[buf.length - 1];
    const atBoundary = /[\s,।?!;:\-]/.test(lastChar);

    if (buf.length >= TTS_CHUNK_MIN_CHARS && atBoundary) {
      flushChunkBuffer(generation);
    }
  }, [flushChunkBuffer]);

  const closeTTSSocket = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  // ── Transport event handler ────────────────────────────────────────────────

  function handleTransportEvent(event: any) {
    switch (event.type) {
      // ── User speech transcription ────────────────────────────────────────
      case 'conversation.item.input_audio_transcription.completed': {
        historyHandlersRef.current.handleTranscriptionCompleted(event);
        break;
      }

      case 'input_audio_buffer.speech_started': {
        if (agentSpeakingRef.current) {
          console.log('[LICSales] User speech detected while agent speaking — interrupting stream');
          generationRef.current += 1;
          stopAudio();
          agentSpeakingRef.current = false;
          chunkBufferRef.current = '';
          pendingTextRef.current = '';
          callbacks.onAgentSpeakingChange?.(false);
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ cancel: true }));
          }
          sessionRef.current?.interrupt();
        }
        break;
      }

      // ── Agent text output (TEXT modality) ────────────────────────────────
      case 'response.text.delta': {
        const delta: string = event.delta ?? '';
        if (responseTextRef.current === '') {
          // First delta of a new response — bump generation so any audio still
          // arriving from the previous response is discarded client-side, and
          // send cancel to the TTS server so it aborts in-progress synthesis.
          generationRef.current += 1;
          lastAppendedSentenceRef.current = '';
          chunkBufferRef.current = '';
          pendingTextRef.current = '';
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            console.log('[LICSales TTS] new response — sending cancel (gen', generationRef.current, ')');
            wsRef.current.send(JSON.stringify({ cancel: true }));
          }
          stopAudio();
        }
        responseTextRef.current += delta;
        currentItemIdRef.current = event.item_id;
        console.log('[LIC text.delta] delta:', JSON.stringify(delta), '| accumulated so far:', JSON.stringify(responseTextRef.current));
        
        // Stream each delta immediately to TTS for low-latency synthesis
        sendTextToTTS(delta, false);
        break;
      }

      case 'response.text.done': {
        console.log('[LIC text.done] event.text:', JSON.stringify(event.text), '| accumulated:', JSON.stringify(responseTextRef.current));
        
        finalTranscriptRef.current = event.text ?? responseTextRef.current;
        
        // Send final marker so TTS knows the utterance is complete
        sendTextToTTS(responseTextRef.current, true);
        responseTextRef.current = '';
        break;
      }

      // ── Response lifecycle (used to track speaking state) ─────────────────
      case 'response.completed':
      case 'response.done': {
        // Speaking state is managed by TTS WS audio_done messages.
        // If no TTS WS, fall back to marking done here.
        if (agentSpeakingRef.current && !wsRef.current) {
          agentSpeakingRef.current = false;
          callbacks.onAgentSpeakingChange?.(false);
        }
        break;
      }

      default: {
        logServerEvent(event);
        break;
      }
    }
  }

  // ── Codec preference ──────────────────────────────────────────────────────

  const codecParamRef = useRef<string>(
    (typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('codec') ?? 'opus')
      : 'opus'
    ).toLowerCase(),
  );

  const applyCodec = useCallback(
    (pc: RTCPeerConnection) => applyCodecPreferences(pc, codecParamRef.current),
    [],
  );

  // ── Event handler registration ─────────────────────────────────────────────

  const handleAgentHandoff = (item: any) => {
    const history = item.context.history;
    const lastMessage = history[history.length - 1];
    const agentName = lastMessage.name.split('transfer_to_')[1];
    callbacks.onAgentHandoff?.(agentName);
  };

  const registerEventHandlers = useCallback((session: RealtimeSession) => {
    session.on('error', (...args: any[]) => {
      logServerEvent({ type: 'error', message: args[0] });
    });
    session.on('agent_handoff', handleAgentHandoff);
    session.on('agent_tool_start', (details: any, agent: any, functionCall: any) => {
      historyHandlersRef.current.handleAgentToolStart(details, agent, functionCall);
    });
    session.on('agent_tool_end', (details: any, agent: any, functionCall: any, result: any) => {
      historyHandlersRef.current.handleAgentToolEnd(details, agent, functionCall, result);
    });
    session.on('history_updated', (items: any[]) => {
      historyHandlersRef.current.handleHistoryUpdated(items);
    });
    session.on('history_added', (item: any) => {
      historyHandlersRef.current.handleHistoryAdded(item);
    });
    session.on('guardrail_tripped', (details: any, agent: any, guardrail: any) => {
      historyHandlersRef.current.handleGuardrailTripped(details, agent, guardrail);
    });
    session.on('transport_event', handleTransportEvent);
  }, [historyHandlersRef]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback(
    async ({
      getEphemeralKey,
      initialAgents,
      extraContext,
      outputGuardrails,
    }: LICSalesConnectOptions) => {
      if (sessionRef.current) return;

      updateStatus('CONNECTING');

      // Open TTS WebSocket before session so it's ready for first text delta
      openTTSSocket();

      const ek = await getEphemeralKey();
      const rootAgent = initialAgents[0];

      // We pass a silent audio element to satisfy the SDK — no audio comes
      // from OpenAI because we set modalities=["text"] in session.update.
      const silentAudio =
        typeof window !== 'undefined'
          ? (() => {
              const el = document.createElement('audio');
              el.autoplay = false;
              el.muted = true;
              return el;
            })()
          : undefined;

      const session = new RealtimeSession(rootAgent, {
        transport: new OpenAIRealtimeWebRTC({
          audioElement: silentAudio,
          changePeerConnection: async (pc: RTCPeerConnection) => {
            applyCodec(pc);
            return pc;
          },
        }),
        model: process.env.NEXT_PUBLIC_REALTIME_MODEL || 'gpt-realtime',
        config: {
          // Input audio transcription still needed so we can hear the user
          inputAudioTranscription: {
            model: 'gpt-4o-transcribe',
            language: 'en',
          },
        },
        outputGuardrails: outputGuardrails ?? [],
        context: extraContext ?? {},
      });

      registerEventHandlers(session);
      sessionRef.current = session;

      await session.connect({ apiKey: ek });

      // ── Force text-only output modality ──────────────────────────────────
      // This tells OpenAI NOT to synthesise audio — we handle TTS externally.
      session.transport.sendEvent({
        type: 'session.update',
        session: {
          modalities: ['text'],        // text only — no audio output from OpenAI
          turn_detection: {
            type: 'server_vad',
            threshold: 0.95,      // higher = less sensitive, won't trigger on background noise
            prefix_padding_ms: 500, // more padding before speech is confirmed
            silence_duration_ms: 800, // wait longer after silence before cutting the turn
            create_response: true,
          },
        },
      } as any);

      updateStatus('CONNECTED');
    },
    [callbacks, updateStatus, registerEventHandlers, openTTSSocket],
  );

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    stopAudio();
    closeTTSSocket();
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus('DISCONNECTED');
  }, [updateStatus, stopAudio, closeTTSSocket]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const assertConnected = () => {
    if (!sessionRef.current) throw new Error('LICSalesSession not connected');
  };

  const interrupt = useCallback(() => {
    // Always safe to do locally — stop audio and clear buffers regardless of
    // transport state so we never block on a disconnected WebRTC channel.
    generationRef.current += 1;
    stopAudio();
    chunkBufferRef.current = '';
    pendingTextRef.current = '';
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ cancel: true }));
    }
    // Only forward interrupt to the session if the transport is actually open.
    // Calling session.interrupt() on a closed/disconnected channel throws:
    // "WebRTC data channel is not connected".
    if (sessionRef.current && status === 'CONNECTED') {
      try { sessionRef.current.interrupt(); } catch { /* transport already closed */ }
    }
  }, [stopAudio, status]);

  const sendUserText = useCallback((text: string) => {
    assertConnected();
    sessionRef.current!.sendMessage(text);
  }, []);

  const sendEvent = useCallback((ev: any) => {
    sessionRef.current?.transport.sendEvent(ev);
  }, []);

  const mute = useCallback((m: boolean) => {
    sessionRef.current?.mute(m);   // mutes microphone input
    setMuted(m);                    // also mute TTS playback
  }, [setMuted]);

  return {
    status,
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    mute,
    interrupt,
  } as const;
}
