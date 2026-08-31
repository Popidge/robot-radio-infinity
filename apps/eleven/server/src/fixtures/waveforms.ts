export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const CHUNK_MS = 100;

export type FixtureKind = "music" | "tts";

export interface FixtureParameters {
  kind: FixtureKind;
  bpm: number;
  energy: number;
  seed: number;
  speechText?: string;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function fixtureSeed(value: string): number {
  return hash(value) / 0xffffffff;
}

export function renderFixtureChunk(
  parameters: FixtureParameters,
  startFrame: number,
  frameCount: number
): Float32Array {
  const output = new Float32Array(frameCount * CHANNELS);
  const baseFrequency = 82 + parameters.seed * 96;
  const beatFrames = (60 / parameters.bpm) * SAMPLE_RATE;
  const speechLength = Math.max(parameters.speechText?.length ?? 1, 1);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const absoluteFrame = startFrame + frame;
    const time = absoluteFrame / SAMPLE_RATE;
    const beatPhase = (absoluteFrame % beatFrames) / beatFrames;
    const kickEnvelope = Math.exp(-beatPhase * 22);
    const kick = Math.sin(2 * Math.PI * (48 + 52 * (1 - beatPhase)) * time) * kickEnvelope;
    const pad =
      Math.sin(2 * Math.PI * baseFrequency * time) * 0.45 +
      Math.sin(2 * Math.PI * baseFrequency * 1.5 * time) * 0.22 +
      Math.sin(2 * Math.PI * baseFrequency * 2 * time) * 0.12;
    const shimmer = Math.sin(2 * Math.PI * (baseFrequency * 4 + 3 * Math.sin(time * 0.7)) * time);

    let sample: number;
    if (parameters.kind === "music") {
      sample = pad * 0.2 + kick * (0.12 + parameters.energy * 0.18) + shimmer * 0.035;
    } else {
      const syllable = Math.floor(time * 5) % speechLength;
      const charCode = parameters.speechText?.charCodeAt(syllable) ?? 65;
      const voiceFrequency = 125 + (charCode % 20) * 8;
      const voiceEnvelope = Math.pow(Math.sin(Math.PI * ((time * 5) % 1)), 0.6);
      sample =
        (Math.sin(2 * Math.PI * voiceFrequency * time) * 0.17 +
          Math.sin(2 * Math.PI * voiceFrequency * 2 * time) * 0.06) *
        voiceEnvelope;
    }

    const index = frame * CHANNELS;
    output[index] = sample;
    output[index + 1] = sample * 0.98 + shimmer * 0.006;
  }
  return output;
}
