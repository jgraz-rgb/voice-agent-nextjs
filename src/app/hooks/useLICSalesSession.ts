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

const LIC_TTS_STREAM_URL = '/bfsi-agentic-suite/api/lic/tts/stream';
// ── TTS chunking thresholds ────────────────────────────────────────────────
// Chunks are flushed at sentence boundaries (।?!) first, then at clause
// boundaries (,.;:) only when the chunk is long enough that splitting there
// sounds natural rather than abrupt.
const TTS_SENTENCE_MIN_CHARS = 60;   // flush at ।?! once this length is reached
const TTS_CLAUSE_MIN_CHARS   = 100;  // flush at ,.;: only after this length
const TTS_FORCE_FLUSH_CHARS  = 180;  // hard cap — flush wherever we are
const TTS_SENTENCE_BOUNDARY_REGEX = /[।?!]/;
const TTS_CLAUSE_BOUNDARY_REGEX   = /[,.;:]/;
const MIC_VAD_THRESHOLD = 0.4;
const MIC_PREFIX_PADDING_MS = 300;
const MIC_SILENCE_DURATION_MS = 600;

// Filler phrases grouped by conversational tier.
// Tier is selected based on how many turns have elapsed so the fillers feel
// natural as the conversation warms up.
const FILLER_CATEGORIES = {
  // Turns 1-2: non-committal thinking sounds — safe opener for any topic
  thinking: [
    ",",
    "…",
    "एक सेकंड…",
    "… एक सेकंड…",
    "उम्… हाँ, एक सेकंड…",
    "हम्म्म… ज़रा सोचता हूँ…",
  ],
  // Turns 3-5: warm acknowledgement — signals the agent is listening
  acknowledgement: [
    "जी…",
    "जी जी…",
    "हाँ जी…",
    "अच्छा जी…",
    "ठीक है जी…",
    "हम्म, जी…",
    "जी… मतलब…",
    "जी बिल्कुल, एक सेकंड…",
    "हाँ जी, समझ गया…",
    "अच्छा जी, ठीक है…",
  ],
  // Turns 6+: sales-flow starters — feel natural once rapport is established
  salesFlow: [
    "तो देखिए…",
    "अब बात ये है…",
    "दरअसल…",
    "असल में…",
    "मैं आपको बताता हूँ…",
    "अच्छा… तो देखिए…",
    "जी जी… देखिए…",
    "हम्म… जी…",
    "अच्छा जी…",
    "जी, तो इस बारे में…",
    "हाँ जी, तो देखिए ना…",
    "बिल्कुल जी, मैं बताता हूँ…",
  ],
} as const;

type FillerCategory = keyof typeof FILLER_CATEGORIES;

// Category weights per tier [thinking, acknowledgement, salesFlow].
// Each sub-array sums to 1.0 and maps to FILLER_CATEGORY_ORDER.
const FILLER_CATEGORY_ORDER: FillerCategory[] = ['thinking', 'acknowledgement', 'salesFlow'];
const FILLER_WEIGHTS: Record<string, number[]> = {
  early:  [0.70, 0.25, 0.05], // turns 1-2
  mid:    [0.20, 0.60, 0.20], // turns 3-5
  mature: [0.10, 0.30, 0.60], // turns 6+
};

function getFillerTier(turnCount: number): keyof typeof FILLER_WEIGHTS {
  if (turnCount <= 2) return 'early';
  if (turnCount <= 5) return 'mid';
  return 'mature';
}

function weightedPickCategory(tier: keyof typeof FILLER_WEIGHTS): FillerCategory {
  const weights = FILLER_WEIGHTS[tier];
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) return FILLER_CATEGORY_ORDER[i];
  }
  return FILLER_CATEGORY_ORDER[FILLER_CATEGORY_ORDER.length - 1];
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Normalise text before sending to TTS:
 * - "LIC" → "एल आई सी" so the Hindi TTS pronounces it as three letters
 *   rather than the word "lic".
 * - Strip markdown bold/italic markers that would be spoken literally.
 */
