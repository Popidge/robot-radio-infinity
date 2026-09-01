import { describe, expect, it } from "vitest";
import { activeLyricCue, buildLyricCues, lyricFitScale, splitLyricForDisplay } from "./lyrics";

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

  it("uses returned word timestamps instead of estimated section timing when they match", () => {
    const cues = buildLyricCues([
      { name: "Verse", durationMs: 30_000, description: "Voice enters", lyrics: "First signal through the room\nSecond signal starts to bloom" }
    ], 30_000, [
      { word: "First", startMs: 4_000, endMs: 4_350 },
      { word: "signal", startMs: 4_360, endMs: 4_800 },
      { word: "through", startMs: 4_810, endMs: 5_120 },
      { word: "the", startMs: 5_130, endMs: 5_260 },
      { word: "room,", startMs: 5_270, endMs: 5_900 },
      { word: "Second", startMs: 11_000, endMs: 11_420 },
      { word: "signal", startMs: 11_430, endMs: 11_850 },
      { word: "starts", startMs: 11_860, endMs: 12_150 },
      { word: "to", startMs: 12_160, endMs: 12_280 },
      { word: "bloom", startMs: 12_290, endMs: 12_900 }
    ]);

    expect(cues[0]?.startMs).toBe(3_920);
    expect(cues[0]?.endMs).toBe(6_160);
    expect(cues[1]?.startMs).toBe(10_920);
    expect(cues[1]?.endMs).toBe(13_160);
  });

  it("does not render planned lyric lines that are absent from observed audio", () => {
    const cues = buildLyricCues([
      {
        name: "Verse",
        durationMs: 30_000,
        description: "Voice enters",
        lyrics: "First signal through the room\nA line the performance omitted"
      }
    ], 30_000, [
      { word: "First", startMs: 4_000, endMs: 4_350 },
      { word: "signal", startMs: 4_360, endMs: 4_800 },
      { word: "through", startMs: 4_810, endMs: 5_120 },
      { word: "the", startMs: 5_130, endMs: 5_260 },
      { word: "room", startMs: 5_270, endMs: 5_900 }
    ]);

    expect(cues.map((cue) => cue.text)).toEqual(["First signal through the room"]);
  });

  it("balances a lyric across two lines without creating separate cues", () => {
    expect(splitLyricForDisplay("Turn the noise into light")).toEqual(["Turn the noise", "into light"]);
    expect(splitLyricForDisplay("Signal")).toEqual(["Signal"]);
  });

  it("scales rotated long lines inside the visible canvas", () => {
    const scale = lyricFitScale({
      contentWidth: 1_600,
      contentHeight: 260,
      viewportWidth: 1_280,
      viewportHeight: 720,
      rotationDeg: -8,
      travelX: 38,
      travelY: -5,
      inset: 32
    });
    const radians = 8 * (Math.PI / 180);
    const fittedWidth = (1_600 * Math.cos(radians) + 260 * Math.sin(radians)) * scale;

    expect(scale).toBeLessThan(1);
    expect(fittedWidth).toBeLessThanOrEqual(1_280 - 64 - 38);
  });
});
