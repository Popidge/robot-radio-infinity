import { describe, expect, it } from "vitest";
import { visualizerSpectrumIndex } from "./AudioVisualizer";

describe("visualizer frequency mapping", () => {
  it("maps logarithmically into the useful MP3 band instead of the full Nyquist range", () => {
    const indices = Array.from({ length: 80 }, (_, index) => visualizerSpectrumIndex(index, 80, 256));

    expect(indices[0]).toBeLessThan(3);
    expect(indices.at(-1)).toBe(160);
    expect(indices.every((value, index) => index === 0 || value >= indices[index - 1]!)).toBe(true);
    expect(indices.at(-1)).toBeLessThan(256 * 0.7);
  });
});
