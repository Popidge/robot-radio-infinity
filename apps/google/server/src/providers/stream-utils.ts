import {
  CHANNELS,
  CHUNK_MS,
  SAMPLE_RATE,
  renderFixtureChunk,
  type FixtureParameters
} from "../fixtures/waveforms";

export interface StreamControl {
  cancelled: boolean;
  parameters: FixtureParameters;
  startupLatencyMs?: number;
  failAfterMs?: number;
  starveAtMs?: number;
  starveForMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* createFixtureStream(
  control: StreamControl,
  durationMs: number | null,
  generationRate: number
): AsyncGenerator<Float32Array> {
  const chunkFrames = Math.round((CHUNK_MS / 1000) * SAMPLE_RATE);
  const totalFrames = durationMs === null ? Number.POSITIVE_INFINITY : Math.round((durationMs / 1000) * SAMPLE_RATE);
  let frame = 0;
  let starvationCompleted = false;
  const intervalMs = Math.max(8, CHUNK_MS / Math.max(generationRate, 0.05));

  if (control.startupLatencyMs) await delay(control.startupLatencyMs);

  while (!control.cancelled && frame < totalFrames) {
    const generatedMs = (frame / SAMPLE_RATE) * 1_000;
    if (control.failAfterMs !== undefined && generatedMs >= control.failAfterMs) {
      throw new Error(`Mock ${control.parameters.kind} failure after ${Math.round(generatedMs)}ms`);
    }
    if (!starvationCompleted && control.starveAtMs !== undefined && generatedMs >= control.starveAtMs) {
      starvationCompleted = true;
      await delay(control.starveForMs ?? 3_000);
    }
    const frames = Math.min(chunkFrames, totalFrames - frame);
    yield renderFixtureChunk(control.parameters, frame, frames);
    frame += frames;
    await delay(intervalMs);
  }
}

export { CHANNELS, SAMPLE_RATE };
