import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { resolveFfmpegExecutable } from "../providers/incremental-audio";

type ProfileMode = "access" | "stream" | "detailed" | "bridge" | "transition" | "handoff" | "concurrent-inpaint";
type JsonRecord = Record<string, unknown>;

interface AudioArrival {
  atMs: number;
  bytes: number;
}

interface StreamResult {
  label: string;
  outputFormat: string;
  requestedAudioMs: number;
  songId: string | null;
  responseOpenedMs: number;
  firstEncodedAudioMs: number | null;
  firstPlayablePcmMs: number | null;
  wallTimeMs: number;
  encodedChunks: number;
  encodedBytes: number;
  pcmChunks: number;
  playableAudioMs: number;
  generationRateVsRealtime: number;
  safeStartLatencyMs: number | null;
  safeStartBufferMs: number | null;
  pcmInterarrivalP50Ms: number | null;
  pcmInterarrivalP95Ms: number | null;
  pcmInterarrivalMaxMs: number | null;
  assumedChannels: number;
  inferredChannels: number | null;
  audioPath?: string;
}

interface MusicRequest {
  prompt?: string;
  composition_plan?: CompositionPlan;
  music_length_ms?: number;
  model_id: "music_v2";
  force_instrumental?: boolean;
  store_for_inpainting?: boolean;
  with_timestamps?: boolean;
}

interface AudioReference {
  song_id: string;
  range: {
    start_ms: number;
    end_ms: number;
  };
}

interface GenerationChunk {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles?: string[];
  context_adherence?: "low" | "medium" | "high";
  conditioning_ref?: AudioReference;
  condition_strength?: "low" | "medium" | "high" | "xhigh";
}

interface CompositionPlan {
  chunks: GenerationChunk[];
}

interface DecoderSummary {
  arrivals: AudioArrival[];
  firstAudioMs: number | null;
  chunks: number;
  bytes: number;
  channels: number;
  inferredChannels: number | null;
  sampleRate: number;
  bytesPerSample: number;
}

interface AudioProgress {
  atMs: number;
  playableAudioMs: number;
}

const DEFAULT_PROMPT =
  "Instrumental nocturnal melodic electronic music, warm analogue synthesizers, restrained breakbeat drums, a memorable original motif, polished radio production, no spoken words, and a clean ending.";
const DEFAULT_DESTINATION =
  "buoyant psychedelic soul-funk with elastic bass, hand percussion, radiant analogue keys, and playful instrumental hooks";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function integerArgument(name: string, fallback: number): number {
  const raw = argument(name, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(sorted.length - 1, index)] ?? null;
}

function intervals(arrivals: AudioArrival[]): number[] {
  return arrivals.slice(1).map((arrival, index) => arrival.atMs - arrivals[index]!.atMs);
}

function earliestSafeStart(
  arrivals: AudioArrival[],
  bytesToAudioMs: (bytes: number) => number
): { latencyMs: number; bufferMs: number } | null {
  if (!arrivals.length) return null;
  const cumulative = arrivals.reduce<number[]>((values, arrival) => {
    values.push((values.at(-1) ?? 0) + bytesToAudioMs(arrival.bytes));
    return values;
  }, []);

  for (let startIndex = 0; startIndex < arrivals.length; startIndex += 1) {
    const startedAt = arrivals[startIndex]!.atMs;
    let safe = true;
    for (let nextIndex = startIndex + 1; nextIndex < arrivals.length; nextIndex += 1) {
      const playbackElapsed = arrivals[nextIndex]!.atMs - startedAt;
      if (playbackElapsed > cumulative[nextIndex - 1]!) {
        safe = false;
        break;
      }
    }
    if (safe) return { latencyMs: startedAt, bufferMs: cumulative[startIndex]! };
  }
  return null;
}

class ProfileLogger {
  readonly path: string;

