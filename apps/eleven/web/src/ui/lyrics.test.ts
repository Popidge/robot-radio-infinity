import { describe, expect, it } from "vitest";
import { activeLyricCue, buildLyricCues } from "./lyrics";

describe("lyric cues", () => {
  it("maps each supplied lyric line into its section window", () => {
    const cues = buildLyricCues([
      { name: "Intro", durationMs: 10_000, description: "Instrumental opening" },
      { name: "Verse", durationMs: 20_000, description: "Voice enters", lyrics: "First signal\nSecond signal" }
    ], 30_000);

    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toBe("First signal");
    expect(cues[0]?.startMs).toBeGreaterThanOrEqual(10_000);
    expect(cues[1]?.endMs).toBeLessThanOrEqual(30_000);
    expect(activeLyricCue(cues, cues[0]!.startMs + 10)?.text).toBe("First signal");
  });

  it("scales authored section durations to the resolved audio duration", () => {
    const cues = buildLyricCues([
      { name: "Verse", durationMs: 10_000, description: "Verse", lyrics: "Only line" },
      { name: "Outro", durationMs: 10_000, description: "Outro" }
    ], 40_000);

    expect(cues[0]?.endMs).toBeLessThanOrEqual(20_000);
    expect(cues[0]?.endMs).toBeGreaterThan(10_000);
  });

  it("omits directions and lyric-less tracks", () => {
    expect(buildLyricCues(undefined, 30_000)).toEqual([]);
    expect(buildLyricCues([
      { name: "Break", durationMs: 30_000, description: "Instrumental", lyrics: "{guitar solo}\n[Break]" }
    ], 30_000)).toEqual([]);
  });
});
