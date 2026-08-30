import { GoogleGenAI } from "@google/genai";

type Endpoint =
  | "interactions-stream"
  | "interactions-batch"
  | "generate-content-stream"
  | "generate-content-batch";

interface TestCase {
  name: "short" | "medium";
  text: string;
}

interface AudioArrival {
  atMs: number;
  audioMs: number;
  bytes: number;
}

interface SuccessfulRun {
  status: "ok";
  endpoint: Endpoint;
  caseName: TestCase["name"];
  iteration: number;
  warmup: boolean;
  characters: number;
  words: number;
  responseOpenedMs: number;
  firstAudioMs: number;
  lastAudioMs: number;
  wallTimeMs: number;
  audioDurationMs: number;
  overallRate: number;
  steadyRate: number | null;
  chunks: number;
  bytes: number;
  chunkAudioP50Ms: number;
  chunkAudioP95Ms: number;
  interarrivalP50Ms: number | null;
  interarrivalP95Ms: number | null;
  interarrivalMaxMs: number | null;
  safeStartLatencyMs: number;
  safeStartBufferMs: number;
}

interface FailedRun {
  status: "failed";
  endpoint: Endpoint;
  caseName: TestCase["name"];
  iteration: number;
  warmup: boolean;
  characters: number;
  words: number;
  wallTimeMs: number;
  error: string;
}

type BenchmarkRun = SuccessfulRun | FailedRun;

interface Aggregate {
  endpoint: Endpoint;
  caseName: TestCase["name"];
  successfulRuns: number;
  failedRuns: number;
  firstAudioP50Ms: number | null;
  firstAudioP95Ms: number | null;
  wallTimeP50Ms: number | null;
  overallRateP50: number | null;
  overallRateP05: number | null;
  steadyRateP50: number | null;
  safeStartLatencyP50Ms: number | null;
  safeStartLatencyP95Ms: number | null;
  safeStartBufferP50Ms: number | null;
  safeStartBufferP95Ms: number | null;
}

const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const TEST_CASES: TestCase[] = [
  {
    name: "short",
    text: "Robot Radio Infinity. Stay with us."
  },
  {
    name: "medium",
    text: "You are listening to Robot Radio Infinity. The next signal is already forming."
  }
];

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.min(sorted.length - 1, index)] ?? null;
}

function audioDurationMs(bytes: number, sampleRate = SAMPLE_RATE, channels = CHANNELS): number {
  return (bytes / (sampleRate * channels * BYTES_PER_SAMPLE)) * 1_000;
}

function earliestSafeStart(arrivals: AudioArrival[], wallTimeMs: number): { latencyMs: number; bufferMs: number } {
  if (!arrivals.length) return { latencyMs: wallTimeMs, bufferMs: 0 };
  const cumulative: number[] = [];
  let total = 0;
  for (const arrival of arrivals) {
    total += arrival.audioMs;
    cumulative.push(total);
  }

  for (let startIndex = 0; startIndex < arrivals.length; startIndex += 1) {
    const startedAt = arrivals[startIndex]!.atMs;
    let safe = true;
    for (let nextIndex = startIndex + 1; nextIndex < arrivals.length; nextIndex += 1) {
      const playbackElapsed = arrivals[nextIndex]!.atMs - startedAt;
      const audioAvailableBeforeArrival = cumulative[nextIndex - 1]!;
      if (playbackElapsed > audioAvailableBeforeArrival) {
        safe = false;
        break;
      }
    }
    if (safe) return { latencyMs: startedAt, bufferMs: cumulative[startIndex]! };
  }
  return { latencyMs: wallTimeMs, bufferMs: total };
}

function promptFor(text: string): string {
  return `Read this exactly as a concise, warm radio DJ:\n${text}`;
}

async function collectInteractions(client: GoogleGenAI, model: string, voice: string, prompt: string): Promise<{
  responseOpenedMs: number;
  wallTimeMs: number;
  arrivals: AudioArrival[];
}> {
  const startedAt = performance.now();
  const stream = await client.interactions.create(
    {
      model,
      input: prompt,
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
      store: false,
      stream: true
    },
    { timeout: Number(process.env.GEMINI_TTS_TIMEOUT_MS ?? 120_000) }
  );
  const responseOpenedMs = performance.now() - startedAt;
  const arrivals: AudioArrival[] = [];
  for await (const event of stream) {
    if (event.event_type !== "step.delta" || event.delta.type !== "audio" || !event.delta.data) continue;
    const bytes = Buffer.from(event.delta.data, "base64").length;
    arrivals.push({
      atMs: performance.now() - startedAt,
      audioMs: audioDurationMs(bytes, event.delta.sample_rate ?? SAMPLE_RATE, event.delta.channels ?? CHANNELS),
      bytes
    });
  }
  return { responseOpenedMs, wallTimeMs: performance.now() - startedAt, arrivals };
}

