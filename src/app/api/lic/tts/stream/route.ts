import { NextRequest } from 'next/server';
import { SarvamAIClient } from 'sarvamai';

type SarvamSocket = Awaited<ReturnType<InstanceType<typeof SarvamAIClient>['textToSpeechStreaming']['connect']>>;

const SAMPLE_RATE = 22050;
const SOCKET_IDLE_TIMEOUT_MS = 60_000; // close socket after 60 s of no requests

// ── Warm-socket singleton ─────────────────────────────────────────────────────
// A single WebSocket connection is kept alive across requests so subsequent
// chunks pay only the config+convert round-trip, not the WS handshake.
//
// Requests are serialised through `socketQueue` — one convert/flush cycle at a
// time — because the SDK socket exposes a single `message` handler and cannot
// demultiplex concurrent requests.

let warmSocket: SarvamSocket | null = null;
let connectPromise: Promise<SarvamSocket> | null = null;
let socketQueue: Promise<void> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    try { warmSocket?.close(); } catch { /* noop */ }
    warmSocket = null;
    connectPromise = null;
    idleTimer = null;
  }, SOCKET_IDLE_TIMEOUT_MS);
}

async function getWarmSocket(apiKey: string): Promise<SarvamSocket> {
  // Return existing open socket immediately
  if (warmSocket && warmSocket.readyState === 1 /* OPEN */) {
    resetIdleTimer();
    return warmSocket;
  }

  // If a connect is already in progress, reuse it
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    const socket = await client.textToSpeechStreaming.connect({
      model: 'bulbul:v3' as any,
      send_completion_event: 'true',
      'Api-Subscription-Key': apiKey,
    });

    await socket.waitForOpen();

    socket.on('close', () => {
      warmSocket = null;
      connectPromise = null;
    });
    socket.on('error', () => {
      try { socket.close(); } catch { /* noop */ }
      warmSocket = null;
      connectPromise = null;
    });

    warmSocket = socket;
    connectPromise = null;
    resetIdleTimer();
    return socket;
  })();

  return connectPromise;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();
  const text = String(body?.text ?? '').trim();
  if (!text) {
    return new Response(JSON.stringify({ error: 'Text is required' }), { status: 400 });
  }

  const apiKey = process.env.SARVAM_API_KEY || process.env.sarvam_key || '';
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Sarvam API key not configured' }), { status: 500 });
  }

  const speaker  = body?.speaker  ?? 'ratan';
  const language = body?.language ?? 'hi-IN';
  const pace     = body?.pace     ?? 1.1;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = (data: object) => {
    const line = `data: ${JSON.stringify(data)}\n\n`;
    writer.write(encoder.encode(line)).catch(() => {});
  };

  // Each request is appended to the serial queue so only one convert/flush
  // cycle runs on the warm socket at a time.
  const prevQueue = socketQueue;
  let resolveSlot!: () => void;
  socketQueue = new Promise<void>((res) => { resolveSlot = res; });

  (async () => {
    // Wait for the previous request to finish before touching the socket
    await prevQueue;

    if (req.signal.aborted) {
      resolveSlot();
      writer.close().catch(() => {});
      return;
    }

    let socket: SarvamSocket;
    try {
      socket = await getWarmSocket(apiKey);
    } catch (err: any) {
      sendEvent({ type: 'error', message: err?.message ?? 'Failed to connect to Sarvam' });
      writer.close().catch(() => {});
      resolveSlot();
      return;
    }

    // Guard: if client disconnected while waiting in queue, bail out
    if (req.signal.aborted) {
      resolveSlot();
      writer.close().catch(() => {});
      return;
    }

    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      // Restore a no-op handler so stray messages don't leak into the next request
      socket.on('message', () => {});
      resolveSlot();      // release queue slot for the next request
      writer.close().catch(() => {});
    };

    socket.on('message', (message: any) => {
      if (message.type === 'audio') {
        sendEvent({ type: 'audio', audio: message.data.audio });
      } else if (
        message.type === 'completed' ||
        (message.type === 'event' && message.data?.event_type === 'final')
      ) {
        sendEvent({ type: 'done' });
        finish();
      } else if (message.type === 'error') {
        sendEvent({ type: 'error', message: message.data?.message ?? 'TTS error' });
        finish();
      }
    });

    // If the socket dies mid-request, fail gracefully and invalidate singleton
    socket.on('close', () => {
      if (!done) {
        sendEvent({ type: 'error', message: 'Sarvam socket closed unexpectedly' });
        warmSocket = null;
        connectPromise = null;
        finish();
      }
    });

    // Send config + text for this request
    try {
      socket.configureConnection({
        type: 'config',
        data: {
          speaker: speaker as any,
          target_language_code: language as any,
          pace,
          speech_sample_rate: SAMPLE_RATE,
          output_audio_codec: 'mp3',
          enable_preprocessing: true,
        },
      });
      socket.convert(text);
      socket.flush();
    } catch (err: any) {
      // Socket may have closed between the OPEN check and now — reconnect next time
      warmSocket = null;
      connectPromise = null;
      sendEvent({ type: 'error', message: err?.message ?? 'Failed to send to Sarvam' });
      finish();
      return;
    }

    // Safety timeout — release queue slot if Sarvam never sends 'completed'
    const timeout = setTimeout(() => {
      if (!done) {
        sendEvent({ type: 'error', message: 'Sarvam TTS timeout' });
        finish();
      }
    }, 15_000);

    // Clean up timeout when the stream closes
    writer.closed.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

    // Abort when client disconnects
    req.signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      finish();
    });
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
