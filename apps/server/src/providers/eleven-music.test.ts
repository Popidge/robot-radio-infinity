import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackSpec, TransitionSpec } from "@robot-radio/shared";
import { ElevenMusicApiProvider } from "./eleven-music";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.unstubAllGlobals();
});

function rejectedResponse(status = 422, body: unknown = { detail: { status: "bad_composition_plan" } }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index = 0): Record<string, any> {
  const options = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(options?.body));
}

const instrumentalTrack: TrackSpec = {
  id: "track-1",
  programmeId: "programme-1",
  revision: 1,
  title: "Soft Compile",
  description: "A calm coding soundtrack with muted drums, rounded bass, electric piano, and airy pads.",
  styles: ["downtempo electronica", "ambient groove"],
  mood: ["focused", "warm"],
  energy: 0.38,
  bpm: 100,
  key: "D minor",
  vocals: "Instrumental, with no vocals",
  durationMs: 30_000,
  sections: [
    {
      name: "Clear Boot",
      durationMs: 12_000,
      description: "Begin immediately with a soft kick and a two-note electric-piano motif.",
      transitionFriendly: true
    },
    {
      name: "Quiet Loop",
      durationMs: 18_000,
      description: "Add rounded bass and restrained percussion while gently developing the motif."
    }
  ]
};

describe("Eleven Music composition plans", () => {
  it("keeps instrumental prose out of chunk text and puts musical direction in styles", async () => {
    const fetchMock = vi.fn(async () => rejectedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");

    await expect(provider.generate(instrumentalTrack, 5)).rejects.toThrow(/HTTP 422/);

    const body = requestBody(fetchMock);
    const [intro, development] = body.composition_plan.chunks;
    expect(intro.text).toBe("[Clear Boot]\n{instrumental, no vocals}");
    expect(development.text).toBe("[Quiet Loop]\n{instrumental, no vocals}");
    expect(intro.text).not.toContain(instrumentalTrack.description);
    expect(intro.positive_styles).toContain(instrumentalTrack.description);
    expect(intro.positive_styles).toContain(instrumentalTrack.sections![0]!.description);
    expect(intro.positive_styles).toContain('original concept titled "Soft Compile"');
    expect(intro.negative_styles).not.toContain("copyrighted melody");
  });

  it("uses chunk text for supplied original lyrics, not production prose", async () => {
    const fetchMock = vi.fn(async () => rejectedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");
    const vocalTrack: TrackSpec = {
      ...instrumentalTrack,
      id: "track-vocal",
      vocals: "restrained original alto vocal",
      language: "English",
      sections: [{
        ...instrumentalTrack.sections![0]!,
        durationMs: 30_000,
        lyrics: "Signals gather in the glow\nQuiet patterns start to show"
      }]
    };

    await expect(provider.generate(vocalTrack, 5)).rejects.toThrow(/HTTP 422/);

    const chunk = requestBody(fetchMock).composition_plan.chunks[0];
    expect(chunk.text).toBe("[Clear Boot]\nSignals gather in the glow\nQuiet patterns start to show");
    expect(chunk.text).not.toContain(vocalTrack.description);
    expect(chunk.positive_styles).toContain("original vocals: restrained original alto vocal");
    expect(chunk.positive_styles).toContain("vocal language: English");
  });

  it("keeps transition instructions in styles rather than lyric text", async () => {
    const fetchMock = vi.fn(async () => rejectedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");
    const transition: TransitionSpec = {
      id: "transition-1",
      programmeId: "programme-2",
      revision: 2,
      description: "Thin the current groove and introduce darker distorted syncopation.",
      sourceSummary: "warm downtempo electronica",
      destinationSummary: "dark broken dub-metal",
      styles: ["downtempo", "dub metal"],
      mood: ["focused", "urgent"],
      energy: 0.72,
      bpm: 120,
      durationMs: 30_000,
      instrumental: true,
      reason: "immediate"
    };

    await expect(provider.generate(transition, 5)).rejects.toThrow(/HTTP 422/);

    const chunks = requestBody(fetchMock).composition_plan.chunks;
    expect(chunks.map((chunk: { text: string }) => chunk.text)).toEqual([
      "[Departure]\n{instrumental transition}",
      "[Transformation]\n{instrumental transition}",
      "[Arrival]\n{instrumental transition}"
    ]);
    expect(chunks[0].positive_styles).toContain("begin inside this musical world: warm downtempo electronica");
    expect(chunks[2].positive_styles).toContain("arrive clearly in this destination: dark broken dub-metal");
  });

  it("retries a transient HTTP failure once before returning the final rejection", async () => {
    process.env.ELEVENLABS_MUSIC_HTTP_RETRIES = "1";
    process.env.ELEVENLABS_MUSIC_RETRY_DELAY_MS = "0";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectedResponse(500, { status: "internal_server_error" }))
      .mockResolvedValueOnce(rejectedResponse(422, { detail: { status: "bad_composition_plan" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");

    await expect(provider.generate(instrumentalTrack, 5)).rejects.toThrow(/HTTP 422/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a transient network failure once", async () => {
    process.env.ELEVENLABS_MUSIC_HTTP_RETRIES = "1";
    process.env.ELEVENLABS_MUSIC_RETRY_DELAY_MS = "0";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary connection reset"))
      .mockResolvedValueOnce(rejectedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");

    await expect(provider.generate(instrumentalTrack, 5)).rejects.toThrow(/HTTP 422/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
