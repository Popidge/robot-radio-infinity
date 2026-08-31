import type {
  ContinuityProvider,
  ContinuityStream,
  LyriaTransitionPlan,
  MusicalSnapshot
} from "@robot-radio/google-shared";
import { fixtureSeed } from "../fixtures/waveforms";
import { CHANNELS, SAMPLE_RATE, createFixtureStream, type StreamControl } from "./stream-utils";

export class MockLyriaProvider implements ContinuityProvider {
  private readonly controls = new Map<string, StreamControl>();

  async start(id: string, seed: MusicalSnapshot): Promise<ContinuityStream> {
    const control: StreamControl = {
      cancelled: false,
      parameters: {
        kind: "lyria",
        bpm: seed.bpm ?? 110,
        energy: seed.energy ?? 0.5,
        seed: fixtureSeed(`${id}:${seed.styleSummary}`)
      },
      startupLatencyMs: Number(process.env.MOCK_LYRIA_STARTUP_MS ?? 220),
      failAfterMs: process.env.MOCK_LYRIA_FAIL_AFTER_MS ? Number(process.env.MOCK_LYRIA_FAIL_AFTER_MS) : undefined
    };
    this.controls.set(id, control);
    return {
      id,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs: null,
      chunks: createFixtureStream(control, null, 3)
    };
  }

  async steer(id: string, plan: LyriaTransitionPlan): Promise<void> {
    const control = this.controls.get(id);
    if (!control) throw new Error(`Unknown Lyria stream: ${id}`);
    const lastKeyframe = plan.keyframes?.at(-1);
    control.parameters.seed = fixtureSeed(plan.destinationSummary);
    control.parameters.energy = lastKeyframe?.energy ?? Math.min(1, control.parameters.energy + 0.12);
    control.parameters.bpm = lastKeyframe?.bpm ?? control.parameters.bpm;
  }

  async stop(id: string): Promise<void> {
    const control = this.controls.get(id);
    if (control) control.cancelled = true;
    this.controls.delete(id);
  }
}

export type LyriaProvider = ContinuityProvider;
