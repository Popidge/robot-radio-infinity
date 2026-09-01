import type { MusicProvider, MusicStream, MusicStreamMetadata, MusicWordTimestamp, TrackSection, TrackSpec, TransitionProvider, TransitionSpec } from "@robot-radio/eleven-shared";
import { fixtureSeed } from "../fixtures/waveforms";
import { CHANNELS, SAMPLE_RATE, createFixtureStream, pcmBytes, responseBytes, type StreamControl } from "./stream-utils";

interface CompositionChunk {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles: string[];
  context_adherence: "high";
}

interface ActiveRequest { controller: AbortController; timeout: ReturnType<typeof setTimeout> }

const DEFAULT_HTTP_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 350;

function defaultSections(spec: TrackSpec): TrackSection[] {
  const intro = Math.max(8_000, Math.round(spec.durationMs * 0.12));
  const outro = Math.max(10_000, Math.round(spec.durationMs * 0.14));
  const middle = Math.max(8_000, spec.durationMs - intro - outro);
  return [
    { name: "Intro", durationMs: intro, description: "Establish the original hook quickly, with room for a radio link and a smooth entrance.", transitionFriendly: true },
    { name: "Development", durationMs: middle, description: "Develop the hook through a coherent full arrangement with purposeful musical changes." },
    { name: "Outro", durationMs: outro, description: "Resolve the phrase, reduce density, and end cleanly without silence.", transitionFriendly: true }
  ];
}

function normalizedSections(spec: TrackSpec): TrackSection[] {
  const source = spec.sections?.length ? spec.sections : defaultSections(spec);
  const total = source.reduce((sum, section) => sum + section.durationMs, 0);
  if (total <= 0) return defaultSections(spec);
  let used = 0;
  return source.map((section, index) => {
    const durationMs = index === source.length - 1
      ? Math.max(1_000, spec.durationMs - used)
      : Math.max(1_000, Math.round((section.durationMs / total) * spec.durationMs));
    used += durationMs;
    return { ...section, durationMs };
  });
}

function isInstrumental(spec: TrackSpec): boolean {
  const vocals = spec.vocals?.trim();
  return !vocals || /instrumental|no vocals/i.test(vocals);
}

function isDryStationId(spec: TrackSpec): boolean {
  return spec.styles.some((style) => /dry station id|dry spoken ident/i.test(style));
}

function chunkText(spec: TrackSpec, section: TrackSection): string {
  const heading = `[${section.name}]`;
  if (isInstrumental(spec)) return `${heading}\n{instrumental, no vocals}`;
  const lyrics = section.lyrics?.trim();
  return lyrics ? `${heading}\n${lyrics}` : heading;
}

function vocalStyles(spec: TrackSpec): string[] {
  if (isInstrumental(spec)) return ["instrumental", "no lead vocals", "no backing vocals", "no spoken words"];
  if (isDryStationId(spec)) return ["isolated dry spoken station ident", `professional radio voice: ${spec.vocals}`, "no singing", "no music or effects"];
  return [
    `original vocals: ${spec.vocals}`,
    `vocal language: ${spec.language ?? "appropriate to the musical direction"}`
  ];
}

function negativeStyles(spec: TrackSpec): string[] {
  if (isDryStationId(spec)) return ["music", "melody", "singing", "drums", "bass", "synthesizer", "reverb", "delay", "ambience", "sound effects", "long silence"];
  return [
    ...(isInstrumental(spec) ? ["lead vocals", "backing vocals", "spoken words"] : ["spoken-word narration"]),
    "long silence",
    "abrupt truncation"
  ];
}

function trackPlan(spec: TrackSpec): { chunks: CompositionChunk[] } {
  return {
    chunks: normalizedSections(spec).map((section) => ({
      text: chunkText(spec, section),
      duration_ms: section.durationMs,
      positive_styles: [
        ...spec.styles,
        ...spec.mood,
        `${Math.round(spec.bpm)} BPM`,
        spec.key,
        `original concept titled "${spec.title}"`,
        spec.description,
        section.description,
        ...(spec.editorialNotes ?? []),
        ...vocalStyles(spec),
        "original composition",
        "coherent arrangement",
        "radio-ready production",
        section.transitionFriendly ? "smooth section boundary" : "purposeful musical development"
      ],
      negative_styles: negativeStyles(spec),
      context_adherence: "high"
    }))
  };
}

