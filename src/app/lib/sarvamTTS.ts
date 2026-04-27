const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const OUTPUT_SAMPLE_RATE = 22050;

export interface SarvamTTSOptions {
  speaker?: string;
  language?: string;
  model?: string;
  pace?: number;
  enablePreprocessing?: boolean;
}

export interface SarvamSynthesisResult {
  audioBase64: string;
  mimeType: string;
  sampleRate: number;
}

export class SarvamTTS {
  private readonly apiKey: string;
  private readonly speaker: string;
  private readonly language: string;
  private readonly model: string;
  private readonly pace: number;
  private readonly enablePreprocessing: boolean;

  constructor(options: SarvamTTSOptions = {}) {
    this.apiKey = process.env.SARVAM_API_KEY || process.env.sarvam_key || '';
    if (!this.apiKey) {
      throw new Error('Sarvam API key not configured. Set SARVAM_API_KEY or sarvam_key.');
    }
    this.speaker = options.speaker ?? 'shubh';
    this.language = options.language ?? 'hi-IN';
    this.model = options.model ?? 'bulbul:v3';
    this.pace = options.pace ?? 1.1;
    this.enablePreprocessing = options.enablePreprocessing ?? true;
  }

  private buildPayload(text: string) {
    return {
      text,
      target_language_code: this.language,
      speaker: this.speaker,
      model: this.model,
      pace: this.pace,
      speech_sample_rate: OUTPUT_SAMPLE_RATE,
      output_audio_codec: 'mp3',
      enable_preprocessing: this.enablePreprocessing,
    };
  }

  private inferMimeType(contentType: string | null): string {
    const normalized = (contentType || '').toLowerCase();
    if (normalized.includes('audio/wav') || normalized.includes('audio/x-wav')) return 'audio/wav';
    if (normalized.includes('audio/ogg')) return 'audio/ogg';
    if (normalized.includes('audio/webm')) return 'audio/webm';
    return 'audio/mpeg';
  }

  private extractBase64FromJson(payload: any): string {
    const directCandidates = [
      payload?.audio,
      payload?.audio_base64,
      payload?.audioBase64,
      payload?.base64,
      payload?.data,
      payload?.result?.audio,
      payload?.result?.audio_base64,
      payload?.result?.audioBase64,
      payload?.outputs?.[0]?.audio,
      payload?.outputs?.[0]?.audio_base64,
      payload?.audios?.[0],
    ];

    for (const value of directCandidates) {
      if (typeof value === 'string' && value.trim()) {
        return value.replace(/^data:audio\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
      }
    }

    throw new Error('Sarvam JSON response did not contain audio data');
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<SarvamSynthesisResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      throw new Error('Empty text provided');
    }

    const response = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildPayload(cleanText)),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sarvam TTS failed (${response.status}): ${body}`);
    }

    const contentType = response.headers.get('content-type');
    let audioBase64 = '';
    let mimeType = this.inferMimeType(contentType);

    if ((contentType || '').toLowerCase().includes('application/json')) {
      const payload = await response.json();
      audioBase64 = this.extractBase64FromJson(payload);
      const jsonMimeType = payload?.mime_type || payload?.mimeType || payload?.format;
      if (typeof jsonMimeType === 'string' && jsonMimeType.trim()) {
        if (jsonMimeType.includes('/')) {
          mimeType = jsonMimeType;
        } else if (jsonMimeType.toLowerCase() === 'wav') {
          mimeType = 'audio/wav';
        } else if (jsonMimeType.toLowerCase() === 'ogg') {
          mimeType = 'audio/ogg';
        } else if (jsonMimeType.toLowerCase() === 'webm') {
          mimeType = 'audio/webm';
        } else {
          mimeType = 'audio/mpeg';
        }
      }
    } else {
      const audioBuffer = await response.arrayBuffer();
      audioBase64 = Buffer.from(audioBuffer).toString('base64');
    }

    return {
      audioBase64,
      mimeType,
      sampleRate: OUTPUT_SAMPLE_RATE,
    };
  }
}
