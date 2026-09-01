import { describe, expect, it } from "vitest";
import { createInitialState } from "../station/state";
import { createVisualTheme } from "./visual-theme";

describe("visual theme", () => {
  it("is stable for the same track and becomes more intense with energy", () => {
    const state = createInitialState();
    const quiet = createVisualTheme({ ...state.playback, title: "Signal", energy: 0.2 }, state.intent);
    const loud = createVisualTheme({ ...state.playback, title: "Signal", energy: 0.9 }, state.intent);

    expect(quiet.primary).not.toBe("");
    expect(loud.primary).not.toBe("");
    expect(loud.waveOpacity).toBeGreaterThan(quiet.waveOpacity);
    expect(loud.lyricOpacity).toBeGreaterThan(quiet.lyricOpacity);
  });
});
