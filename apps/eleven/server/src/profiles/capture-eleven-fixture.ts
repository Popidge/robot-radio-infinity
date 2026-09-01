import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

export interface CapturedEvent {
  sequence: number;
  type: string;
  payload: unknown;
  audioBytes: number;
}

const AUDIO_FIELDS = new Set(["audio", "audio_base64", "audioBase64", "audio_data", "audioData"]);

function nestedJson(value: unknown): unknown {
  let current = value;
  for (let attempt = 0; attempt < 2 && typeof current === "string"; attempt += 1) {
    try { current = JSON.parse(current) as unknown } catch { break }
  }
  return current;
}

function eventType(value: unknown, fallback = "unknown"): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as JsonRecord;
  for (const key of ["type", "event", "event_type", "message_type"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return fallback;
}

function separateAudio(value: unknown): { payload: unknown; audio: Buffer[] } {
  if (Array.isArray(value)) {
    const parts = value.map(separateAudio);
    return { payload: parts.map((part) => part.payload), audio: parts.flatMap((part) => part.audio) };
  }
  if (!value || typeof value !== "object") return { payload: value, audio: [] };

  const payload: JsonRecord = {};
  const audio: Buffer[] = [];
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (AUDIO_FIELDS.has(key) && typeof child === "string") {
      const decoded = Buffer.from(child, "base64");
      audio.push(decoded);
      payload[`${key}_capture`] = { omitted: true, bytes: decoded.length };
      continue;
    }
    const separated = separateAudio(child);
    payload[key] = separated.payload;
    audio.push(...separated.audio);
  }
  return { payload, audio };
}

function parseData(data: string): unknown | null {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  try { return nestedJson(JSON.parse(trimmed) as unknown) } catch { return { unparsed: trimmed } }
}

export class SseCaptureDecoder {
  private pending = "";
  private sequence = 0;

  push(text: string): Array<{ event: CapturedEvent; audio: Buffer[] }> {
    this.pending += text.replaceAll("\r\n", "\n");
    const blocks = this.pending.split("\n\n");
    this.pending = blocks.pop() ?? "";
    return blocks.flatMap((block) => this.parseBlock(block));
  }

  finish(): Array<{ event: CapturedEvent; audio: Buffer[] }> {
    const block = this.pending;
    this.pending = "";
    return this.parseBlock(block);
  }

  private parseBlock(block: string): Array<{ event: CapturedEvent; audio: Buffer[] }> {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (!lines.length) return [];
    const declaredType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    const candidates = dataLines.length ? [dataLines.join("\n")] : lines.filter((line) => !line.startsWith(":"));
    return candidates.flatMap((candidate) => {
      const parsed = parseData(candidate);
      if (parsed === null) return [];
      const separated = separateAudio(parsed);
      this.sequence += 1;
      return [{
        event: {
          sequence: this.sequence,
          type: eventType(parsed, declaredType ?? "unknown"),
          payload: separated.payload,
          audioBytes: separated.audio.reduce((total, chunk) => total + chunk.length, 0)
        },
        audio: separated.audio
      }];
    });
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean { return process.argv.includes(name) }

function requestedDurationMs(request: JsonRecord): number | null {
  if (typeof request.music_length_ms === "number") return request.music_length_ms;
  const plan = request.composition_plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return null;
  const chunks = (plan as JsonRecord).chunks;
  if (!Array.isArray(chunks)) return null;
  return chunks.reduce<number>((total, chunk) => {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return total;
    const duration = (chunk as JsonRecord).duration_ms;
    return total + (typeof duration === "number" ? duration : 0);
  }, 0);
}

async function capture(): Promise<void> {
  if (!flag("--confirm-cost")) throw new Error("Fixture capture creates chargeable music. Re-run with --confirm-cost.");
  const requestArgument = argument("--request");
  const outputArgument = argument("--output");
  if (!requestArgument || !outputArgument) throw new Error("Use --request <request.json> --output <fixture-directory> --confirm-cost.");

  const requestPath = resolve(process.cwd(), requestArgument);
  const outputDirectory = resolve(process.cwd(), outputArgument);
  const fixturePath = resolve(outputDirectory, "fixture.json");
  if (existsSync(fixturePath) && !flag("--overwrite")) throw new Error(`${fixturePath} already exists. Pass --overwrite to replace it.`);

  const request = JSON.parse(readFileSync(requestPath, "utf8")) as JsonRecord;
  if (request.model_id !== "music_v2") throw new Error("Golden fixtures must use music_v2.");
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is missing.");
  const baseUrl = (process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io").replace(/\/$/, "");
  const outputFormat = argument("--output-format") ?? "mp3_48000_128";
  const timeoutMs = Number(argument("--timeout-ms") ?? "600000");
  const response = await fetch(`${baseUrl}/v1/music/detailed/stream?output_format=${encodeURIComponent(outputFormat)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 20_000);
    throw new Error(`Eleven Music returned HTTP ${response.status}: ${body}`);
  }
  if (!response.body) throw new Error("Eleven Music returned no detailed response body.");

  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const decoder = new SseCaptureDecoder();
  const events: CapturedEvent[] = [];
  const audio: Buffer[] = [];
  const accept = (items: Array<{ event: CapturedEvent; audio: Buffer[] }>): void => {
    for (const item of items) { events.push(item.event); audio.push(...item.audio) }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    accept(decoder.push(textDecoder.decode(value, { stream: true })));
  }
  accept(decoder.push(textDecoder.decode()));
  accept(decoder.finish());
  const encoded = Buffer.concat(audio);
  if (!encoded.length) throw new Error("Detailed stream completed without captured audio.");

  mkdirSync(outputDirectory, { recursive: true });
  const extension = outputFormat.startsWith("mp3_") ? "mp3" : outputFormat.startsWith("opus_") ? "opus" : "bin";
  const audioName = `audio.${extension}`;
  writeFileSync(resolve(outputDirectory, audioName), encoded);
  const fixture = {
    schemaVersion: 1,
    id: basename(outputDirectory),
    capturedAt: new Date().toISOString(),
    provider: "elevenlabs",
    endpoint: "/v1/music/detailed/stream",
    modelId: request.model_id,
    outputFormat,
    requestedDurationMs: requestedDurationMs(request),
    request,
    response: {
      songId: response.headers.get("song-id"),
      requestId: response.headers.get("request-id"),
      traceId: response.headers.get("x-trace-id"),
      contentType: response.headers.get("content-type"),
      events
    },
    audio: {
      file: audioName,
      bytes: encoded.length,
      sha256: createHash("sha256").update(encoded).digest("hex")
    }
  };
  writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ fixturePath, audioPath: resolve(outputDirectory, audioName), events: events.length, bytes: encoded.length }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  capture().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
