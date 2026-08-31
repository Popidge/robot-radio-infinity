import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import type { AudioStream, TTSProvider } from "@robot-radio/shared";
import { GoogleAudioDecoder, chunkPcm } from "./audio";
import { emitTelemetry, type GoogleAudioTelemetrySink } from "./telemetry";

export type GoogleTTSDelivery = "stream" | "batch";

const INPUT_SAMPLE_RATE = 24_000;
const INPUT_CHANNELS = 1;

function readDelivery(value = process.env.GEMINI_TTS_DELIVERY ?? "stream"): GoogleTTSDelivery {
  if (value === "stream" || value === "batch") return value;
  throw new Error(`GEMINI_TTS_DELIVERY must be "stream" or "batch"; received "${value}"`);
}

export class GoogleTTSProvider implements TTSProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly voice: string;
  private readonly delivery: GoogleTTSDelivery;

  constructor(
    apiKey: string,
    private readonly telemetry?: GoogleAudioTelemetrySink,
    model = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview",
    voice = process.env.GEMINI_TTS_VOICE ?? "Kore",
    delivery = readDelivery()
  ) {
    this.client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
    this.model = model;
    this.voice = voice;
    this.delivery = delivery;
  }

  async speak(id: string, text: string): Promise<AudioStream> {
    return {
      id,
      sampleRate: 48_000,
      channels: 2,
      durationMs: null,
      chunks: this.generateSpeech(id, text)
    };
  }

  async cancel(_id: string): Promise<void> {
    // The inactive Google adapter returns finite requests and has no cancellation handle.
  }

  private request(text: string): GenerateContentParameters {
    return {
      model: this.model,
      contents: [{ parts: [{ text: `Read this exactly as a concise, warm radio DJ:\n${text}` }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.voice }
          }
        },
        httpOptions: { timeout: Number(process.env.GEMINI_TTS_TIMEOUT_MS ?? 120_000) }
      }
    };
  }

  private async *generateSpeech(id: string, text: string): AsyncGenerator<Float32Array> {
    emitTelemetry(this.telemetry, {
      type: "request_started",
      provider: "gemini-tts",
      streamId: id,
      model: this.model,
      at: performance.now()
    });

    if (this.delivery === "batch") yield* this.generateBatch(id, text);
    else yield* this.generateStream(id, text);

    emitTelemetry(this.telemetry, { type: "completed", provider: "gemini-tts", streamId: id, at: performance.now() });
  }

  private async *generateStream(id: string, text: string): AsyncGenerator<Float32Array> {
    const decoder = this.decoder();
    const stream = await this.client.models.generateContentStream(this.request(text));
    emitTelemetry(this.telemetry, { type: "response_opened", provider: "gemini-tts", streamId: id, at: performance.now() });

    for await (const response of stream) {
      emitTelemetry(this.telemetry, {
        type: "stream_event",
        provider: "gemini-tts",
        streamId: id,
        at: performance.now(),
        eventType: "content.delta"
      });
      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (!part.inlineData?.data) continue;
        yield* this.decodeAudio(id, decoder, part.inlineData.data, part.inlineData.mimeType);
      }
    }

    yield* this.flushDecoder(decoder);
  }

  private async *generateBatch(id: string, text: string): AsyncGenerator<Float32Array> {
    const decoder = this.decoder();
    const response = await this.client.models.generateContent(this.request(text));
    emitTelemetry(this.telemetry, { type: "response_opened", provider: "gemini-tts", streamId: id, at: performance.now() });

    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      yield* this.decodeAudio(id, decoder, part.inlineData.data, part.inlineData.mimeType);
    }

    yield* this.flushDecoder(decoder);
  }

  private decoder(): GoogleAudioDecoder {
    return new GoogleAudioDecoder({
      mimeType: "audio/l16",
      sampleRate: INPUT_SAMPLE_RATE,
      channels: INPUT_CHANNELS
    });
  }

  private *decodeAudio(id: string, decoder: GoogleAudioDecoder, data: string, mimeType?: string): Generator<Float32Array> {
    const encoded = Buffer.from(data, "base64");
    emitTelemetry(this.telemetry, {
      type: "audio_delta",
      provider: "gemini-tts",
      streamId: id,
      at: performance.now(),
      encodedBytes: encoded.length,
      mimeType,
      sampleRate: INPUT_SAMPLE_RATE,
      channels: INPUT_CHANNELS
    });
    for (const decoded of decoder.push(encoded, {
      mimeType,
      sampleRate: INPUT_SAMPLE_RATE,
      channels: INPUT_CHANNELS
    })) {
      for (const chunk of chunkPcm(decoded)) yield chunk;
    }
  }

  private async *flushDecoder(decoder: GoogleAudioDecoder): AsyncGenerator<Float32Array> {
    for (const decoded of await decoder.flush()) {
      for (const chunk of chunkPcm(decoded)) yield chunk;
    }
  }
}
