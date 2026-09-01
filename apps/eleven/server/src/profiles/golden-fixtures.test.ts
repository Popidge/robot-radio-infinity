import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/eleven-music");
const expectedIds = ["dense-vocal", "dry-id", "instrumental-bed", "vocal-ramp", "wet-sting"];

function json(path: string): JsonRecord { return JSON.parse(readFileSync(path, "utf8")) as JsonRecord }

function nestedArrays(value: unknown, key: string, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    for (const child of value) nestedArrays(child, key, found);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as JsonRecord)) {
      if (childKey === key && Array.isArray(child)) found.push(child);
      else nestedArrays(child, key, found);
    }
  }
  return found;
}

describe("Eleven Music golden corpus", () => {
  const fixtureIds = readdirSync(resolve(root, "golden"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("stays inside the fixed five-fixture scope and generation budget", () => {
    const catalog = json(resolve(root, "catalog.json"));
    const entries = catalog.fixtures as JsonRecord[];
    expect(fixtureIds).toEqual(expectedIds);
    expect(entries.map((entry) => entry.id).sort()).toEqual(expectedIds);
    expect(entries.reduce((total, entry) => total + Number(entry.requestedDurationMs), 0)).toBe(125_000);
    expect(catalog.generationBudgetMs).toBe(125_000);
  });

  for (const id of fixtureIds) {
    it(`keeps ${id} audio, request, and detailed metadata together`, () => {
      const directory = resolve(root, "golden", id);
      const fixture = json(resolve(directory, "fixture.json"));
      const definition = json(resolve(root, "definitions", `${id}.json`));
      const audio = fixture.audio as JsonRecord;
      const response = fixture.response as JsonRecord;
      const events = response.events as JsonRecord[];
      const audioPath = resolve(directory, String(audio.file));
      const bytes = readFileSync(audioPath);
      const requestedDuration = ((definition.composition_plan as JsonRecord).chunks as JsonRecord[])
        .reduce((total, chunk) => total + Number(chunk.duration_ms), 0);

      expect(fixture).toMatchObject({ schemaVersion: 1, id, provider: "elevenlabs", modelId: "music_v2", outputFormat: "mp3_48000_128" });
      expect(fixture.request).toEqual(definition);
      expect(fixture.requestedDurationMs).toBe(requestedDuration);
      expect(typeof response.songId).toBe("string");
      expect(String(response.songId)).not.toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["audio_chunk", "composition_plan", "song_metadata", "done"]));
      expect(statSync(audioPath).size).toBe(audio.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(audio.sha256);
      expect(nestedArrays(fixture, "waveform_visual").flat()).toHaveLength(requestedDuration / 250);
      expect(JSON.stringify(fixture)).not.toMatch(/xi-api-key|ELEVENLABS_API_KEY/);
    });
  }

  it("retains provider timestamp behaviour needed for lyric filtering tests", () => {
    const instrumental = json(resolve(root, "golden/instrumental-bed/fixture.json"));
    const timestampWords = nestedArrays(instrumental, "words_timestamps").flat() as JsonRecord[];
    expect(timestampWords.map((word) => word.word).join(" ")).toContain("instrumental");
    expect(timestampWords.map((word) => word.word).join(" ")).toContain("no vocals");
  });
});