  constructor(mode: ProfileMode) {
    const directory = resolve(process.cwd(), "../../logs");
    mkdirSync(directory, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    this.path = resolve(directory, `eleven-music-${mode}-${timestamp}.ndjson`);
    writeFileSync(this.path, "", "utf8");
  }

  write(type: string, data: JsonRecord = {}): void {
    const record = { at: new Date().toISOString(), type, ...data };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  audioPath(label: string, outputFormat: string): string {
    const extension = outputFormat.startsWith("mp3_") ? "mp3" : outputFormat.startsWith("opus_") ? "opus" : "pcm";
    return this.path.replace(/\.ndjson$/, `-${label}.${extension}`);
  }
}

class MusicApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown
  ) {
    super(`Eleven Music returned HTTP ${status}.`);
    this.name = "MusicApiError";
  }
}

function errorSummary(error: unknown): JsonRecord {
  if (error instanceof MusicApiError) {
    return { name: error.name, status: error.status, payload: error.payload };
  }
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}

async function readError(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 20_000);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class IncrementalAudioDecoder {
  private readonly encodedArrivals: AudioArrival[] = [];
  private readonly pcmArrivals: AudioArrival[] = [];
  private readonly processHandle: ChildProcessWithoutNullStreams | null;
  private readonly errors: Buffer[] = [];
  private readonly sampleRate: number;
  private readonly bytesPerSample: number;
  private readonly provisionalChannels: number;
  private firstAudioMs: number | null = null;
  private onProgress?: (progress: AudioProgress) => void;

  constructor(
    private readonly outputFormat: string,
    private readonly startedAt: number,
    assumedChannels: number,
    onProgress?: (progress: AudioProgress) => void
  ) {
    const pcmMatch = /^pcm_(\d+)$/.exec(outputFormat);
    this.sampleRate = pcmMatch ? Number(pcmMatch[1]) : 48_000;
    this.bytesPerSample = pcmMatch ? 2 : 4;
    this.provisionalChannels = pcmMatch ? assumedChannels : 2;
    this.onProgress = onProgress;
    if (pcmMatch) {
      this.processHandle = null;
      return;
    }

    this.processHandle = spawn(resolveFfmpegExecutable(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "f32le",
      "-ac",
      "2",
      "-ar",
      "48000",
      "pipe:1"
    ]);
    this.processHandle.stdout.on("data", (chunk: Buffer) => this.acceptPcm(chunk));
    this.processHandle.stderr.on("data", (chunk: Buffer) => this.errors.push(chunk));
  }

  async push(chunk: Uint8Array): Promise<void> {
    const buffer = Buffer.from(chunk);
    this.encodedArrivals.push({ atMs: performance.now() - this.startedAt, bytes: buffer.length });
    if (!this.processHandle) {
      this.acceptPcm(buffer);
      return;
    }
    if (!this.processHandle.stdin.write(buffer)) await once(this.processHandle.stdin, "drain");
  }

  async finish(requestedAudioMs: number): Promise<DecoderSummary> {
    if (this.processHandle) {
      this.processHandle.stdin.end();
      const [code] = (await once(this.processHandle, "close")) as [number | null];
      if (code !== 0) {
        throw new Error(`Incremental audio decode failed: ${Buffer.concat(this.errors).toString("utf8").trim()}`);
      }
    }

    const rawPcm = /^pcm_/.test(this.outputFormat);
    const totalBytes = this.pcmArrivals.reduce((total, arrival) => total + arrival.bytes, 0);
    let inferredChannels: number | null = null;
    let channels = this.provisionalChannels;
    if (rawPcm && requestedAudioMs > 0) {
      const candidates = [1, 2].map((candidate) => ({
        candidate,
        difference: Math.abs((totalBytes / (this.sampleRate * candidate * this.bytesPerSample)) * 1_000 - requestedAudioMs)
      }));
      inferredChannels = candidates.sort((left, right) => left.difference - right.difference)[0]!.candidate;
      channels = inferredChannels;
    }
    return {
      arrivals: this.pcmArrivals,
      firstAudioMs: this.firstAudioMs,
      chunks: this.pcmArrivals.length,
      bytes: totalBytes,
      channels,
      inferredChannels,
      sampleRate: this.sampleRate,
      bytesPerSample: this.bytesPerSample
    };
  }

  encodedSummary(): { arrivals: AudioArrival[]; chunks: number; bytes: number } {
    return {
      arrivals: this.encodedArrivals,
      chunks: this.encodedArrivals.length,
      bytes: this.encodedArrivals.reduce((total, arrival) => total + arrival.bytes, 0)
    };
  }

  private acceptPcm(chunk: Buffer): void {
    const atMs = performance.now() - this.startedAt;
    this.firstAudioMs ??= atMs;
    this.pcmArrivals.push({ atMs, bytes: chunk.length });
    const playableAudioMs = this.pcmArrivals.reduce(
      (total, arrival) => total + (arrival.bytes / (this.sampleRate * this.provisionalChannels * this.bytesPerSample)) * 1_000,
      0
    );
    this.onProgress?.({ atMs, playableAudioMs });
  }
}

