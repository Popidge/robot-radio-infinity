import type { AudioStream, TTSProvider } from "@robot-radio/eleven-shared";
import { fixtureSeed } from "../fixtures/waveforms";
import { CHANNELS, SAMPLE_RATE, createFixtureStream, pcmBytes, responseBytes, type StreamControl } from "./stream-utils";

export const DEFAULT_ELEVENLABS_VOICE_ID = "st7NwhTPEzqo2riw7qWC";

async function errorPayload(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 8_000);
  try { return JSON.stringify(JSON.parse(text)) } catch { return text }
}

export class ElevenTTSApiProvider implements TTSProvider {
  private readonly active = new Map<string, { controller: AbortController; timeout: ReturnType<typeof setTimeout> }>();
  constructor(
    private readonly apiKey: string,
    private readonly voiceId = process.env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE_ID,
    private readonly baseUrl = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io"
  ) {}

  async speak(id: string, text: string): Promise<AudioStream> {
    await this.cancel(id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("ElevenLabs TTS timed out.")), Number(process.env.ELEVENLABS_TTS_TIMEOUT_MS ?? 60_000));
    const active = { controller, timeout };
    this.active.set(id, active);
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=2`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "xi-api-key": this.apiKey },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5",
            voice_settings: { stability: 0.48, similarity_boost: 0.72, style: 0.18, use_speaker_boost: true }
          }),
          signal: controller.signal
        }
      );
    } catch (error) {
      clearTimeout(timeout);
      this.active.delete(id);
      throw error;
    }
    if (!response.ok) {
      clearTimeout(timeout);
      this.active.delete(id);
      throw new Error(`ElevenLabs TTS returned HTTP ${response.status}: ${await errorPayload(response)}`);
    }
    if (!response.body) {
      clearTimeout(timeout);
      this.active.delete(id);
      throw new Error("ElevenLabs TTS returned no audio body.");
    }
    const finish = (): void => {
      clearTimeout(timeout);
      if (this.active.get(id) === active) this.active.delete(id);
    };
    return {
      id,
      encoding: "mp3",
      sampleRate: 44_100,
      channels: 2,
      durationMs: null,
      chunks: responseBytes(response.body, finish)
    };
  }

  async cancel(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    clearTimeout(active.timeout);
    active.controller.abort();
  }
}

export class MockElevenTTSProvider implements TTSProvider {
  private readonly controls = new Map<string, StreamControl>();

  async speak(id: string, text: string): Promise<AudioStream> {
    const control: StreamControl = {
      cancelled: false,
      parameters: { kind: "tts", bpm: 120, energy: 0.5, seed: fixtureSeed(text), speechText: text },
      startupLatencyMs: Number(process.env.MOCK_TTS_STARTUP_MS ?? 180),
      failAfterMs: process.env.MOCK_TTS_FAIL_AFTER_MS ? Number(process.env.MOCK_TTS_FAIL_AFTER_MS) : undefined
    };
    this.controls.set(id, control);
    const durationMs = Math.max(1_800, Math.min(8_000, text.length * 55));
    return {
      id,
      encoding: "pcm-f32le",
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs,
      chunks: pcmBytes(createFixtureStream(control, durationMs, 1.8))
    };
  }

  async cancel(id: string): Promise<void> {
    const control = this.controls.get(id);
    if (control) control.cancelled = true;
    this.controls.delete(id);
  }
}

export type ElevenTTSProvider = TTSProvider;
