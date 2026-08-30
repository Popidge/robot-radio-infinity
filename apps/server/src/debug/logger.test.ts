import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDebugLogger } from "./logger";

const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("structured debug logger", () => {
  it("writes NDJSON and redacts configured secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "robot-radio-log-"));
    temporaryDirectories.push(directory);
    process.env.ROBOT_RADIO_DEBUG_LOG_DIR = directory;
    process.env.GEMINI_API_KEY = "test-secret-api-key-value";

    const logger = createDebugLogger(new Date("2026-08-30T12:00:00.000Z"));
    logger.log("info", "test.started", {
      apiKey: "must-not-appear",
      message: `provider echoed ${process.env.GEMINI_API_KEY}`
    });
    logger.error("test.failed", new Error(`failure for ${process.env.GEMINI_API_KEY}`));
    logger.close();

    expect(logger.filePath).not.toBeNull();
    const contents = readFileSync(logger.filePath as string, "utf8");
    const records = contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(contents).not.toContain("test-secret-api-key-value");
    expect(contents).not.toContain("must-not-appear");
    expect(contents).toContain("[REDACTED]");
    expect(statSync(logger.filePath as string).mode & 0o777).toBe(0o600);
  });

  it("can be disabled", () => {
    process.env.ROBOT_RADIO_DEBUG_LOG = "off";
    const logger = createDebugLogger();
    expect(logger.enabled).toBe(false);
    expect(logger.filePath).toBeNull();
  });
});
