import type { ContinuityProvider, LLMProvider, MusicProvider, TTSProvider } from "@robot-radio/shared";
import { MockElevenMusicProvider } from "./eleven-music";
import { MockElevenTTSProvider } from "./eleven-tts";
import { GoogleLLMProvider } from "./google/llm";
import { GoogleLyriaRealtimeProvider } from "./google/lyria-realtime";
import { GoogleLyria3MusicProvider } from "./google/lyria3-music";
import { GoogleTTSProvider } from "./google/tts";
import { MockLLMProvider } from "./llm";
import { MockLyriaProvider } from "./lyria";
import type { GoogleAudioTelemetrySink } from "./google/telemetry";

export type ProviderName = "mock" | "google";

export interface ProviderSelections {
  llm: ProviderName;
  music: ProviderName;
  lyria: ProviderName;
  tts: ProviderName;
}

export interface ProviderBundle {
  selections: ProviderSelections;
  llm: LLMProvider;
  music: MusicProvider;
  lyria: ContinuityProvider;
  tts: TTSProvider;
}

function selection(name: string, fallback: ProviderName): ProviderName {
  const value = process.env[name] ?? fallback;
  if (value === "mock" || value === "google") return value;
  throw new Error(`${name} must be "mock" or "google" for this milestone; received "${value}"`);
}

function geminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required when a Google provider is selected");
  return apiKey;
}

export function readProviderSelections(): ProviderSelections {
  const defaultStack: ProviderName = process.env.GEMINI_API_KEY ? "google" : "mock";
  const stack = selection("PROVIDER_STACK", defaultStack);
  return {
    llm: selection("LLM_PROVIDER", stack),
    music: selection("MUSIC_PROVIDER", stack),
    lyria: selection("LYRIA_PROVIDER", stack),
    tts: selection("TTS_PROVIDER", stack)
  };
}

export function createProviders(options: { googleAudioTelemetry?: GoogleAudioTelemetrySink } = {}): ProviderBundle {
  const selections = readProviderSelections();
  const needsGoogle = Object.values(selections).includes("google");
  const apiKey = needsGoogle ? geminiApiKey() : "";
  return {
    selections,
    llm: selections.llm === "google" ? new GoogleLLMProvider(apiKey) : new MockLLMProvider(),
    music: selections.music === "google" ? new GoogleLyria3MusicProvider(apiKey, options.googleAudioTelemetry) : new MockElevenMusicProvider(),
    lyria: selections.lyria === "google" ? new GoogleLyriaRealtimeProvider(apiKey, options.googleAudioTelemetry) : new MockLyriaProvider(),
    tts: selections.tts === "google" ? new GoogleTTSProvider(apiKey, options.googleAudioTelemetry) : new MockElevenTTSProvider()
  };
}