function summarizeStream(
  label: string,
  outputFormat: string,
  requestedAudioMs: number,
  responseOpenedMs: number,
  songId: string | null,
  wallTimeMs: number,
  decoder: DecoderSummary,
  encoded: { arrivals: AudioArrival[]; chunks: number; bytes: number }
): StreamResult {
  const bytesToAudioMs = (bytes: number): number =>
    (bytes / (decoder.sampleRate * decoder.channels * decoder.bytesPerSample)) * 1_000;
  const playableAudioMs = bytesToAudioMs(decoder.bytes);
  const safeStart = earliestSafeStart(decoder.arrivals, bytesToAudioMs);
  const interarrival = intervals(decoder.arrivals);
  return {
    label,
    outputFormat,
    requestedAudioMs,
    songId,
    responseOpenedMs: round(responseOpenedMs),
    firstEncodedAudioMs: encoded.arrivals[0] ? round(encoded.arrivals[0].atMs) : null,
    firstPlayablePcmMs: decoder.firstAudioMs === null ? null : round(decoder.firstAudioMs),
    wallTimeMs: round(wallTimeMs),
    encodedChunks: encoded.chunks,
    encodedBytes: encoded.bytes,
    pcmChunks: decoder.chunks,
    playableAudioMs: round(playableAudioMs),
    generationRateVsRealtime: round(playableAudioMs / wallTimeMs, 3),
    safeStartLatencyMs: safeStart ? round(safeStart.latencyMs) : null,
    safeStartBufferMs: safeStart ? round(safeStart.bufferMs) : null,
    pcmInterarrivalP50Ms: percentile(interarrival, 0.5) === null ? null : round(percentile(interarrival, 0.5)!),
    pcmInterarrivalP95Ms: percentile(interarrival, 0.95) === null ? null : round(percentile(interarrival, 0.95)!),
    pcmInterarrivalMaxMs: interarrival.length ? round(Math.max(...interarrival)) : null,
    assumedChannels: assumedPcmChannels,
    inferredChannels: decoder.inferredChannels
  };
}

