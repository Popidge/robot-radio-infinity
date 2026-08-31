import { afterEach, describe, expect, it } from "vitest";
import { readProviderSelections } from "./index";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("provider selection", () => {
  it("uses Google automatically in AI Studio when a Gemini key is injected", () => {
    delete process.env.PROVIDER_STACK;
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.LLM_PROVIDER;
    delete process.env.MUSIC_PROVIDER;
    delete process.env.LYRIA_PROVIDER;
    delete process.env.TTS_PROVIDER;

    expect(readProviderSelections()).toEqual({
      llm: "google",
      music: "google",
      lyria: "google",
      tts: "google"
    });
  });

  it("selects a complete Google stack with one setting", () => {
    process.env.PROVIDER_STACK = "google";
    delete process.env.LLM_PROVIDER;
    delete process.env.MUSIC_PROVIDER;
    delete process.env.LYRIA_PROVIDER;
    delete process.env.TTS_PROVIDER;

    expect(readProviderSelections()).toEqual({
      llm: "google",
      music: "google",
      lyria: "google",
      tts: "google"
    });
  });

  it("allows a provider to override the selected stack", () => {
    process.env.PROVIDER_STACK = "google";
    process.env.LYRIA_PROVIDER = "mock";
    delete process.env.LLM_PROVIDER;
    delete process.env.MUSIC_PROVIDER;
    delete process.env.TTS_PROVIDER;

    expect(readProviderSelections()).toEqual({
      llm: "google",
      music: "google",
      lyria: "mock",
      tts: "google"
    });
  });

  it("rejects unknown providers at startup", () => {
    process.env.PROVIDER_STACK = "mystery";
    expect(() => readProviderSelections()).toThrow(/must be "mock" or "google"/);
  });
});
