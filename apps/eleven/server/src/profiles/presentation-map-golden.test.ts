import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MusicWordTimestamp, TrackSection } from "@robot-radio/eleven-shared";
import { describe, expect, it } from "vitest";
import { buildTrackPresentationMap } from "../../../web/src/station/presentation-map";

interface FixtureChunk { text: string; duration_ms: number; positive_styles: string[] }
interface Fixture {
  id: string;
  requestedDurationMs: number;
  request: { composition_plan: { chunks: FixtureChunk[] } };
  response: { events: Array<{ type: string; payload: { words_timestamps?: Array<{ word: string; start_ms: number; end_ms: number }> } }> };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../test-fixtures/eleven-music/golden");

function load(id: string): Fixture {
  return JSON.parse(readFileSync(resolve(root, id, "fixture.json"), "utf8")) as Fixture;
}

function sectionFromChunk(chunk: FixtureChunk): TrackSection {
  const [heading = "Section", ...body] = chunk.text.split("\n");
  const lyrics = body.join("\n").trim();
  return {
    name: heading.replace(/^\[|\]$/g, ""),
    durationMs: chunk.duration_ms,
    description: chunk.positive_styles.join(", "),
    lyrics: lyrics.startsWith("{") ? undefined : lyrics || undefined,
    transitionFriendly: /intro|break|outro|ending/i.test(heading)
  };
}

function presentation(id: string) {
  const fixture = load(id);
  const timestamps: MusicWordTimestamp[] = fixture.response.events.flatMap((event) => event.payload.words_timestamps ?? [])
    .map((stamp) => ({ word: stamp.word, startMs: stamp.start_ms, endMs: stamp.end_ms }));
  return buildTrackPresentationMap(
    id,
    fixture.requestedDurationMs,
    fixture.request.composition_plan.chunks.map(sectionFromChunk),
    timestamps
  );
}

describe("TrackPresentationMap against retained Eleven Music output", () => {
  it("ignores timestamped composition instructions and uses the observed vocal entrance", () => {
    const map = presentation("vocal-ramp");
    expect(map.firstVocalMs).toBeGreaterThan(9_000);
    expect(map.vocalRegions.some((region) => region.sectionName === "Instrumental intro")).toBe(false);
    expect(map.safeMicWindows.find((window) => window.kind === "intro")?.endMs).toBeGreaterThan(8_500);
    expect(map.safeMicWindows.some((window) => window.kind === "instrumental" && window.startMs > 20_000)).toBe(true);
    expect(map.safeMicWindows.some((window) => window.kind === "outro" && window.endMs === 45_000)).toBe(true);
  });

  it("keeps a vocal-from-the-first-beat track closed until its real instrumental break", () => {
    const map = presentation("dense-vocal");
    expect(map.firstVocalMs).toBeLessThan(500);
    expect(map.safeMicWindows.some((window) => window.kind === "intro")).toBe(false);
    const breakWindow = map.safeMicWindows.find((window) => window.kind === "instrumental");
    expect(breakWindow?.startMs).toBeGreaterThan(20_000);
    expect(breakWindow?.endMs).toBeLessThan(32_000);
    expect(map.endStyle).toBe("cold");
  });

  it("exposes the whole deliberately instrumental bed as authored mic windows", () => {
    const map = presentation("instrumental-bed");
    expect(map.vocalRegions).toEqual([]);
    expect(map.safeMicWindows).toHaveLength(3);
    expect(map.safeMicWindows[0]).toMatchObject({ startMs: 0, endMs: 8_000, kind: "intro", source: "planned" });
  });
});
