import { NextRequest } from 'next/server';
import { SarvamAIClient } from 'sarvamai';

const SAMPLE_RATE = 22050;

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

  const speaker = body?.speaker ?? 'ratan';
  const language = body?.language ?? 'hi-IN';
  const model = body?.model ?? 'bulbul:v3';
  const pace = body?.pace ?? 1.1;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendEvent = (data: object) => {
    const line = `data: ${JSON.stringify(data)}\n\n`;
    writer.write(encoder.encode(line)).catch(() => {});
  };

  (async () => {
    const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
    let socket: Awaited<ReturnType<typeof client.textToSpeechStreaming.connect>> | null = null;

    try {
      socket = await client.textToSpeechStreaming.connect({
        model: model as any,
        'Api-Subscription-Key': apiKey,
        send_completion_event: 'true',
      });

      socket.on('open', () => {
        socket!.configureConnection({
          type: 'config',
          data: {
            model: model as any,
            speaker: speaker as any,
            target_language_code: language as any,
            pace,
            speech_sample_rate: SAMPLE_RATE,
            output_audio_codec: 'mp3',
            enable_preprocessing: true,
          },
        });
        socket!.convert(text);
        socket!.flush();
      });

      socket.on('message', (message: any) => {
        if (message.type === 'audio') {
          sendEvent({ type: 'audio', audio: message.data.audio });
        } else if (
          message.type === 'completed' ||
          (message.type === 'event' && message.data?.event_type === 'final')
        ) {
          sendEvent({ type: 'done' });
          socket!.close();
        }
      });

      socket.on('error', (err: Error) => {
        sendEvent({ type: 'error', message: err.message });
        writer.close().catch(() => {});
      });

      socket.on('close', () => {
        writer.close().catch(() => {});
      });

      await socket.waitForOpen();

      // Guard: close after 15 s if not completed
      const timeout = setTimeout(() => {
        try { socket?.close(); } catch { /* noop */ }
        writer.close().catch(() => {});
      }, 15_000);

      // Clean up timeout when writer closes (normal or error path)
      writer.closed.then(() => clearTimeout(timeout)).catch(() => clearTimeout(timeout));

      // Abort when client disconnects
      req.signal.addEventListener('abort', () => {
        try { socket?.close(); } catch { /* noop */ }
        writer.close().catch(() => {});
        clearTimeout(timeout);
      });
    } catch (err: any) {
      sendEvent({ type: 'error', message: err?.message ?? 'TTS streaming failed' });
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