function normaliseTTSText(text: string): string {
  return text
    // ── Abbreviation pronunciation ──────────────────────────────────────────
    .replace(/\bLICHFL\b/g, 'एल आई सी एच एफ एल')
    .replace(/\bLIC\b/g, 'एल आई सी')

    // ── Markdown formatting ─────────────────────────────────────────────────
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')   // bold+italic ***text***
    .replace(/\*\*(.+?)\*\*/g, '$1')        // bold **text**
    .replace(/\*(.+?)\*/g, '$1')            // italic *text*
    .replace(/_{2}(.+?)_{2}/g, '$1')        // __underline__
    .replace(/_(.+?)_/g, '$1')              // _italic_
    .replace(/~~(.+?)~~/g, '$1')            // ~~strikethrough~~
    .replace(/`{3}[\s\S]*?`{3}/g, '')       // ```code blocks```
    .replace(/`([^`]+)`/g, '$1')            // `inline code`
    .replace(/#{1,6}\s*/g, '')              // ## headings
    .replace(/^\s*[-*+]\s+/gm, '')         // - bullet points
    .replace(/^\s*\d+\.\s+/gm, '')         // 1. numbered lists
    .replace(/^\s*>\s*/gm, '')              // > blockquotes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [link text](url) → link text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // ![alt](img) → alt text
    .replace(/\|/g, ' ')                    // table pipe characters

    // ── Whitespace and escape sequences ─────────────────────────────────────
    .replace(/\\n/g, ' ')                   // literal \n escape sequences
    .replace(/\\t/g, ' ')                   // literal \t escape sequences
    .replace(/\r\n|\r|\n/g, ' ')            // all real newline variants
    .replace(/\t/g, ' ')                    // real tabs

    // ── Punctuation noise ────────────────────────────────────────────────────
    .replace(/\s*---+\s*/g, ', ')           // --- horizontal rules → pause
    .replace(/\s*===+\s*/g, ' ')            // === dividers
    .replace(/[<>{}[\]\\^~]/g, ' ')        // stray bracket/symbol noise
    .replace(/\.{3,}/g, '...')              // normalize excessive ellipsis

    // ── Collapse whitespace ──────────────────────────────────────────────────
    .replace(/ {2,}/g, ' ')
    .trim();
}

function mergeDeltaWithoutOverlap(existing: string, delta: string): string {
  if (!delta) return existing;
  if (!existing) return delta;

  const maxOverlap = Math.min(existing.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existing.slice(-overlap) === delta.slice(0, overlap)) {
      return existing + delta.slice(overlap);
    }
  }
  return existing + delta;
}

function getIncrementalChunk(candidate: string, alreadySent: string): string {
  if (!candidate) return '';
  if (!alreadySent) return candidate;
  if (candidate.startsWith(alreadySent)) return candidate.slice(alreadySent.length);

  const maxOverlap = Math.min(candidate.length, alreadySent.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (alreadySent.slice(-overlap) === candidate.slice(0, overlap)) {
      return candidate.slice(overlap);
    }
  }
  return candidate;
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
  /** No audioElement needed — output comes from Sarvam TTS, not OpenAI audio */
  extraContext?: Record<string, any>;
  outputGuardrails?: any[];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useLICSalesSession
 *
 * Like useRealtimeSession but wired for TEXT-only output from the Realtime API.
 * Completed text responses are sent to the LIC internal TTS endpoint, which
 * proxies Sarvam and returns base64 MP3 audio for playback via useTTSAudioPlayer.
 *
 * Session modality is forced to ["text"] via session.update immediately after
 * connect so OpenAI never synthesises audio — saving bandwidth and latency.
 */
export function useLICSalesSession(callbacks: LICSalesSessionCallbacks = {}) {
  const sessionRef = useRef<RealtimeSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>('DISCONNECTED');

  const { logClientEvent, logServerEvent } = useEvent();
  const historyHandlersRef = useHandleSessionHistory();
  const { enqueue: enqueueAudio, stop: stopAudio, setMuted } = useTTSAudioPlayer();

  // Tracks whether we're currently accumulating a text response
  const responseTextRef = useRef('');
  const finalTranscriptRef = useRef('');
  const currentItemIdRef = useRef<string | null>(null);
  const pendingChunkRef = useRef('');
  // Set to true once the full response text has been written to the transcript
  // (by handleTranscriptionCompleted or handleHistoryUpdated). After that,
  // onStart callbacks must NOT append more text or they'll duplicate it.
  const transcriptFinalizedRef = useRef(false);
  const agentSpeakingRef = useRef(false);
  const inFlightControllersRef = useRef<Set<AbortController>>(new Set());
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());

  /**
   * Generation counter — incremented every time a new response begins.
   * If generation changes (new response or interrupt), any stale in-flight TTS
   * request response is ignored so old audio does not bleed into the next turn.
   */
  const generationRef = useRef<number>(0);
  const disconnectedRef = useRef<boolean>(false);
  const userSpeechStopTimeRef = useRef<number | null>(null);
  const firstAudioPlayedRef = useRef<boolean>(false);
  // Filler audio — incremented when the filler should be cancelled
  const fillerGenerationRef = useRef<number>(0);
  // True once a filler has been enqueued for the current user turn so we
  // don't double-enqueue if speech_stopped fires more than once.
  const fillerPlayedThisTurnRef = useRef<boolean>(false);
  // Tracks completed user turns so filler tier advances as conversation warms up
  const turnCountRef = useRef<number>(0);
  // Per-category shuffle queues — refilled when exhausted so phrases never repeat
  const fillerQueuesRef = useRef<Record<FillerCategory, string[]>>({
    thinking: [],
    acknowledgement: [],
    salesFlow: [],
  });
  // True once the first real TTS chunk has been enqueued for the current turn.
  // Used by the filler gate to skip the filler if audio arrived within 1.5 s.
  const firstChunkArrivedRef = useRef<boolean>(false);
  // Handle for the 1.5 s filler-gate timer so it can be cleared on interrupt.
  const fillerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Status helper ──────────────────────────────────────────────────────────

  const updateStatus = useCallback(
    (s: SessionStatus) => {
      setStatus(s);
      callbacks.onConnectionChange?.(s);
      logClientEvent({}, s);
    },
    [callbacks],
  );

  const queueSarvamChunk = useCallback(
    (text: string, generation: number, itemId: string | null) => {
      const cleaned = normaliseTTSText(text).trim();
      if (!cleaned) return;

      // Capture the raw text this chunk covers so we can reveal it in the
      // transcript exactly when its audio starts playing.
      const chunkRawText = text;
      const chunkItemId = itemId;

      // ── Sequential fetch + enqueue ───────────────────────────────────────────
      // Both the fetch AND the enqueue are chained on ttsQueueRef so segment N
      // never starts fetching until segment N-1 has fully enqueued its audio.
      // This guarantees transcript order and eliminates the race where a faster
      // synthesis for a later chunk would get scheduled before an earlier one.
      const controller = new AbortController();
      inFlightControllersRef.current.add(controller);

      const prev = ttsQueueRef.current;
      ttsQueueRef.current = prev.then(async () => {
        if (generation !== generationRef.current || disconnectedRef.current) {
          inFlightControllersRef.current.delete(controller);
          return;
        }

        const revealText = () => {
          if (chunkItemId && chunkRawText && !transcriptFinalizedRef.current) {
            historyHandlersRef.current.handleTranscriptionDelta({
              item_id: chunkItemId,
              delta: chunkRawText,
            });
          }
        };

        try {
          const response = await fetch(LIC_TTS_STREAM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleaned }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            const body = await response.text().catch(() => '');
            throw new Error(`LIC TTS stream failed (${response.status}): ${body}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          const audioChunks: string[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (generation !== generationRef.current || disconnectedRef.current) break;

            if (!done) {
              buf += decoder.decode(value, { stream: true });
            }

            const lines = buf.split('\n');
            buf = done ? '' : (lines.pop() ?? '');

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              let event: any;
              try { event = JSON.parse(line.slice(6)); } catch { continue; }

              if (event.type === 'audio' && event.audio) {
                audioChunks.push(event.audio);
              } else if (event.type === 'error') {
                console.error('[LICSales TTS] stream error:', event.message);
              }
            }

            if (done) break;
          }

          if (audioChunks.length > 0 && generation === generationRef.current && !disconnectedRef.current) {
            if (!firstAudioPlayedRef.current && userSpeechStopTimeRef.current !== null) {
              firstAudioPlayedRef.current = true;
              const elapsed = ((performance.now() - userSpeechStopTimeRef.current) / 1000).toFixed(2);
              console.log(`[LICSales] First audio chunk ready: ${elapsed}s after user stopped speaking`);
            }
            // Each SSE audio chunk is independently padded base64 — decode each to
            // bytes, concatenate, then re-encode as one valid base64 string.
            const binaryParts = audioChunks.map(b64 => atob(b64));
            const totalLen = binaryParts.reduce((s, p) => s + p.length, 0);
            const bytes = new Uint8Array(totalLen);
            let offset = 0;
            for (const part of binaryParts) {
              for (let i = 0; i < part.length; i++) bytes[offset++] = part.charCodeAt(i);
            }
            let binaryStr = '';
            for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
            const combined = btoa(binaryStr);
            try {
              await enqueueAudio(combined, 'audio/mpeg', 22050, revealText);
            } catch {
              revealText();
            }
            if (!agentSpeakingRef.current) {
              agentSpeakingRef.current = true;
              callbacks.onAgentSpeakingChange?.(true);
            }
          }
        } catch (error: any) {
          if (error?.name !== 'AbortError') {
            console.error('[LICSales TTS] stream error:', error);
          }
          // Reveal text so transcript isn't stuck on failure
          revealText();
        } finally {
          inFlightControllersRef.current.delete(controller);
        }
      });
    },
    [callbacks, enqueueAudio, historyHandlersRef],
  );

  const flushPendingChunk = useCallback(
    (generation: number, itemId: string | null, force = false) => {
      const current = pendingChunkRef.current;
      if (!current) return;
      const trimmed = current.trim();
      if (!trimmed) {
        pendingChunkRef.current = '';
        return;
      }
      const boundaryChar = current[current.length - 1];
      const atSentenceBoundary = TTS_SENTENCE_BOUNDARY_REGEX.test(boundaryChar);
      const atClauseBoundary   = TTS_CLAUSE_BOUNDARY_REGEX.test(boundaryChar);
      const shouldFlush =
        force ||
        // Prefer flushing at full sentence endings (।?!) with a lower length bar
        (trimmed.length >= TTS_SENTENCE_MIN_CHARS && atSentenceBoundary) ||
        // Only split at clause boundaries (,.;:) once the chunk is long enough
        // that the cut sounds natural rather than mid-thought
        (trimmed.length >= TTS_CLAUSE_MIN_CHARS && atClauseBoundary) ||
        // Hard cap — flush wherever we are to prevent unbounded buffering
        trimmed.length >= TTS_FORCE_FLUSH_CHARS;
      if (!shouldFlush) return;

      pendingChunkRef.current = '';
      queueSarvamChunk(trimmed, generation, itemId);
    },
    [queueSarvamChunk],
  );

  const resetTTSState = useCallback((isDisconnect = false) => {
    if (fillerTimerRef.current !== null) {
      clearTimeout(fillerTimerRef.current);
      fillerTimerRef.current = null;
    }
    firstChunkArrivedRef.current = false;
    inFlightControllersRef.current.forEach(c => c.abort());
    inFlightControllersRef.current.clear();
    pendingChunkRef.current = '';
    transcriptFinalizedRef.current = true; // block any stale onStart appends
    // Drain the queue so no pending promise can enqueue more audio after reset
    ttsQueueRef.current = Promise.resolve();
    if (isDisconnect) {
      disconnectedRef.current = true;
    }
    if (agentSpeakingRef.current) {
      agentSpeakingRef.current = false;
      callbacks.onAgentSpeakingChange?.(false);
    }
  }, [callbacks]);

  // ── Filler audio ──────────────────────────────────────────────────────────
  // Called 1.5 s after speech_stopped (via setTimeout gate). If the first real
  // TTS chunk has already arrived by then (gap < 1.5 s) the filler is skipped.
  // Otherwise the filler plays to completion and the real TTS chunk — which may
  // arrive while the filler is still speaking — is automatically queued behind
  // it on ttsQueueRef, so playback is seamless with no mid-word cutoff.
  const playFillerAudio = useCallback(() => {
    if (disconnectedRef.current) return;
    // Skip if the real response already started within the 1.5 s window
    if (firstChunkArrivedRef.current) return;

    fillerPlayedThisTurnRef.current = true;
    turnCountRef.current += 1;
    const myFillerGen = fillerGenerationRef.current;

    const tier = getFillerTier(turnCountRef.current);
    const category = weightedPickCategory(tier);
    const queues = fillerQueuesRef.current;
    if (queues[category].length === 0) {
      queues[category] = shuffleArray([...FILLER_CATEGORIES[category]]);
    }
    const phrase = queues[category].pop()!;
    const cleaned = normaliseTTSText(phrase).trim();
    if (!cleaned) return;

    const controller = new AbortController();
    inFlightControllersRef.current.add(controller);

    // Chain onto ttsQueueRef so the filler occupies the same playback slot as
    // real TTS chunks — the real first chunk will schedule immediately after.
    const prev = ttsQueueRef.current;
    ttsQueueRef.current = prev.then(async () => {
      if (myFillerGen !== fillerGenerationRef.current || disconnectedRef.current) {
        inFlightControllersRef.current.delete(controller);
        return;
      }
      try {
        const response = await fetch(LIC_TTS_STREAM_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleaned }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const audioChunks: string[] = [];

        while (true) {
          const { done, value } = await reader.read();
          if (myFillerGen !== fillerGenerationRef.current || disconnectedRef.current) break;
          if (!done) buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = done ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            let ev: any;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.type === 'audio' && ev.audio) audioChunks.push(ev.audio);
          }
          if (done) break;
        }

        if (audioChunks.length === 0) return;
        if (myFillerGen !== fillerGenerationRef.current || disconnectedRef.current) return;

        const binaryParts = audioChunks.map(b64 => atob(b64));
        const totalLen = binaryParts.reduce((s, p) => s + p.length, 0);
        const bytes = new Uint8Array(totalLen);
        let offset = 0;
        for (const part of binaryParts) {
          for (let i = 0; i < part.length; i++) bytes[offset++] = part.charCodeAt(i);
        }
        let binaryStr = '';
        for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
        const combined = btoa(binaryStr);

        if (myFillerGen !== fillerGenerationRef.current || disconnectedRef.current) return;

        await enqueueAudio(combined, 'audio/mpeg', 22050);
        if (!agentSpeakingRef.current) {
          agentSpeakingRef.current = true;
          callbacks.onAgentSpeakingChange?.(true);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.warn('[LICSales filler] TTS error:', err);
        }
      } finally {
        inFlightControllersRef.current.delete(controller);
      }
    });
  }, [callbacks, enqueueAudio]);

  // ── Transport event handler ────────────────────────────────────────────────

  function handleTransportEvent(event: any) {
    switch (event.type) {
      // ── User speech transcription ────────────────────────────────────────
      case 'conversation.item.input_audio_transcription.completed': {
        historyHandlersRef.current.handleTranscriptionCompleted(event);
        break;
      }

      case 'input_audio_buffer.speech_started': {
        userSpeechStopTimeRef.current = null;
        firstAudioPlayedRef.current = false;
        firstChunkArrivedRef.current = false;
        fillerPlayedThisTurnRef.current = false;
        // Clear any pending filler gate timer from the previous turn
        if (fillerTimerRef.current !== null) {
          clearTimeout(fillerTimerRef.current);
          fillerTimerRef.current = null;
        }
        // Cancel any in-flight or queued filler from the previous turn
        fillerGenerationRef.current += 1;
        if (agentSpeakingRef.current) {
          console.log('[LICSales] User speech detected while agent speaking — interrupting stream');
          generationRef.current += 1;
          resetTTSState();
          stopAudio();
          sessionRef.current?.interrupt();
        }
        break;
      }

      case 'input_audio_buffer.speech_stopped': {
        userSpeechStopTimeRef.current = performance.now();
        firstChunkArrivedRef.current = false;
        // Gate: wait 1.5 s before deciding to play a filler.
        // • If the real TTS chunk arrives within 1.5 s, playFillerAudio() will
        //   see firstChunkArrivedRef=true and bail out immediately (no filler).
        // • If the gap is 1.5–3 s, the filler plays to completion; the real
        //   chunk is queued behind it on ttsQueueRef and plays right after.
        // • Beyond 3 s the filler has long finished before the chunk arrives.
        if (!fillerPlayedThisTurnRef.current && !disconnectedRef.current) {
          fillerTimerRef.current = setTimeout(() => {
            fillerTimerRef.current = null;
            if (!fillerPlayedThisTurnRef.current && !disconnectedRef.current) {
              playFillerAudio();
            }
          }, 1500);
        }
        break;
      }

      // ── Agent text output (TEXT modality) ────────────────────────────────
      case 'response.text.delta': {
        const delta: string = event.delta ?? '';
        if (responseTextRef.current === '') {
          // Mark that real TTS content has arrived so the filler gate can skip
          // the filler if its 1.5 s timer hasn't fired yet.
          firstChunkArrivedRef.current = true;
          // Cancel the filler gate timer — real audio is coming, no filler needed.
          if (fillerTimerRef.current !== null) {
            clearTimeout(fillerTimerRef.current);
            fillerTimerRef.current = null;
          }
          // Only cancel a filler that hasn't started playing yet. If the filler
          // is already playing (fillerPlayedThisTurnRef=true) we let it finish —
          // the real TTS chunk will follow it naturally via ttsQueueRef.
          if (!fillerPlayedThisTurnRef.current) {
            fillerGenerationRef.current += 1;
          }
          // New response starting — bump generation so any audio from a previous
          // response is discarded, but do NOT abort in-flight controllers or stop
          // audio here. resetTTSState() was already called by the interrupt path
          // if needed; calling it here would abort this very response's first fetch.
          generationRef.current += 1;
          transcriptFinalizedRef.current = false;
        }
        responseTextRef.current = mergeDeltaWithoutOverlap(responseTextRef.current, delta);
        // Do NOT push to transcript here — transcript text is revealed in sync
        // with audio via the onStart callback in queueSarvamChunk.
        pendingChunkRef.current += delta;
        currentItemIdRef.current = event.item_id;
        flushPendingChunk(generationRef.current, currentItemIdRef.current, false);
        break;
      }

      case 'response.text.done': {
        finalTranscriptRef.current = event.text ?? responseTextRef.current;
        const generation = generationRef.current;
        const itemId = currentItemIdRef.current;
        // Flush any remaining buffered text as the final TTS chunk.
        flushPendingChunk(generation, itemId, true);
        // Defer handleTranscriptionCompleted until after all audio chunks have
        // played — append it to the end of the TTS queue so it fires in order.
        if (itemId) {
          const finalText = finalTranscriptRef.current;
          const capturedItemId = itemId;
          const prev = ttsQueueRef.current;
          ttsQueueRef.current = (async () => {
            await prev;
            if (generation !== generationRef.current || disconnectedRef.current) return;
            transcriptFinalizedRef.current = true;
            historyHandlersRef.current.handleTranscriptionCompleted({
              item_id: capturedItemId,
              transcript: finalText,
            });
          })();
          currentItemIdRef.current = null;
        }
        responseTextRef.current = '';
        break;
      }

      // ── Response lifecycle (used to track speaking state) ─────────────────
      case 'response.completed':
      case 'response.done': {
        // Keep speaking=true while queued chunks are still being played.
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
      // If the SDK writes the full assistant text via history_updated, mark
      // the transcript as finalized so deferred onStart callbacks don't
      // append duplicate text on top of what's already showing.
      const hasAssistantText = items.some(
        (i: any) => i?.role === 'assistant' && Array.isArray(i.content) && i.content.some((c: any) => c.text || c.transcript)
      );
      if (hasAssistantText) {
        transcriptFinalizedRef.current = true;
      }
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

      // Clear the disconnect guard so TTS can play again on reconnect
      disconnectedRef.current = false;

      updateStatus('CONNECTING');

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
            language: 'hi',
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
            threshold: MIC_VAD_THRESHOLD, // higher = less sensitive, reduces false triggers from noise
            prefix_padding_ms: MIC_PREFIX_PADDING_MS,
            silence_duration_ms: MIC_SILENCE_DURATION_MS,
            create_response: true,
          },
        },
      } as any);

      updateStatus('CONNECTED');
    },
    [callbacks, updateStatus, registerEventHandlers],
  );

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    resetTTSState(true); // sets disconnectedRef = true, aborts in-flight fetches, drains queue
    stopAudio();
    sessionRef.current?.close();
    sessionRef.current = null;
    updateStatus('DISCONNECTED');
  }, [updateStatus, stopAudio, resetTTSState]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const assertConnected = () => {
    if (!sessionRef.current) throw new Error('LICSalesSession not connected');
  };

  const interrupt = useCallback(() => {
    // Always safe to do locally — stop audio and clear buffers regardless of
    // transport state so we never block on a disconnected WebRTC channel.
    generationRef.current += 1;
    resetTTSState();
    stopAudio();
    // Only forward interrupt to the session if the transport is actually open.
    // Calling session.interrupt() on a closed/disconnected channel throws:
    // "WebRTC data channel is not connected".
    if (sessionRef.current && status === 'CONNECTED') {
      try { sessionRef.current.interrupt(); } catch { /* transport already closed */ }
    }
  }, [stopAudio, status, resetTTSState]);

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
