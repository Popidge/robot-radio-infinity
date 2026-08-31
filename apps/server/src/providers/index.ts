import type { LLMProvider, MusicProvider, TransitionProvider, TTSProvider } from "@robot-radio/shared";
import { ElevenMusicApiProvider, MockElevenMusicProvider } from "./eleven-music";
import { ElevenTTSApiProvider, MockElevenTTSProvider } from "./eleven-tts";
import { MockLLMProvider } from "./llm";
import { OpenAILLMProvider } from "./openai/llm";

export type LLMProviderName = "mock" | "openai";
export type AudioProviderName = "mock" | "eleven";

export interface ProviderSelections {
  llm: LLMProviderName;
  music: AudioProviderName;
  transitions: AudioProviderName;
  tts: AudioProviderName;
}

export interface ProviderBundle {
  selections: ProviderSelections;
  llm: LLMProvider;
  music: MusicProvider;
  transitions: TransitionProvider;
  tts: TTSProvider;
}

function selectLLM(name: string, fallback: LLMProviderName): LLMProviderName {
  const value = process.env[name] ?? fallback;
  if (value === "mock" || value === "openai") return value;
  throw new Error(`${name} must be "mock" or "openai"; received "${value}"`);
}

function selectAudio(name: string, fallback: AudioProviderName): AudioProviderName {
  const value = process.env[name] ?? fallback;
  if (value === "mock" || value === "eleven") return value;
  throw new Error(`${name} must be "mock" or "eleven"; received "${value}"`);
}

export function readProviderSelections(): ProviderSelections {
  const configured = process.env.PROVIDER_STACK;
  if (configured && configured !== "mock" && configured !== "eleven") {
    throw new Error(`PROVIDER_STACK must be "mock" or "eleven" in this worktree; received "${configured}"`);
  }
  const stack: "mock" | "eleven" = configured === "eleven" ? "eleven" : configured === "mock" ? "mock" :
    process.env.OPENAI_API_KEY && process.env.ELEVENLABS_API_KEY ? "eleven" : "mock";
  return {
    llm: selectLLM("LLM_PROVIDER", stack === "eleven" ? "openai" : "mock"),
    music: selectAudio("MUSIC_PROVIDER", stack),
    transitions: selectAudio("TRANSITION_PROVIDER", stack),
    tts: selectAudio("TTS_PROVIDER", stack)
  };
}

export function createProviders(): ProviderBundle {
  const selections = readProviderSelections();
  const needsEleven = selections.music === "eleven" || selections.transitions === "eleven" || selections.tts === "eleven";
  const elevenKey = process.env.ELEVENLABS_API_KEY ?? "";
  if (needsEleven && !elevenKey) throw new Error("ELEVENLABS_API_KEY is required when an ElevenLabs provider is selected");
  const openAIKey = process.env.OPENAI_API_KEY ?? "";
  if (selections.llm === "openai" && !openAIKey) throw new Error("OPENAI_API_KEY is required when the OpenAI provider is selected");

  const elevenMusic = new ElevenMusicApiProvider(elevenKey);
  const mockMusic = new MockElevenMusicProvider();
  return {
    selections,
    llm: selections.llm === "openai" ? new OpenAILLMProvider(openAIKey) : new MockLLMProvider(),
    music: selections.music === "eleven" ? elevenMusic : mockMusic,
    transitions: selections.transitions === "eleven" ? elevenMusic : mockMusic,
    tts: selections.tts === "eleven" ? new ElevenTTSApiProvider(elevenKey) : new MockElevenTTSProvider()
  };
}
