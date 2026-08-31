import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenTTSApiProvider } from "./eleven-tts";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.unstubAllGlobals();
});

describe("ElevenLabs TTS transport", () => {
  it("passes streaming MP3 through and declares its encoded sample rate", async () => {
    const encoded = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(encoded));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ElevenTTSApiProvider("test-key", "voice-test");

    const stream = await provider.speak("speech-1", "You are listening to Robot Radio.");
    const received: number[] = [];
    for await (const chunk of stream.chunks) received.push(...chunk);

    expect(stream.encoding).toBe("mp3");
    expect(stream.sampleRate).toBe(44_100);
    expect(received).toEqual(Array.from(encoded));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("output_format=mp3_44100_128");
  });
});