async function openMusicRequest(
  path: "/v1/music/stream" | "/v1/music/detailed/stream",
  body: MusicRequest,
  outputFormat: string
): Promise<Response> {
  return fetch(`${baseUrl}${path}?output_format=${encodeURIComponent(outputFormat)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function profileRawStream(options: {
  label: string;
  request: MusicRequest;
  requestedAudioMs: number;
  outputFormat?: string;
  onProgress?: (progress: AudioProgress & { songId: string | null }) => void;
}): Promise<StreamResult> {
  const selectedFormat = options.outputFormat ?? outputFormat;
  const startedAt = performance.now();
  logger.write("request_started", {
    label: options.label,
    endpoint: "/v1/music/stream",
    outputFormat: selectedFormat,
    requestedAudioMs: options.requestedAudioMs,
    storeForInpainting: options.request.store_for_inpainting ?? false
  });
  const response = await openMusicRequest("/v1/music/stream", options.request, selectedFormat);
  const responseOpenedMs = performance.now() - startedAt;
  const songId = response.headers.get("song-id");
  logger.write("response_opened", { label: options.label, status: response.status, responseOpenedMs: round(responseOpenedMs), songId });
  if (!response.ok) throw new MusicApiError(response.status, await readError(response));
  if (!response.body) throw new Error("Eleven Music returned no response body.");

  const decoder = new IncrementalAudioDecoder(selectedFormat, startedAt, assumedPcmChannels, (progress) => {
    logger.write("pcm_chunk", { label: options.label, atMs: round(progress.atMs), playableAudioMs: round(progress.playableAudioMs) });
    options.onProgress?.({ ...progress, songId });
  });
  const savedAudio: Buffer[] = [];
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    logger.write("encoded_chunk", { label: options.label, atMs: round(performance.now() - startedAt), bytes: value.byteLength });
    if (flag("--save-audio")) savedAudio.push(Buffer.from(value));
    await decoder.push(value);
  }
  const decoded = await decoder.finish(options.requestedAudioMs);
  const result = summarizeStream(
    options.label,
    selectedFormat,
    options.requestedAudioMs,
    responseOpenedMs,
    songId,
    performance.now() - startedAt,
    decoded,
    decoder.encodedSummary()
  );
  if (savedAudio.length) {
    result.audioPath = logger.audioPath(options.label, selectedFormat);
    writeFileSync(result.audioPath, Buffer.concat(savedAudio));
  }
  logger.write("stream_completed", result as unknown as JsonRecord);
  return result;
}

function eventType(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as JsonRecord;
  for (const key of ["type", "event", "event_type", "message_type"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return fallback;
}

function collectAudioFields(value: unknown, path = "$", found: Array<{ path: string; data: string }> = []): Array<{ path: string; data: string }> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAudioFields(item, `${path}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    const childPath = `${path}.${key}`;
    if (["audio", "audio_base64", "audioBase64", "audio_data", "audioData"].includes(key) && typeof child === "string") {
      found.push({ path: childPath, data: child });
    } else {
      collectAudioFields(child, childPath, found);
    }
  }
  return found;
}

function parseDetailedLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const data = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!data || data === "[DONE]" || data.startsWith("event:") || data.startsWith("id:")) return null;
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed === "string") {
      try {
        return JSON.parse(parsed);
      } catch {
        return parsed;
      }
    }
    return parsed;
  } catch {
    return { unparsed_text_bytes: Buffer.byteLength(data) };
  }
}

async function profileDetailedStream(request: MusicRequest, requestedAudioMs: number): Promise<{ stream: StreamResult; events: JsonRecord }> {
  const label = "detailed";
  const startedAt = performance.now();
  logger.write("request_started", { label, endpoint: "/v1/music/detailed/stream", outputFormat, requestedAudioMs });
  const response = await openMusicRequest("/v1/music/detailed/stream", request, outputFormat);
  const responseOpenedMs = performance.now() - startedAt;
  const songId = response.headers.get("song-id");
  logger.write("response_opened", { label, status: response.status, responseOpenedMs: round(responseOpenedMs), songId });
  if (!response.ok) throw new MusicApiError(response.status, await readError(response));
  if (!response.body) throw new Error("Eleven Music returned no detailed response body.");

  const decoder = new IncrementalAudioDecoder(outputFormat, startedAt, assumedPcmChannels);
  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  let pending = "";
  const counts: Record<string, number> = {};
  const keyShapes = new Set<string>();
  const savedAudio: Buffer[] = [];
  let parsedEvents = 0;
  const acceptLine = async (line: string): Promise<void> => {
    const parsed = parseDetailedLine(line);
    if (parsed === null) return;
    parsedEvents += 1;
    const type = eventType(parsed, "unknown");
    counts[type] = (counts[type] ?? 0) + 1;
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed as JsonRecord).sort() : [];
    keyShapes.add(keys.join(","));
    const audioFields = collectAudioFields(parsed);
    logger.write("detailed_event", {
      atMs: round(performance.now() - startedAt),
      eventType: type,
      topLevelKeys: keys,
      audioFields: audioFields.map((field) => ({ path: field.path, encodedCharacters: field.data.length }))
    });
    for (const field of audioFields) {
      const audio = Buffer.from(field.data, "base64");
      if (flag("--save-audio")) savedAudio.push(audio);
      await decoder.push(audio);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += textDecoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) await acceptLine(line);
  }
  pending += textDecoder.decode();
  if (pending.trim()) await acceptLine(pending);
  const decoded = await decoder.finish(requestedAudioMs);
  const stream = summarizeStream(
    label,
    outputFormat,
    requestedAudioMs,
    responseOpenedMs,
    songId,
    performance.now() - startedAt,
    decoded,
    decoder.encodedSummary()
  );
  if (savedAudio.length) {
    stream.audioPath = logger.audioPath(label, outputFormat);
    writeFileSync(stream.audioPath, Buffer.concat(savedAudio));
  }
  const events = { parsedEvents, eventCounts: counts, topLevelKeyShapes: [...keyShapes] };
  logger.write("stream_completed", { ...stream, ...events });
  return { stream, events };
}

