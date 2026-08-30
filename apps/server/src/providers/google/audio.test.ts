import { describe, expect, it } from "vitest";
import { GoogleAudioDecoder, resolveFfmpegExecutable } from "./audio";

function wavFile(payload: Buffer, sampleRate = 48_000, channels = 2): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + payload.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

describe("GoogleAudioDecoder", () => {
  it("uses an explicit FFmpeg path before the packaged binary", () => {
    expect(resolveFfmpegExecutable({ FFMPEG_PATH: "/opt/robot-radio/ffmpeg" })).toBe("/opt/robot-radio/ffmpeg");
  });

  it("converts 24 kHz mono PCM into the browser's 48 kHz stereo contract", () => {
    const source = Buffer.alloc(6);
    source.writeInt16LE(0, 0);
    source.writeInt16LE(16_384, 2);
    source.writeInt16LE(-16_384, 4);
    const decoder = new GoogleAudioDecoder({ mimeType: "audio/L16", sampleRate: 24_000, channels: 1 });

    const [decoded] = decoder.push(source);

    expect(decoded).toHaveLength(12);
    for (let index = 0; index < decoded!.length; index += 2) {
      expect(decoded![index]).toBeCloseTo(decoded![index + 1]!, 6);
    }
    expect(decoded![4]).toBeCloseTo(0.5, 4);
    expect(decoded![8]).toBeCloseTo(-0.5, 4);
  });

  it("waits for a split WAV header and then decodes its PCM payload", () => {
    const payload = Buffer.alloc(16);
    for (let index = 0; index < 8; index += 1) payload.writeInt16LE(index * 1_000, index * 2);
    const wav = wavFile(payload);
    const decoder = new GoogleAudioDecoder({ mimeType: "audio/wav", sampleRate: 44_100, channels: 2 });

    expect(decoder.push(wav.subarray(0, 30))).toEqual([]);
    const [decoded] = decoder.push(wav.subarray(30));

    expect(decoded).toHaveLength(8);
    expect(decoded![0]).toBeCloseTo(0, 6);
    expect(decoded![7]).toBeCloseTo(7_000 / 32_768, 6);
  });
});
