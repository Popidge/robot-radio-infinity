import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MP3_DECODER_READY_TIMEOUT_MS, PcmNormalizer, StreamAudioDecoder } from "./stream-audio-decoder";

afterEach(() => vi.useRealTimers());

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

  it("decodes a captured ElevenLabs MP3 into mixer-ready PCM", async () => {
    const bytes = new Uint8Array(readFileSync(new URL(
      "../../../server/test-fixtures/eleven-music/golden/dry-id/audio.mp3",
      import.meta.url
    )));
    const decoder = new StreamAudioDecoder({ encoding: "mp3", sampleRate: 48_000, channels: 2 });

    const chunks = await decoder.push(bytes);
    chunks.push(...decoder.finish());

    expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBeGreaterThan(48_000 * 2);
    await decoder.close();
  });

  it("fails a stalled MP3 decoder instead of leaving generation hung", async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const decoder = new StreamAudioDecoder(
      { encoding: "mp3", sampleRate: 48_000, channels: 2 },
      () => ({
        ready: new Promise<void>(() => undefined),
        decode: vi.fn(),
        free: vi.fn(async () => undefined),
        terminate
      })
    );

    const pushed = decoder.push(new Uint8Array([0xff, 0xfb]));
    const failure = expect(pushed).rejects.toThrow("script-src 'wasm-unsafe-eval'");
    await vi.advanceTimersByTimeAsync(MP3_DECODER_READY_TIMEOUT_MS);

    await failure;
    expect(terminate).toHaveBeenCalledOnce();
  });
});