function structuredTrackPlan(durationMs: number, destination = DEFAULT_PROMPT): CompositionPlan {
  if (durationMs < 9_000) {
    return {
      chunks: [
        {
          text: `[Instrumental]\n${destination}`,
          duration_ms: durationMs,
          positive_styles: [
            "instrumental",
            "original melodic motif",
            "radio-ready production",
            "clear rhythmic pulse",
            "coherent arrangement",
            "clean mix",
            "intentional ending"
          ],
          negative_styles: ["spoken words", "abrupt truncation"],
          context_adherence: "high"
        }
      ]
    };
  }
  const introMs = Math.max(3_000, Math.round(durationMs * 0.2));
  const outroMs = Math.max(3_000, Math.round(durationMs * 0.2));
  const mainMs = durationMs - introMs - outroMs;
  return {
    chunks: [
      {
        text: `[Instrumental intro]\n${destination}\nEstablish an immediately legible original motif and leave space for a radio link.`,
        duration_ms: introMs,
        positive_styles: [
          "instrumental intro",
          "original melodic motif",
          "radio-ready production",
          "clear rhythmic pulse",
          "coherent arrangement",
          "clean mix",
          "smooth section boundary"
        ],
        negative_styles: ["spoken words", "abrupt start"],
        context_adherence: "high"
      },
      {
        text: `[Main theme]\n${destination}\nDevelop the motif with purposeful changes and stable musical identity.`,
        duration_ms: mainMs,
        positive_styles: ["developing arrangement", "memorable motif", "dynamic but coherent"],
        negative_styles: ["spoken words"],
        context_adherence: "high"
      },
      {
        text: `[Transition-ready outro]\nResolve the current phrase, reduce density, and finish cleanly without a long silence.`,
        duration_ms: outroMs,
        positive_styles: ["clean outro", "reduced density", "DJ-friendly transition point"],
        negative_styles: ["spoken words", "abrupt truncation", "long silence"],
        context_adherence: "high"
      }
    ]
  };
}

function transitionPlan(songId: string, startMs: number, endMs: number, durationMs: number, destination: string): CompositionPlan {
  if (endMs <= startMs) throw new Error("The conditioning range must end after it starts.");
  if (endMs - startMs > 30_000) throw new Error("Eleven Music conditioning references are limited to 30 seconds.");
  return {
    chunks: [
      {
        text:
          `[Instrumental transition]\nBegin as a natural continuation of the conditioned track. Remove any lead vocal early, preserve musical continuity, then gradually transform toward ${destination}. ` +
          "Reach the destination identity by the final third and end on a stable phrase that can crossfade into the destination track.",
        duration_ms: durationMs,
        positive_styles: [
          "seamless musical continuity",
          "instrumental radio bed",
          "gradual timbral transformation",
          "coherent harmonic movement",
          "DJ-friendly transition",
          "clear destination identity",
          "polished production"
        ],
        negative_styles: ["lead vocals", "spoken words", "abrupt edit", "hard stop", "silence", "sound effects montage"],
        context_adherence: "high",
        conditioning_ref: {
          song_id: songId,
          range: { start_ms: startMs, end_ms: endMs }
        },
        condition_strength: "high"
      }
    ]
  };
}