function transitionPlan(spec: TransitionSpec): { chunks: CompositionChunk[] } {
  const departure = Math.round(spec.durationMs * 0.28);
  const arrival = Math.round(spec.durationMs * 0.32);
  const morph = spec.durationMs - departure - arrival;
  const common = ["instrumental radio bed", "polished production", "coherent harmonic movement", `${Math.round(spec.bpm)} BPM`];
  const negative = ["lead vocals", "backing vocals", "spoken words", "abrupt edit", "hard stop", "silence", "sound effects montage"];
  return {
    chunks: [
      {
        text: "[Departure]\n{instrumental transition}",
        duration_ms: departure,
        positive_styles: [
          ...common,
          ...spec.styles.slice(0, 3),
          `begin inside this musical world: ${spec.sourceSummary}`,
          spec.description,
          "reduce melodic density early",
          "stable departure groove",
          "space for DJ speech"
        ],
        negative_styles: negative,
        context_adherence: "high"
      },
      {
        text: "[Transformation]\n{instrumental transition}",
        duration_ms: morph,
        positive_styles: [
          ...common,
          ...spec.mood,
          `gradually transform from ${spec.sourceSummary}`,
          `move toward ${spec.destinationSummary}`,
          "gradual timbral transformation",
          "DJ-friendly transition"
        ],
        negative_styles: negative,
        context_adherence: "high"
      },
      {
        text: "[Arrival]\n{instrumental transition}",
        duration_ms: arrival,
        positive_styles: [
          ...common,
          ...spec.styles.slice(-3),
          `arrive clearly in this destination: ${spec.destinationSummary}`,
          "stable continuing phrase",
          "clear destination identity",
          "crossfade-ready ending"
        ],
        negative_styles: negative,
        context_adherence: "high"
      }
    ]
  };
}

async function errorPayload(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 12_000);
  try { return JSON.stringify(JSON.parse(text)) } catch { return text }
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Eleven Music request cancelled."));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function wantsDetailedStream(spec: TrackSpec): boolean {
  return process.env.ELEVENLABS_MUSIC_DETAILED_STREAM !== "false"
    && !isInstrumental(spec)
    && Boolean(spec.sections?.some((section) => section.lyrics?.trim()));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function timestampsFrom(value: unknown): MusicWordTimestamp[] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const candidate = record.words_timestamps ?? record.word_timestamps ?? record.wordsTimestamps;
  if (Array.isArray(candidate)) {
    const timestamps = candidate.flatMap((entry) => {
      const timestamp = asRecord(entry);
      const word = timestamp?.word;
      const startMs = timestamp?.start_ms ?? timestamp?.startMs;
      const endMs = timestamp?.end_ms ?? timestamp?.endMs;
      return typeof word === "string" && Number.isFinite(startMs) && Number.isFinite(endMs)
        ? [{ word, startMs: Number(startMs), endMs: Number(endMs) }]
        : [];
    });
    if (timestamps.length) return timestamps;
  }
  for (const nested of [record.data, record.metadata, record.song_metadata]) {
    const timestamps = timestampsFrom(nested);
    if (timestamps?.length) return timestamps;
  }
  return undefined;
}

function audioBase64From(value: unknown, eventType: string): string | undefined {
  if (typeof value === "string") return /audio[_-]?chunk/i.test(eventType) ? value : undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["audio", "audio_chunk", "audio_base64", "audioChunk"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  if (/audio[_-]?chunk/i.test(String(record.type ?? record.event ?? eventType)) && typeof record.data === "string") {
    return record.data;
  }
  for (const nested of [record.data, record.payload]) {
    const audio = audioBase64From(nested, String(record.type ?? record.event ?? eventType));
    if (audio) return audio;
  }
  return undefined;
}

function detailedPayload(text: string, eventType: string): { audio?: Uint8Array; metadata?: MusicStreamMetadata } {
  let value: unknown = text.trim();
  if (!value) return {};
  for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
    try { value = JSON.parse(value) as unknown } catch { break }
  }
  const encodedAudio = audioBase64From(value, eventType);
  const wordTimestamps = timestampsFrom(value);
  return {
    audio: encodedAudio ? Buffer.from(encodedAudio, "base64") : undefined,
    metadata: wordTimestamps?.length ? { wordTimestamps } : undefined
  };
}

export async function* detailedResponseBytes(
  body: ReadableStream<Uint8Array>,
  onMetadata: (metadata: MusicStreamMetadata) => void,
  onFinished: () => void
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let eventType = "";
  let dataLines: string[] = [];

  const parse = (text: string, type: string): Uint8Array | undefined => {
    const payload = detailedPayload(text, type);
    if (payload.metadata) onMetadata(payload.metadata);
    return payload.audio;
  };
  const flushEvent = (): Uint8Array | undefined => {
    const audio = dataLines.length ? parse(dataLines.join("\n"), eventType) : undefined;
    dataLines = [];
    eventType = "";
    return audio;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          const audio = flushEvent();
          if (audio?.byteLength) yield audio;
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        } else if (!line.startsWith(":")) {
          const audio = parse(line, "");
          if (audio?.byteLength) yield audio;
        }
      }
      if (done) {
        if (buffered.trim()) {
          const audio = parse(buffered, eventType);
          if (audio?.byteLength) yield audio;
        }
        const audio = flushEvent();
        if (audio?.byteLength) yield audio;
        return;
      }
    }
  } finally {
    reader.releaseLock();
    onFinished();
  }
}