async function collectInteractionsBatch(client: GoogleGenAI, model: string, voice: string, prompt: string): Promise<{
  responseOpenedMs: number;
  wallTimeMs: number;
  arrivals: AudioArrival[];
}> {
  const startedAt = performance.now();
  const interaction = await client.interactions.create(
    {
      model,
      input: prompt,
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
      store: false
    },
    { timeout: Number(process.env.GEMINI_TTS_TIMEOUT_MS ?? 120_000) }
  );
  const completedAt = performance.now() - startedAt;
  const data = interaction.output_audio?.data;
  const arrivals: AudioArrival[] = [];
  if (data) {
    const bytes = Buffer.from(data, "base64").length;
    arrivals.push({ atMs: completedAt, audioMs: audioDurationMs(bytes), bytes });
  }
  return { responseOpenedMs: completedAt, wallTimeMs: performance.now() - startedAt, arrivals };
}

async function collectGenerateContent(client: GoogleGenAI, model: string, voice: string, prompt: string): Promise<{
  responseOpenedMs: number;
  wallTimeMs: number;
  arrivals: AudioArrival[];
}> {
  const startedAt = performance.now();
  const stream = await client.models.generateContentStream({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice }
        }
      },
      httpOptions: { timeout: Number(process.env.GEMINI_TTS_TIMEOUT_MS ?? 120_000) }
    }
  });
  const responseOpenedMs = performance.now() - startedAt;
  const arrivals: AudioArrival[] = [];
  for await (const chunk of stream) {
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      const bytes = Buffer.from(data, "base64").length;
      arrivals.push({ atMs: performance.now() - startedAt, audioMs: audioDurationMs(bytes), bytes });
    }
  }
  return { responseOpenedMs, wallTimeMs: performance.now() - startedAt, arrivals };
}

async function collectGenerateContentBatch(client: GoogleGenAI, model: string, voice: string, prompt: string): Promise<{
  responseOpenedMs: number;
  wallTimeMs: number;
  arrivals: AudioArrival[];
}> {
  const startedAt = performance.now();
  const response = await client.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voice }
        }
      },
      httpOptions: { timeout: Number(process.env.GEMINI_TTS_TIMEOUT_MS ?? 120_000) }
    }
  });
  const completedAt = performance.now() - startedAt;
  const arrivals: AudioArrival[] = [];
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    const data = part.inlineData?.data;
    if (!data) continue;
    const bytes = Buffer.from(data, "base64").length;
    arrivals.push({ atMs: completedAt, audioMs: audioDurationMs(bytes), bytes });
  }
  return { responseOpenedMs: completedAt, wallTimeMs: performance.now() - startedAt, arrivals };
}

