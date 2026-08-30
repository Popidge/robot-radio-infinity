import type { MusicalSnapshot, TrackSpec } from "@robot-radio/shared";
import { GoogleLyriaRealtimeProvider } from "../providers/google/lyria-realtime";
import { GoogleLyria3MusicProvider } from "../providers/google/lyria3-music";
import type { GoogleAudioTelemetryEvent } from "../providers/google/telemetry";
import { GoogleTTSProvider } from "../providers/google/tts";

interface ProfileResult {
  provider: "lyria-realtime" | "lyria-3" | "gemini-tts";
  model: string;
  requestedAudioMs: number | null;
  providerReadyMs: number;
  responseOpenedMs: number | null;
  firstRawAudioMs: number | null;
  firstPcmAudioMs: number | null;
  wallTimeMs: number;
  receivedAudioMs: number;
  generationRate: number;
  pcmChunks: number;
  rawAudioDeltas: number;
  rawAudioBytes: number;
  pcmInterarrivalP50Ms: number | null;
  pcmInterarrivalP95Ms: number | null;
  mimeTypes: string[];
  sampleRates: number[];
  channels: number[];
  streamEventCounts: Record<string, number>;
}

type AudioDeltaTelemetry = Extract<GoogleAudioTelemetryEvent, { type: "audio_delta" }>;

function isAudioDelta(event: GoogleAudioTelemetryEvent): event is AudioDeltaTelemetry {
  return event.type === "audio_delta";
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? null;
}

async function collect(
  providerName: ProfileResult["provider"],
  model: string,
  requestedAudioMs: number | null,
  create: () => Promise<{ chunks: AsyncIterable<Float32Array> }>,
  stop?: () => Promise<void>
): Promise<ProfileResult> {
  const startedAt = performance.now();
  const telemetry: GoogleAudioTelemetryEvent[] = profileTelemetry;
  const stream = await create();
  const providerReadyMs = performance.now() - startedAt;
  let firstPcmAudioMs: number | null = null;
  let previousChunkAt: number | null = null;
  const interarrival: number[] = [];
  let receivedAudioMs = 0;
  let pcmChunks = 0;

  for await (const chunk of stream.chunks) {
    const at = performance.now();
    firstPcmAudioMs ??= at - startedAt;
    if (previousChunkAt !== null) interarrival.push(at - previousChunkAt);
    previousChunkAt = at;
    pcmChunks += 1;
    receivedAudioMs += (chunk.length / 2 / 48_000) * 1_000;
    if (providerName === "lyria-realtime" && requestedAudioMs !== null && receivedAudioMs >= requestedAudioMs) break;
  }
  await stop?.();
  const wallTimeMs = performance.now() - startedAt;
  const audioEvents = telemetry.filter(
    (event): event is AudioDeltaTelemetry => event.provider === providerName && isAudioDelta(event)
  );
  const responseEvent = telemetry.find((event) => event.provider === providerName && event.type === "response_opened");
  const eventCounts: Record<string, number> = {};
  for (const event of telemetry) {
    if (event.provider !== providerName || event.type !== "stream_event") continue;
    eventCounts[event.eventType] = (eventCounts[event.eventType] ?? 0) + 1;
  }
  return {
    provider: providerName,
    model,
    requestedAudioMs,
    providerReadyMs,
    responseOpenedMs: responseEvent ? responseEvent.at - startedAt : null,
    firstRawAudioMs: audioEvents[0] ? audioEvents[0].at - startedAt : null,
    firstPcmAudioMs,
    wallTimeMs,
    receivedAudioMs,
    generationRate: receivedAudioMs / wallTimeMs,
    pcmChunks,
    rawAudioDeltas: audioEvents.length,
    rawAudioBytes: audioEvents.reduce((total, event) => total + event.encodedBytes, 0),
    pcmInterarrivalP50Ms: percentile(interarrival, 0.5),
    pcmInterarrivalP95Ms: percentile(interarrival, 0.95),
    mimeTypes: [...new Set(audioEvents.map((event) => event.mimeType).filter((value): value is string => Boolean(value)))],
    sampleRates: [...new Set(audioEvents.map((event) => event.sampleRate).filter((value): value is number => value !== undefined))],
    channels: [...new Set(audioEvents.map((event) => event.channels).filter((value): value is number => value !== undefined))],
    streamEventCounts: eventCounts
  };
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Load the workspace .env file before profiling.");

const mode = argument("--mode", "all");
const durationSeconds = Number(argument("--duration", "180"));
const realtimeSeconds = Number(argument("--realtime-seconds", "20"));
const profileTelemetry: GoogleAudioTelemetryEvent[] = [];
const telemetry = (event: GoogleAudioTelemetryEvent): void => {
  profileTelemetry.push(event);
};
const results: ProfileResult[] = [];

try {
  if (mode === "all" || mode === "realtime") {
    const model = process.env.GEMINI_LYRIA_REALTIME_MODEL ?? "models/lyria-realtime-exp";
    const provider = new GoogleLyriaRealtimeProvider(apiKey, telemetry, model);
    const seed: MusicalSnapshot = { styleSummary: "minimal nocturnal techno, warm analog synths", bpm: 116, key: "E minor", energy: 0.55 };
    results.push(
      await collect(
        "lyria-realtime",
        model,
        realtimeSeconds * 1_000,
        () => provider.start("profile-realtime", seed),
        () => provider.stop("profile-realtime")
      )
    );
  }

  if (mode === "all" || mode === "pro") {
    const model = process.env.GEMINI_MUSIC_MODEL ?? "lyria-3-pro-preview";
    const provider = new GoogleLyria3MusicProvider(apiKey, telemetry, model);
    const spec: TrackSpec = {
      id: "profile-lyria-3-pro",
      title: "Lyria 3 Pro profile",
      description: "Nocturnal melodic techno with warm analog synths and a patient, evolving arrangement",
      styles: ["melodic techno", "ambient techno"],
      mood: ["nocturnal", "focused", "expansive"],
      energy: 0.62,
      bpm: 116,
      key: "E minor",
      vocals: "instrumental",
      durationMs: durationSeconds * 1_000
    };
    results.push(await collect("lyria-3", model, spec.durationMs, () => provider.generate(spec, 1)));
  }

  if (mode === "all" || mode === "tts") {
    const model = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
    const provider = new GoogleTTSProvider(apiKey, telemetry, model);
    results.push(
      await collect(
        "gemini-tts",
        model,
        null,
        () => provider.speak("profile-tts", "You are listening to Robot Radio Infinity. The next signal is already forming.")
      )
    );
  }

  process.stdout.write(`${JSON.stringify({ profiledAt: new Date().toISOString(), results }, null, 2)}\n`);
} catch (error) {
  const unsafeMessage = error instanceof Error ? error.message : String(error);
  const message = unsafeMessage.replaceAll(apiKey, "[redacted]");
  process.stderr.write(`${JSON.stringify({ error: message, partialResults: results }, null, 2)}\n`);
  process.exitCode = 1;
}
