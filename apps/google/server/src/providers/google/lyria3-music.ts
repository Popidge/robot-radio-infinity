import { GoogleGenAI } from "@google/genai";
import type { MusicProvider, MusicStream, TrackSpec } from "@robot-radio/google-shared";
import { GoogleAudioDecoder, chunkPcm } from "./audio";
import { compileLyria3Prompt } from "./prompt-compiler";
import { emitTelemetry, type GoogleAudioTelemetrySink } from "./telemetry";

interface MusicControl {
  controller: AbortController;
}

interface AudioDeltaLike {
  type: "audio";
  data?: string;
  mime_type?: string;
  sample_rate?: number;
  channels?: number;
}

export class GoogleLyria3MusicProvider implements MusicProvider {
  private readonly client: GoogleGenAI;
  private readonly controls = new Map<string, MusicControl>();
  private readonly model: string;

  constructor(
    apiKey: string,
    private readonly telemetry?: GoogleAudioTelemetrySink,
    model = process.env.GEMINI_MUSIC_MODEL ?? "lyria-3-pro-preview"
  ) {
    this.client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
    this.model = model;
  }

  async generate(spec: TrackSpec, _generationRate: number): Promise<MusicStream> {
    const controller = new AbortController();
    this.controls.set(spec.id, { controller });
    return {
      id: spec.id,
      sampleRate: 48_000,
      channels: 2,
      durationMs: spec.durationMs,
      chunks: this.generateChunks(spec, controller)
    };
  }

  async cancel(id: string): Promise<void> {
    this.controls.get(id)?.controller.abort();
    this.controls.delete(id);
  }

  private async *generateChunks(spec: TrackSpec, controller: AbortController): AsyncGenerator<Float32Array> {
    emitTelemetry(this.telemetry, { type: "request_started", provider: "lyria-3", streamId: spec.id, model: this.model, at: performance.now() });
    const decoder = new GoogleAudioDecoder({ mimeType: "audio/wav", sampleRate: 44_100, channels: 2 });
    try {
      const stream = await this.client.interactions.create(
        {
          model: this.model,
          input: compileLyria3Prompt(spec),
          response_format: { type: "audio" },
          store: false,
          stream: true
        },
        { signal: controller.signal, timeout: Number(process.env.GEMINI_MUSIC_TIMEOUT_MS ?? 600_000) }
      );
      emitTelemetry(this.telemetry, { type: "response_opened", provider: "lyria-3", streamId: spec.id, at: performance.now() });
      for await (const event of stream) {
        const eventType = "event_type" in event ? String(event.event_type) : "unknown";
        emitTelemetry(this.telemetry, { type: "stream_event", provider: "lyria-3", streamId: spec.id, at: performance.now(), eventType });
        if (eventType !== "step.delta" || !("delta" in event)) continue;
        const delta = event.delta as AudioDeltaLike;
        if (delta.type !== "audio" || !delta.data) continue;
        const encoded = Buffer.from(delta.data, "base64");
        emitTelemetry(this.telemetry, {
          type: "audio_delta",
          provider: "lyria-3",
          streamId: spec.id,
          at: performance.now(),
          encodedBytes: encoded.length,
          mimeType: delta.mime_type,
          sampleRate: delta.sample_rate,
          channels: delta.channels
        });
        for (const decoded of decoder.push(encoded, {
          mimeType: delta.mime_type,
          sampleRate: delta.sample_rate,
          channels: delta.channels
        })) {
          for (const chunk of chunkPcm(decoded)) yield chunk;
        }
      }
      for (const decoded of await decoder.flush()) {
        for (const chunk of chunkPcm(decoded)) yield chunk;
      }
      emitTelemetry(this.telemetry, { type: "completed", provider: "lyria-3", streamId: spec.id, at: performance.now() });
    } finally {
      this.controls.delete(spec.id);
    }
  }
}