async function runOnce(
  client: GoogleGenAI,
  endpoint: Endpoint,
  testCase: TestCase,
  iteration: number,
  warmup: boolean,
  model: string,
  voice: string
): Promise<BenchmarkRun> {
  const runStartedAt = performance.now();
  const words = testCase.text.trim().split(/\s+/).length;
  try {
    const prompt = promptFor(testCase.text);
    const result = endpoint === "interactions-stream"
      ? await collectInteractions(client, model, voice, prompt)
      : endpoint === "interactions-batch"
        ? await collectInteractionsBatch(client, model, voice, prompt)
        : endpoint === "generate-content-stream"
          ? await collectGenerateContent(client, model, voice, prompt)
          : await collectGenerateContentBatch(client, model, voice, prompt);
    if (!result.arrivals.length) throw new Error("The provider returned no audio chunks");
    const first = result.arrivals[0]!;
    const last = result.arrivals.at(-1)!;
    const interarrival = result.arrivals.slice(1).map((arrival, index) => arrival.atMs - result.arrivals[index]!.atMs);
    const totalAudioMs = result.arrivals.reduce((total, arrival) => total + arrival.audioMs, 0);
    const audioAfterFirstMs = totalAudioMs - first.audioMs;
    const streamSpanMs = last.atMs - first.atMs;
    const safeStart = earliestSafeStart(result.arrivals, result.wallTimeMs);
    return {
      status: "ok",
      endpoint,
      caseName: testCase.name,
      iteration,
      warmup,
      characters: testCase.text.length,
      words,
      responseOpenedMs: result.responseOpenedMs,
      firstAudioMs: first.atMs,
      lastAudioMs: last.atMs,
      wallTimeMs: result.wallTimeMs,
      audioDurationMs: totalAudioMs,
      overallRate: totalAudioMs / result.wallTimeMs,
      steadyRate: streamSpanMs > 0 ? audioAfterFirstMs / streamSpanMs : null,
      chunks: result.arrivals.length,
      bytes: result.arrivals.reduce((total, arrival) => total + arrival.bytes, 0),
      chunkAudioP50Ms: percentile(result.arrivals.map((arrival) => arrival.audioMs), 0.5)!,
      chunkAudioP95Ms: percentile(result.arrivals.map((arrival) => arrival.audioMs), 0.95)!,
      interarrivalP50Ms: percentile(interarrival, 0.5),
      interarrivalP95Ms: percentile(interarrival, 0.95),
      interarrivalMaxMs: interarrival.length ? Math.max(...interarrival) : null,
      safeStartLatencyMs: safeStart.latencyMs,
      safeStartBufferMs: safeStart.bufferMs
    };
  } catch (error) {
    return {
      status: "failed",
      endpoint,
      caseName: testCase.name,
      iteration,
      warmup,
      characters: testCase.text.length,
      words,
      wallTimeMs: performance.now() - runStartedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function aggregate(runs: BenchmarkRun[]): Aggregate[] {
  const groups = new Map<string, BenchmarkRun[]>();
  for (const run of runs.filter((candidate) => !candidate.warmup)) {
    const key = `${run.endpoint}:${run.caseName}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) => {
    const successes = group.filter((run): run is SuccessfulRun => run.status === "ok");
    const first = group[0]!;
    return {
      endpoint: first.endpoint,
      caseName: first.caseName,
      successfulRuns: successes.length,
      failedRuns: group.length - successes.length,
      firstAudioP50Ms: percentile(successes.map((run) => run.firstAudioMs), 0.5),
      firstAudioP95Ms: percentile(successes.map((run) => run.firstAudioMs), 0.95),
      wallTimeP50Ms: percentile(successes.map((run) => run.wallTimeMs), 0.5),
      overallRateP50: percentile(successes.map((run) => run.overallRate), 0.5),
      overallRateP05: percentile(successes.map((run) => run.overallRate), 0.05),
      steadyRateP50: percentile(
        successes.map((run) => run.steadyRate).filter((value): value is number => value !== null),
        0.5
      ),
      safeStartLatencyP50Ms: percentile(successes.map((run) => run.safeStartLatencyMs), 0.5),
      safeStartLatencyP95Ms: percentile(successes.map((run) => run.safeStartLatencyMs), 0.95),
      safeStartBufferP50Ms: percentile(successes.map((run) => run.safeStartBufferMs), 0.5),
      safeStartBufferP95Ms: percentile(successes.map((run) => run.safeStartBufferMs), 0.95)
    };
  });
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is missing. Load the workspace .env file before profiling.");

const repetitions = Math.max(1, Number(argument("--runs", "3")));
const warmups = Math.max(0, Number(argument("--warmups", "1")));
const model = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
const voice = process.env.GEMINI_TTS_VOICE ?? "Kore";
const client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
const runs: BenchmarkRun[] = [];

async function execute(endpoint: Endpoint, testCase: TestCase, iteration: number, warmup: boolean): Promise<void> {
  process.stderr.write(`TTS profile: ${endpoint}, ${testCase.name}, ${warmup ? "warmup" : `run ${iteration}`}\n`);
  const result = await runOnce(client, endpoint, testCase, iteration, warmup, model, voice);
  runs.push(result);
  const summary = result.status === "ok"
    ? `first=${result.firstAudioMs.toFixed(0)}ms rate=${result.overallRate.toFixed(2)}x safe=${result.safeStartLatencyMs.toFixed(0)}ms`
    : `failed=${result.error}`;
  process.stderr.write(`TTS result: ${summary}\n`);
}

for (let index = 0; index < warmups; index += 1) {
  for (const endpoint of [
    "interactions-stream",
    "interactions-batch",
    "generate-content-stream",
    "generate-content-batch"
  ] as const) {
    await execute(endpoint, TEST_CASES[0]!, index + 1, true);
  }
}

for (const testCase of TEST_CASES) {
  for (let iteration = 1; iteration <= repetitions; iteration += 1) {
    const endpoints: Endpoint[] = iteration % 2 === 0
      ? ["generate-content-batch", "generate-content-stream", "interactions-batch", "interactions-stream"]
      : ["interactions-stream", "interactions-batch", "generate-content-stream", "generate-content-batch"];
    for (const endpoint of endpoints) await execute(endpoint, testCase, iteration, false);
  }
}

process.stdout.write(`${JSON.stringify({
  profiledAt: new Date().toISOString(),
  model,
  voice,
  repetitions,
  warmups,
  cases: TEST_CASES.map((testCase) => ({ name: testCase.name, text: testCase.text })),
  aggregate: aggregate(runs),
  runs
}, null, 2)}\n`);
