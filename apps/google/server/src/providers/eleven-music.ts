import type { MusicProvider, MusicStream, TrackSpec } from "@robot-radio/google-shared";
import { fixtureSeed } from "../fixtures/waveforms";
import { CHANNELS, SAMPLE_RATE, createFixtureStream, type StreamControl } from "./stream-utils";

export class MockElevenMusicProvider implements MusicProvider {
  private readonly controls = new Map<string, StreamControl>();

  async generate(spec: TrackSpec, generationRate: number): Promise<MusicStream> {
    const control: StreamControl = {
      cancelled: false,
      parameters: {
        kind: "music",
        bpm: spec.bpm,
        energy: spec.energy,
        seed: fixtureSeed(`${spec.id}:${spec.description}`)
      },
      startupLatencyMs: Number(process.env.MOCK_MUSIC_STARTUP_MS ?? 450),
      failAfterMs: process.env.MOCK_MUSIC_FAIL_AFTER_MS ? Number(process.env.MOCK_MUSIC_FAIL_AFTER_MS) : undefined,
      starveAtMs: process.env.MOCK_MUSIC_STARVE_AT_MS ? Number(process.env.MOCK_MUSIC_STARVE_AT_MS) : undefined,
      starveForMs: process.env.MOCK_MUSIC_STARVE_FOR_MS ? Number(process.env.MOCK_MUSIC_STARVE_FOR_MS) : undefined
    };
    this.controls.set(spec.id, control);

    return {
      id: spec.id,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs: spec.durationMs,
      chunks: createFixtureStream(control, spec.durationMs, generationRate)
    };
  }

  async cancel(id: string): Promise<void> {
    const control = this.controls.get(id);
    if (control) control.cancelled = true;
    this.controls.delete(id);
  }
}

export type ElevenMusicProvider = MusicProvider;
