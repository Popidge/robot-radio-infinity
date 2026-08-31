import { afterEach, describe, expect, it } from "vitest";
import { readProviderSelections } from "./index";

const originalEnvironment = { ...process.env };

afterEach(() => { process.env = { ...originalEnvironment } });

function clearSelection(): void {
  delete process.env.PROVIDER_STACK;
  delete process.env.LLM_PROVIDER;
  delete process.env.MUSIC_PROVIDER;
  delete process.env.TRANSITION_PROVIDER;
  delete process.env.TTS_PROVIDER;
}

describe("provider selection", () => {
  it("uses the ElevenLabs/OpenAI stack automatically when both keys exist", () => {
    clearSelection();
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.ELEVENLABS_API_KEY = "eleven-test";
    expect(readProviderSelections()).toEqual({ llm: "openai", music: "eleven", transitions: "eleven", tts: "eleven" });
  });

  it("uses mocks without a complete set of live keys", () => {
    clearSelection();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    expect(readProviderSelections()).toEqual({ llm: "mock", music: "mock", transitions: "mock", tts: "mock" });
  });

  it("selects the complete ElevenLabs/OpenAI stack explicitly", () => {
    clearSelection();
    process.env.PROVIDER_STACK = "eleven";
    expect(readProviderSelections()).toEqual({ llm: "openai", music: "eleven", transitions: "eleven", tts: "eleven" });
  });

  it("allows individual provider overrides", () => {
    clearSelection();
    process.env.PROVIDER_STACK = "eleven";
    process.env.TRANSITION_PROVIDER = "mock";
    expect(readProviderSelections()).toEqual({ llm: "openai", music: "eleven", transitions: "mock", tts: "eleven" });
  });

  it("rejects unknown stacks", () => {
    clearSelection();
    process.env.PROVIDER_STACK = "mystery";
    expect(() => readProviderSelections()).toThrow(/must be "mock" or "eleven"/);
  });
});
