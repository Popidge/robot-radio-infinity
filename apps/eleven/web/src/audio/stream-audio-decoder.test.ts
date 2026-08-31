import { describe, expect, it } from "vitest";
import { PcmNormalizer, StreamAudioDecoder } from "./stream-audio-decoder";

function samples(chunks: Array<Float32Array | null>): number[] {
  return chunks.flatMap((chunk) => chunk ? Array.from(chunk) : []);
}

describe("PcmNormalizer", () => {
  it("interleaves stereo and retains the final frame", () => {
    const normalizer = new PcmNormalizer();
    const streamed = normalizer.push([
      new Float32Array([0.1, 0.2, 0.3]),
      new Float32Array([-0.1, -0.2, -0.3])
    ], 48_000);

    expect(samples([streamed, normalizer.flush()])).toEqual([
      expect.closeTo(0.1), expect.closeTo(-0.1),
      expect.closeTo(0.2), expect.closeTo(-0.2),
      expect.closeTo(0.3), expect.closeTo(-0.3)
    ]);
  });

  it("duplicates mono and resamples it to 48 kHz", () => {
    const normalizer = new PcmNormalizer();
    const streamed = normalizer.push([new Float32Array([0, 1, 0])], 24_000);

    expect(samples([streamed, normalizer.flush()])).toEqual([
      0, 0,
      0.5, 0.5,
      1, 1,
      0.5, 0.5,
      0, 0,
      0, 0
    ]);
  });

  it("resamples continuously across decoder chunk boundaries", () => {
    const whole = new PcmNormalizer();
    const expected = samples([
      whole.push([new Float32Array([0, 0.25, 0.5, 0.75, 1])], 44_100),
      whole.flush()
    ]);

    const streamed = new PcmNormalizer();
    const actual = samples([
      streamed.push([new Float32Array([0, 0.25])], 44_100),
      streamed.push([new Float32Array([0.5, 0.75, 1])], 44_100),
      streamed.flush()
    ]);

    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 6));
  });
});

describe("StreamAudioDecoder", () => {
  it("keeps mock PCM transport zero-copy and ready for the mixer", async () => {
    const input = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    const decoder = new StreamAudioDecoder({ encoding: "pcm-f32le", sampleRate: 48_000, channels: 2 });
    const [output] = await decoder.push(new Uint8Array(input.buffer));

    expect(output?.buffer).toBe(input.buffer);
    expect(Array.from(output ?? [])).toEqual(Array.from(input));
    await decoder.close();
  });
});