function unconditionedBridgePlan(durationMs: number, destination: string): CompositionPlan {
  return {
    chunks: [
      {
        text:
          `[Instrumental radio transition]\nCreate a self-contained musical bridge that begins neutral, spacious, and rhythmically stable. Gradually transform toward ${destination}. ` +
          "Reach the destination identity by the final third and end on a stable phrase for a clean crossfade into the next track.",
        duration_ms: durationMs,
        positive_styles: [
          "instrumental radio bed",
          "gradual timbral transformation",
          "coherent harmonic movement",
          "steady rhythmic pulse",
          "DJ-friendly transition",
          "clear destination identity",
          "polished production"
        ],
        negative_styles: ["lead vocals", "spoken words", "abrupt edit", "hard stop", "silence", "sound effects montage"],
        context_adherence: "high"
      }
    ]
  };
}

async function checkAccess(): Promise<JsonRecord> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/v1/music/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({ prompt: DEFAULT_PROMPT, music_length_ms: 30_000, model_id: "music_v2" }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const payload = await readError(response);
  const result = {
    available: response.ok,
    status: response.status,
    wallTimeMs: round(performance.now() - startedAt),
    ...(response.ok ? { plan: payload } : { error: payload })
  };
  logger.write("access_checked", result);
  return result;
}

function requirePaidConfirmation(): void {
  if (!flag("--confirm-cost")) {
    throw new Error(`Mode ${mode} creates chargeable music. Re-run with --confirm-cost after checking the requested duration and mode.`);
  }
}

if (flag("--help")) {
  process.stdout.write(`Eleven Music profiler\n\nModes:\n  access               Check Music v2 API access without generating audio.\n  stream               Profile one structured track.\n  detailed             Inspect detailed-stream event framing and audio delivery.\n  bridge               Profile an unconditioned prompt-only transition bed.\n  transition           Profile a conditioned bridge from --source-song-id.\n  handoff               Generate a conditioned bridge and destination track concurrently.\n  concurrent-inpaint   Attempt conditioning while the stored source is still generating.\n\nChargeable modes require --confirm-cost. Add --save-audio to retain the encoded output under logs/.\nCommon options: --duration-seconds, --transition-seconds, --output-format, --destination, --timeout-ms.\n`);
  process.exit(0);
}

