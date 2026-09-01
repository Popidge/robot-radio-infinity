import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackSpec, TransitionSpec } from "@robot-radio/eleven-shared";
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
  editorialNotes: ["Keep the kick soft and the hook instantly legible", "Leave negative space around the electric piano"],
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
  it("passes ElevenLabs MP3 bytes through without server-side PCM expansion", async () => {
    const encoded = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0]);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(encoded));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");

    const stream = await provider.generate(instrumentalTrack, 5);
    const received: number[] = [];
    for await (const chunk of stream.chunks) received.push(...chunk);

    expect(stream.encoding).toBe("mp3");
    expect(stream.sampleRate).toBe(48_000);
    expect(received).toEqual(Array.from(encoded));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("output_format=mp3_48000_128");
  });

  it("keeps instrumental prose out of chunk text and puts musical direction in styles", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => rejectedResponse());
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
    expect(intro.positive_styles).toContain(instrumentalTrack.editorialNotes![0]);
    expect(development.positive_styles).toContain(instrumentalTrack.editorialNotes![1]);
    expect(intro.positive_styles).toContain('original concept titled "Soft Compile"');
    expect(intro.negative_styles).not.toContain("copyrighted melody");
  });

  it("uses chunk text for supplied original lyrics, not production prose", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => rejectedResponse());
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/music/detailed/stream");
    expect(requestBody(fetchMock).with_timestamps).toBe(true);
    expect(chunk.text).toBe("[Clear Boot]\nSignals gather in the glow\nQuiet patterns start to show");
    expect(chunk.text).not.toContain(vocalTrack.description);
    expect(chunk.positive_styles).toContain("original vocals: restrained original alto vocal");
    expect(chunk.positive_styles).toContain("vocal language: English");
  });

  it("keeps a dry station ID free from the normal spoken-word prohibition", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => rejectedResponse());
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");
    const dryId: TrackSpec = {
      ...instrumentalTrack,
      id: "dry-id",
      title: "Robot Radio Infinity dry ID",
      styles: ["dry station ID", "professional radio ident"],
      vocals: "dry professional spoken radio voice",
      durationMs: 3_000,
      sections: [{
        name: "Dry station ID",
        durationMs: 3_000,
        description: "Isolated voice with no music or effects.",
        lyrics: "Robot Radio Infinity"
      }]
    };

    await expect(provider.generate(dryId, 5)).rejects.toThrow(/HTTP 422/);

    const chunk = requestBody(fetchMock).composition_plan.chunks[0];
    expect(chunk.text).toBe("[Dry station ID]\nRobot Radio Infinity");
    expect(chunk.positive_styles).toContain("isolated dry spoken station ident");
    expect(chunk.negative_styles).toContain("music");
    expect(chunk.negative_styles).not.toContain("spoken-word narration");
  });

  it("extracts MP3 audio and word timing slices from the detailed event stream", async () => {
    const first = new Uint8Array([0x49, 0x44, 0x33, 3]);
    const second = new Uint8Array([4, 5, 6, 7]);
    const sse = [
      "event: audio_chunk",
      `data: ${JSON.stringify({ audio_chunk: Buffer.from(first).toString("base64"), words_timestamps: [] })}`,
      "",
      "event: audio_chunk",
      `data: ${JSON.stringify({ data: { audio: Buffer.from(second).toString("base64") }, words_timestamps: [{ word: "Signals", start_ms: 1200, end_ms: 1800 }] })}`,
      "",
      "event: complete",
      "data: {}",
      ""
    ].join("\n");
    const fetchMock = vi.fn(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenMusicApiProvider("test-key");
    const stream = await provider.generate({
      ...instrumentalTrack,
      id: "track-timed-vocal",
      vocals: "restrained original alto vocal",
      sections: [{ ...instrumentalTrack.sections![0]!, durationMs: 30_000, lyrics: "Signals gather in the glow" }]
    }, 5);
    const metadata: unknown[] = [];
    stream.subscribeMetadata?.((value) => metadata.push(value));
    const received: number[] = [];
    for await (const chunk of stream.chunks) received.push(...chunk);

    expect(received).toEqual([...first, ...second]);
    expect(metadata).toEqual([{ wordTimestamps: [{ word: "Signals", startMs: 1200, endMs: 1800 }] }]);
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
