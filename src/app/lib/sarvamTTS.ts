import fs from 'fs';
import path from 'path';
import { SarvamAIClient } from 'sarvamai';

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const OUTPUT_SAMPLE_RATE = 8000;
const DICT_JSON_PATH = path.join(process.cwd(), 'src/app/lib/sarvamDict.json');

export interface SarvamTTSOptions {
  speaker?: string;
  language?: string;
  model?: string;
  pace?: number;
  temperature?: number;
  enablePreprocessing?: boolean;
}

export interface SarvamSynthesisResult {
  audioBase64: string;
  mimeType: string;
  sampleRate: number;
}

// Module-level cache so the dictionary is uploaded at most once per process.
let cachedDictId: string | null = null;
let dictUploadPromise: Promise<string | null> | null = null;

async function getOrUploadDictionary(apiKey: string): Promise<string | null> {
  if (cachedDictId) return cachedDictId;
  if (dictUploadPromise) return dictUploadPromise;

  dictUploadPromise = (async () => {
    try {
      const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });
      const result = await client.pronunciationDictionary.create({
        file: fs.createReadStream(DICT_JSON_PATH),
      });
      cachedDictId = result.dictionary_id ?? null;
      return cachedDictId;
    } catch (err) {
      console.error('[SarvamTTS] Failed to upload pronunciation dictionary:', err);
      dictUploadPromise = null;
      return null;
    }
  })();

  return dictUploadPromise;
}

export class SarvamTTS {
  private readonly apiKey: string;
  private readonly speaker: string;
  private readonly language: string;
  private readonly model: string;
  private readonly pace: number;
  private readonly temperature?: number;
  private readonly enablePreprocessing: boolean;

  constructor(options: SarvamTTSOptions = {}) {
    this.apiKey = process.env.SARVAM_API_KEY || process.env.sarvam_key || '';
    if (!this.apiKey) {
      throw new Error('Sarvam API key not configured. Set SARVAM_API_KEY or sarvam_key.');
    }
    this.speaker = options.speaker ?? 'ratan';
    this.language = options.language ?? 'hi-IN';
    this.model = options.model ?? 'bulbul:v3';
    this.pace = options.pace ?? 1.1;
    this.temperature = options.temperature ?? 0.3;
    this.enablePreprocessing = options.enablePreprocessing ?? true;
  }

  private buildPayload(text: string, dictId: string | null) {
    const payload: Record<string, unknown> = {
      text,
      target_language_code: this.language,
      speaker: this.speaker,
      model: this.model,
      pace: this.pace,
      temparature: this.temperature,
      speech_sample_rate: OUTPUT_SAMPLE_RATE,
      output_audio_codec: 'mulaw',
      enable_preprocessing: this.enablePreprocessing,
    };
    if (dictId) payload.dict_id = dictId;
    return payload;
  }

  private inferMimeType(contentType: string | null): string {
    const normalized = (contentType || '').toLowerCase();
    if (normalized.includes('audio/wav') || normalized.includes('audio/x-wav')) return 'audio/wav';
    if (normalized.includes('audio/ogg')) return 'audio/ogg';
    if (normalized.includes('audio/webm')) return 'audio/webm';
    if (normalized.includes('audio/basic') || normalized.includes('audio/pcm') || normalized.includes('mulaw')) return 'audio/basic';
    return 'audio/basic';
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

    const dictId = await getOrUploadDictionary(this.apiKey);

    const response = await fetch(SARVAM_TTS_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildPayload(cleanText, dictId)),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sarvam TTS failed (${response.status}): ${body}`);
    }

    const contentType = response.headers.get('content-type');
    console.log(`[SarvamTTS] response content-type: "${contentType}" | requested codec: mulaw @ ${OUTPUT_SAMPLE_RATE} Hz`);

    let audioBase64 = '';
    let mimeType = this.inferMimeType(contentType);
    let responseSampleRate = OUTPUT_SAMPLE_RATE;

    if ((contentType || '').toLowerCase().includes('application/json')) {
      const payload = await response.json();
      audioBase64 = this.extractBase64FromJson(payload);
      const jsonMimeType = payload?.mime_type || payload?.mimeType || payload?.format;
      const jsonSampleRate = payload?.sample_rate || payload?.sampleRate || payload?.speech_sample_rate;
      if (typeof jsonSampleRate === 'number') {
        responseSampleRate = jsonSampleRate;
      }
      console.log(`[SarvamTTS] JSON payload keys: ${Object.keys(payload).join(', ')} | sample_rate field: ${jsonSampleRate ?? 'not present'} | effective rate: ${responseSampleRate} Hz`);
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
      console.log(`[SarvamTTS] binary response size: ${audioBuffer.byteLength} bytes | effective rate: ${responseSampleRate} Hz`);
    }

    return {
      audioBase64,
      mimeType,
      sampleRate: responseSampleRate,
    };
  }
}
