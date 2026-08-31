import type { AudioStream, TTSProvider } from "@robot-radio/google-shared";
import { fixtureSeed } from "../fixtures/waveforms";
import { CHANNELS, SAMPLE_RATE, createFixtureStream, type StreamControl } from "./stream-utils";

export class MockElevenTTSProvider implements TTSProvider {
  private readonly controls = new Map<string, StreamControl>();

  async speak(id: string, text: string): Promise<AudioStream> {
    const control: StreamControl = {
      cancelled: false,
      parameters: {
        kind: "tts",
        bpm: 120,
        energy: 0.5,
        seed: fixtureSeed(text),
        speechText: text
      },
      startupLatencyMs: Number(process.env.MOCK_TTS_STARTUP_MS ?? 180),
      failAfterMs: process.env.MOCK_TTS_FAIL_AFTER_MS ? Number(process.env.MOCK_TTS_FAIL_AFTER_MS) : undefined
    };
    this.controls.set(id, control);
    const durationMs = Math.max(1_800, Math.min(8_000, text.length * 55));
    return {
      id,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs,
      chunks: createFixtureStream(control, durationMs, 1.8)
    };
  }
}

export type ElevenTTSProvider = TTSProvider;
