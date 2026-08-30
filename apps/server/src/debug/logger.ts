import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export type DebugLogLevel = "debug" | "info" | "warn" | "error";

export interface DebugLogger {
  readonly enabled: boolean;
  readonly filePath: string | null;
  readonly runId: string;
  log(level: DebugLogLevel, event: string, data?: Record<string, unknown>): void;
  error(event: string, error: unknown, data?: Record<string, unknown>): void;
  message(error: unknown): string;
  close(): void;
}

type DebugLogTarget = "file" | "off" | "stdout";

const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|credential|password|secret|token/i;
const MAX_STRING_LENGTH = 20_000;
const MAX_ARRAY_LENGTH = 200;
const MAX_DEPTH = 10;

function timestampForFile(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

function configuredSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SENSITIVE_KEY.test(name) && Boolean(value) && (value?.length ?? 0) >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function configuredTarget(): DebugLogTarget {
  const configured = process.env.ROBOT_RADIO_DEBUG_LOG?.trim().toLowerCase();
  if (configured === "off") return "off";
  if (configured === "stdout") return "stdout";
  if (configured === "file" || configured === "on") return "file";
  return process.env.K_SERVICE ? "stdout" : "file";
}

function makeSanitizer(secrets: string[]): (value: unknown) => unknown {
  function redactString(value: string): string {
    let result = value;
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    return result.length > MAX_STRING_LENGTH
      ? `${result.slice(0, MAX_STRING_LENGTH)}…[truncated ${result.length - MAX_STRING_LENGTH} chars]`
      : result;
  }

  function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return redactString(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
    if (depth >= MAX_DEPTH) return "[max depth]";

    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactString(value.message),
        stack: value.stack ? redactString(value.stack) : undefined,
        cause: value.cause === undefined ? undefined : sanitize(value.cause, depth + 1, seen)
      };
    }
    if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.byteLength };
    if (ArrayBuffer.isView(value)) return { type: value.constructor.name, bytes: value.byteLength };
    if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", bytes: value.byteLength };
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_LENGTH) items.push(`[${value.length - MAX_ARRAY_LENGTH} more items]`);
      return items;
    }
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1, seen);
      }
      seen.delete(value);
      return output;
    }
    return redactString(String(value));
  }

  return (value: unknown) => sanitize(value, 0, new WeakSet());
}

export function createDebugLogger(now = new Date()): DebugLogger {
  const target = configuredTarget();
  const enabled = target !== "off";
  const runId = randomUUID();
  const sanitize = makeSanitizer(configuredSecrets());
  let closed = false;

  if (!enabled) {
    return {
      enabled,
      filePath: null,
      runId,
      log: () => undefined,
      error: () => undefined,
      message: (error) => String((sanitize(error) as { message?: string })?.message ?? sanitize(error)),
      close: () => undefined
    };
  }

  const directory = target === "file" ? resolve(process.cwd(), process.env.ROBOT_RADIO_DEBUG_LOG_DIR ?? "../../logs") : null;
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = directory ? resolve(directory, `robot-radio-${timestampForFile(now)}-${runId.slice(0, 8)}.ndjson`) : null;
  const file = filePath ? openSync(filePath, "ax", 0o600) : null;

  function write(level: DebugLogLevel, event: string, data: Record<string, unknown> = {}): void {
    if (closed) return;
    const record = sanitize({
      timestamp: new Date().toISOString(),
      monotonicMs: performance.now(),
      level,
      runId,
      event,
      data
    });
    const line = `${JSON.stringify(record)}\n`;
    if (target === "stdout") {
      process.stdout.write(line);
      return;
    }
    if (file === null) return;
    try {
      appendFileSync(file, line, "utf8");
    } catch (error) {
      console.error("Robot Radio could not write its debug log", error);
    }
  }

  return {
    enabled,
    filePath,
    runId,
    log: write,
    error: (event, error, data = {}) => write("error", event, { ...data, error }),
    message: (error) => {
      const safe = sanitize(error);
      if (safe && typeof safe === "object" && "message" in safe) return String(safe.message);
      return String(safe);
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (file !== null) closeSync(file);
    }
  };
}