const mode = (argument("--mode", "access") ?? "access") as ProfileMode;
if (!["access", "stream", "detailed", "bridge", "transition", "handoff", "concurrent-inpaint"].includes(mode)) {
  throw new Error(`Unknown --mode: ${mode}`);
}
const configuredApiKey = process.env.ELEVENLABS_API_KEY;
if (!configuredApiKey) throw new Error("ELEVENLABS_API_KEY is missing. Load the workspace .env file before profiling.");
const apiKey: string = configuredApiKey;
const baseUrl = (process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io").replace(/\/$/, "");
const outputFormat = argument("--output-format", "mp3_48000_128")!;
const assumedPcmChannels = integerArgument("--pcm-channels", 2);
const timeoutMs = integerArgument("--timeout-ms", 600_000);
const durationMs = integerArgument("--duration-seconds", 30) * 1_000;
const transitionDurationMs = integerArgument("--transition-seconds", 30) * 1_000;
const destination = argument("--destination", DEFAULT_DESTINATION)!;
const logger = new ProfileLogger(mode);

logger.write("profile_started", {
  mode,
  outputFormat,
  durationMs,
  transitionDurationMs,
  logPath: logger.path
});

try {
  let result: unknown;
  if (mode === "access") {
    result = await checkAccess();
  } else if (mode === "stream") {
    requirePaidConfirmation();
    result = await profileRawStream({
      label: "track",
      requestedAudioMs: durationMs,
      request: {
        model_id: "music_v2",
        composition_plan: structuredTrackPlan(durationMs),
        store_for_inpainting: flag("--store-for-inpainting")
      }
    });
  } else if (mode === "detailed") {
    requirePaidConfirmation();
    result = await profileDetailedStream(
      {
        model_id: "music_v2",
        composition_plan: structuredTrackPlan(durationMs),
        store_for_inpainting: flag("--store-for-inpainting"),
        with_timestamps: flag("--with-timestamps")
      },
      durationMs
    );
  } else if (mode === "bridge") {
    requirePaidConfirmation();
    result = await profileRawStream({
      label: "unconditioned-bridge",
      requestedAudioMs: transitionDurationMs,
      request: {
        model_id: "music_v2",
        composition_plan: unconditionedBridgePlan(transitionDurationMs, destination)
      }
    });
  } else if (mode === "transition") {
    requirePaidConfirmation();
    const songId = argument("--source-song-id");
    if (!songId) throw new Error("--source-song-id is required for transition mode.");
    const startMs = integerArgument("--source-start-ms", 0);
    const endMs = integerArgument("--source-end-ms", 30_000);
    result = await profileRawStream({
      label: "transition",
      requestedAudioMs: transitionDurationMs,
      request: {
        model_id: "music_v2",
        composition_plan: transitionPlan(songId, startMs, endMs, transitionDurationMs, destination)
      }
    });
  } else if (mode === "handoff") {
    requirePaidConfirmation();
    const songId = argument("--source-song-id");
    if (!songId) throw new Error("--source-song-id is required for handoff mode.");
    const startMs = integerArgument("--source-start-ms", 0);
    const endMs = integerArgument("--source-end-ms", 30_000);
    const [transition, track] = await Promise.all([
      profileRawStream({
        label: "transition",
        requestedAudioMs: transitionDurationMs,
        request: {
          model_id: "music_v2",
          composition_plan: transitionPlan(songId, startMs, endMs, transitionDurationMs, destination)
        }
      }),
      profileRawStream({
        label: "destination-track",
        requestedAudioMs: durationMs,
        request: {
          model_id: "music_v2",
          composition_plan: structuredTrackPlan(durationMs, destination),
          store_for_inpainting: true
        }
      })
    ]);
    result = { transition, track };
  } else {
    requirePaidConfirmation();
    const triggerAudioMs = integerArgument("--trigger-after-audio-seconds", 20) * 1_000;
    const conditionMs = Math.min(30_000, integerArgument("--condition-seconds", 20) * 1_000);
    let transitionPromise: Promise<StreamResult> | null = null;
    let triggerAtMs: number | null = null;
    const source = await profileRawStream({
      label: "still-generating-source",
      requestedAudioMs: durationMs,
      request: {
        model_id: "music_v2",
        composition_plan: structuredTrackPlan(durationMs),
        store_for_inpainting: true
      },
      onProgress: ({ playableAudioMs, atMs, songId }) => {
        if (transitionPromise || playableAudioMs < triggerAudioMs || !songId) return;
        triggerAtMs = atMs;
        const endMs = Math.floor(Math.min(playableAudioMs, triggerAudioMs));
        const startMs = Math.max(0, endMs - conditionMs);
        logger.write("concurrent_inpaint_triggered", { atMs: round(atMs), songId, startMs, endMs });
        transitionPromise = profileRawStream({
          label: "concurrent-transition",
          requestedAudioMs: transitionDurationMs,
          request: {
            model_id: "music_v2",
            composition_plan: transitionPlan(songId, startMs, endMs, transitionDurationMs, destination)
          }
        });
      }
    });
    const transition = transitionPromise ? await transitionPromise : null;
    result = { triggerAtMs, source, transition };
  }

  logger.write("profile_completed", { result });
  process.stdout.write(`${JSON.stringify({ profiledAt: new Date().toISOString(), mode, logPath: logger.path, result }, null, 2)}\n`);
} catch (error) {
  const summary = errorSummary(error);
  logger.write("profile_failed", summary);
  process.stderr.write(`${JSON.stringify({ mode, logPath: logger.path, error: summary }, null, 2)}\n`);
  process.exitCode = 1;
}