export class ElevenMusicApiProvider implements MusicProvider, TransitionProvider {
  private readonly active = new Map<string, ActiveRequest>();

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io"
  ) {}

  generate(spec: TrackSpec, _generationRate: number): Promise<MusicStream>;
  generate(spec: TransitionSpec, _generationRate: number): Promise<MusicStream>;
  async generate(spec: TrackSpec | TransitionSpec, _generationRate: number): Promise<MusicStream> {
    await this.cancel(spec.id);
    const controller = new AbortController();
    const isTransition = "instrumental" in spec;
    const detailed = !isTransition && wantsDetailedStream(spec);
    const timeout = setTimeout(() => controller.abort(new Error("Eleven Music did not finish within the configured timeout.")), Number(process.env.ELEVENLABS_MUSIC_TIMEOUT_MS ?? 240_000));
    const active: ActiveRequest = { controller, timeout };
    this.active.set(spec.id, active);
    let response: Response | undefined;
    let rejectedMessage: string | undefined;
    const maximumAttempts = nonNegativeInteger(process.env.ELEVENLABS_MUSIC_HTTP_RETRIES, DEFAULT_HTTP_RETRIES) + 1;
    const retryDelayMs = nonNegativeInteger(process.env.ELEVENLABS_MUSIC_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS);
    try {
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        try {
          response = await fetch(`${this.baseUrl}/v1/music/${detailed ? "detailed/stream" : "stream"}?output_format=mp3_48000_128`, {
            method: "POST",
            headers: { "accept": detailed ? "text/event-stream" : "audio/mpeg", "content-type": "application/json", "xi-api-key": this.apiKey },
            body: JSON.stringify({
              model_id: process.env.ELEVENLABS_MUSIC_MODEL ?? "music_v2",
              composition_plan: isTransition ? transitionPlan(spec) : trackPlan(spec),
              store_for_inpainting: false,
              ...(detailed ? { with_timestamps: true, with_waveform_visual: false } : {})
            }),
            signal: controller.signal
          });
        } catch (error) {
          if (controller.signal.aborted || attempt === maximumAttempts) throw error;
          await waitForRetry(retryDelayMs * attempt, controller.signal);
          continue;
        }
        if (response.ok) break;
        const payload = await errorPayload(response);
        rejectedMessage = `Eleven Music rejected ${isTransition ? "transition" : "track"} ${spec.id} with HTTP ${response.status}: ${payload}`;
        if (!retryableStatus(response.status) || attempt === maximumAttempts) break;
        await waitForRetry(retryDelayMs * attempt, controller.signal);
      }
    } catch (error) {
      clearTimeout(timeout);
      this.active.delete(spec.id);
      throw error;
    }
    if (!response?.ok) {
      clearTimeout(timeout);
      this.active.delete(spec.id);
      throw new Error(rejectedMessage ?? `Eleven Music did not return a usable response after ${maximumAttempts} attempts.`);
    }
    if (!response.body) {
      clearTimeout(timeout);
      this.active.delete(spec.id);
      throw new Error("Eleven Music returned no audio body.");
    }
    const finish = (): void => {
      clearTimeout(timeout);
      if (this.active.get(spec.id) === active) this.active.delete(spec.id);
    };
    const metadataListeners = new Set<(metadata: MusicStreamMetadata) => void>();
    const emitMetadata = (metadata: MusicStreamMetadata): void => {
      for (const listener of metadataListeners) listener(metadata);
    };
    return {
      id: spec.id,
      encoding: "mp3",
      sampleRate: 48_000,
      channels: 2,
      durationMs: spec.durationMs,
      chunks: detailed ? detailedResponseBytes(response.body, emitMetadata, finish) : responseBytes(response.body, finish),
      subscribeMetadata: detailed
        ? (listener) => {
            metadataListeners.add(listener);
            return () => metadataListeners.delete(listener);
          }
        : undefined
    };
  }

  async cancel(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    clearTimeout(active.timeout);
    active.controller.abort();
  }
}

export class MockElevenMusicProvider implements MusicProvider, TransitionProvider {
  private readonly controls = new Map<string, StreamControl>();

  async generate(spec: TrackSpec | TransitionSpec, generationRate: number): Promise<MusicStream> {
    const control: StreamControl = {
      cancelled: false,
      parameters: {
        kind: "music",
        bpm: spec.bpm,
        energy: spec.energy,
        seed: fixtureSeed(`${spec.id}:${spec.description}`)
      },
      startupLatencyMs: Number(process.env.MOCK_MUSIC_STARTUP_MS ?? 450),
      failAfterMs: process.env.MOCK_MUSIC_FAIL_AFTER_MS ? Number(process.env.MOCK_MUSIC_FAIL_AFTER_MS) : undefined,
      starveAtMs: process.env.MOCK_MUSIC_STARVE_AT_MS ? Number(process.env.MOCK_MUSIC_STARVE_AT_MS) : undefined,
      starveForMs: process.env.MOCK_MUSIC_STARVE_FOR_MS ? Number(process.env.MOCK_MUSIC_STARVE_FOR_MS) : undefined
    };
    this.controls.set(spec.id, control);
    return {
      id: spec.id,
      encoding: "pcm-f32le",
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      durationMs: spec.durationMs,
      chunks: pcmBytes(createFixtureStream(control, spec.durationMs, generationRate))
    };
  }

  async cancel(id: string): Promise<void> {
    const control = this.controls.get(id);
    if (control) control.cancelled = true;
    this.controls.delete(id);
  }
}

export type ElevenMusicProvider = MusicProvider;
