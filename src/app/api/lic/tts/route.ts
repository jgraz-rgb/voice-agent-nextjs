import { NextRequest, NextResponse } from 'next/server';
import { SarvamTTS } from '../../../lib/sarvamTTS';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = String(body?.text ?? '').trim();
    if (!text) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    const tts = new SarvamTTS({
      speaker: body?.speaker,
      language: body?.language,
      model: body?.model,
      pace: body?.pace,
      enablePreprocessing: body?.enablePreprocessing,
    });

    const result = await tts.synthesize(text, req.signal);
    return NextResponse.json(result);
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return NextResponse.json({ error: 'Request aborted' }, { status: 499 });
    }
    return NextResponse.json(
      { error: error?.message || 'Failed to synthesize audio' },
      { status: 500 },
    );
  }
}
