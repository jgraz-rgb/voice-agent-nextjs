'use client';
import { useRef, useCallback, useEffect } from 'react';

/**
 * useTTSAudioPlayer
 *
 * Receives base64-encoded PCM/MP3/Opus audio chunks from an external TTS
 * WebSocket and plays them with gapless, overlapped scheduling.
 *
 * Strategy
 * ────────
 * • Each chunk is decoded via AudioContext.decodeAudioData().
 * • Chunks are queued and scheduled back-to-back using a "clock" cursor that
 *   tracks the next available playback start time.
 * • We start a new source node slightly before the previous one finishes
 *   (OVERLAP_S seconds) so the hardware buffer is always full — eliminating
 *   audible gaps between chunks.
 * • If the queue drains faster than chunks arrive the cursor resets to
 *   AudioContext.currentTime so playback resumes immediately on the next chunk.
 */

const OVERLAP_S = 0.01; // 10 ms pre-schedule window — just enough to avoid gaps without rushing

// Telephony simulation: classic G.711 PSTN passband is 300–3400 Hz.
// We apply a highpass + lowpass biquad pair, a tiny noise floor, and a
// gentle compressor to mimic the characteristic "phone call" sound.
function buildTelephonyChain(ctx: AudioContext, destination: AudioNode): {
  input: AudioNode;
} {
  // Highpass at 300 Hz — cuts low-frequency rumble and warmth
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;
  hp.Q.value = 0.7;

  // Lowpass at 3400 Hz — cuts high-frequency air and brilliance
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3400;
  lp.Q.value = 0.7;

  // Gentle dynamic compression — phone circuits compress heavily
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.1;

  hp.connect(lp);
  lp.connect(comp);
  comp.connect(destination);

  return { input: hp };
}

export interface TTSAudioPlayerHandle {
  /** Feed a base64-encoded audio chunk received from the TTS WebSocket.
   *  onStart fires at the moment this chunk's audio begins playing. */
  enqueue: (base64Audio: string, mimeType?: string, sampleRate?: number, onStart?: () => void) => Promise<void>;
  /** Stop all playback immediately and clear the queue. */
  stop: () => void;
  /** Pause / resume playback (soft mute). */
  setMuted: (muted: boolean) => void;
}

export function useTTSAudioPlayer(): TTSAudioPlayerHandle {
  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef<number>(0);
  const activeNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const mutedRef = useRef(false);
  const gainRef = useRef<GainNode | null>(null);
  const telephonyInputRef = useRef<AudioNode | null>(null);

  // Lazily create (or resume) the AudioContext on first use.
  // sampleRate is passed so the context matches the TTS server output.
  const getCtx = useCallback((sampleRate = 8000): AudioContext => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate });
      const gain = ctx.createGain();
      gain.gain.value = mutedRef.current ? 0 : 1;
      gain.connect(ctx.destination);
      ctxRef.current = ctx;
      gainRef.current = gain;
      nextStartRef.current = 0;
      const { input } = buildTelephonyChain(ctx, gain);
      telephonyInputRef.current = input;
    }
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume().catch(() => {});
    }
    return ctxRef.current;
  }, []);

  const enqueue = useCallback(async (base64Audio: string, mimeType = 'audio/basic', sampleRate = 8000, onStart?: () => void) => {
    if (!base64Audio) return;

    // Decode base64 → ArrayBuffer
    let arrayBuffer: ArrayBuffer;
    try {
      const binary = atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      arrayBuffer = bytes.buffer;
    } catch (err) {
      console.warn('[TTSAudioPlayer] base64 decode failed:', err);
      return;
    }

    const ctx = getCtx(sampleRate);

    let audioBuffer: AudioBuffer;
    const isPCM = mimeType === 'audio/pcm' || mimeType === 'audio/raw';

    if (isPCM) {
      // Raw 16-bit little-endian signed PCM — decode manually, no browser parser needed
      try {
        const int16Array = new Int16Array(arrayBuffer);
        audioBuffer = ctx.createBuffer(1, int16Array.length, sampleRate);
        const float32Array = audioBuffer.getChannelData(0);
        for (let i = 0; i < int16Array.length; i++) {
          float32Array[i] = int16Array[i] / 32768.0;
        }
      } catch (pcmErr) {
        console.warn('[TTSAudioPlayer] PCM decode failed:', pcmErr);
        return;
      }
    } else {
      // MP3 / Opus / any browser-decodable format — use WebAudio decoder directly
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      } catch (err) {
        console.warn('[TTSAudioPlayer] decodeAudioData failed for', mimeType, ':', err);
        return;
      }
    }

    const now = ctx.currentTime;

    // If we're behind realtime (queue drained), snap forward so playback
    // is immediate rather than scheduling in the past.
    if (nextStartRef.current < now - OVERLAP_S) {
      nextStartRef.current = now;
    }

    const startAt = Math.max(nextStartRef.current, now);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    // Route through the telephony chain (bandpass + compressor + noise);
    // fall back to direct gain if the chain isn't set up yet.
    source.connect(telephonyInputRef.current ?? gainRef.current!);
    source.start(startAt);

    // Fire onStart at the exact moment this chunk begins playing.
    if (onStart) {
      const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
      setTimeout(onStart, delayMs);
    }

    // Track active nodes so we can stop them on demand.
    activeNodesRef.current.push(source);
    source.onended = () => {
      activeNodesRef.current = activeNodesRef.current.filter(n => n !== source);
    };

    // Advance the cursor — overlap by OVERLAP_S so the next chunk pre-fills
    // the hardware buffer before this one finishes.
    nextStartRef.current = startAt + audioBuffer.duration - OVERLAP_S;
  }, [getCtx]);

  const stop = useCallback(() => {
    activeNodesRef.current.forEach(n => {
      try { n.stop(); } catch { /* already stopped */ }
    });
    activeNodesRef.current = [];
    nextStartRef.current = 0;
    // Suspend the AudioContext so any chunk that slips through after stop()
    // cannot produce audible output until the next enqueue resumes it.
    if (ctxRef.current && ctxRef.current.state === 'running') {
      ctxRef.current.suspend().catch(() => {});
    }
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    if (gainRef.current) {
      gainRef.current.gain.setTargetAtTime(muted ? 0 : 1, gainRef.current.context.currentTime, 0.015);
    }
  }, []);

  // Clean up AudioContext when unmounted.
  useEffect(() => {
    return () => {
      activeNodesRef.current.forEach(n => { try { n.stop(); } catch { /* noop */ } });
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  return { enqueue, stop, setMuted };
}
