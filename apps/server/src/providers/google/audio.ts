import { spawn } from "node:child_process";

const OUTPUT_SAMPLE_RATE = 48_000;
const OUTPUT_CHANNELS = 2;

interface WavFormat {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
}

function parseWavFormat(buffer: Buffer): WavFormat | null {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let audioFormat = 1;
  let channels = 2;
  let sampleRate = 44_100;
  let bitsPerSample = 16;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "fmt ") {
      if (buffer.length < dataStart + Math.min(size, 16)) return null;
      audioFormat = buffer.readUInt16LE(dataStart);
      channels = buffer.readUInt16LE(dataStart + 2);
      sampleRate = buffer.readUInt32LE(dataStart + 4);
      bitsPerSample = buffer.readUInt16LE(dataStart + 14);
    }
    if (id === "data") {
      return { audioFormat, channels, sampleRate, bitsPerSample, dataOffset: dataStart };
    }
    if (buffer.length < dataStart + size) return null;
    offset = dataStart + size + (size % 2);
  }
  return null;
}

function decodePcm(buffer: Buffer, format: Omit<WavFormat, "dataOffset">): Float32Array {
  const bytesPerSample = format.bitsPerSample / 8;
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(buffer.length / frameBytes);
  const source = new Float32Array(frames * format.channels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < format.channels; channel += 1) {
      const offset = frame * frameBytes + channel * bytesPerSample;
      let value = 0;
      if (format.audioFormat === 3 && format.bitsPerSample === 32) value = buffer.readFloatLE(offset);
      else if (format.bitsPerSample === 16) value = buffer.readInt16LE(offset) / 32_768;
      else if (format.bitsPerSample === 24) value = buffer.readIntLE(offset, 3) / 8_388_608;
      else if (format.bitsPerSample === 32) value = buffer.readInt32LE(offset) / 2_147_483_648;
      source[frame * format.channels + channel] = Math.max(-1, Math.min(1, value));
    }
  }
  return resampleToStereo(source, format.channels, format.sampleRate);
}

function resampleToStereo(source: Float32Array, channels: number, sampleRate: number): Float32Array {
  const sourceFrames = Math.floor(source.length / channels);
  if (sourceFrames === 0) return new Float32Array();
  const targetFrames = Math.max(1, Math.floor((sourceFrames * OUTPUT_SAMPLE_RATE) / sampleRate));
  const output = new Float32Array(targetFrames * OUTPUT_CHANNELS);
  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = (frame * sampleRate) / OUTPUT_SAMPLE_RATE;
    const leftFrame = Math.min(sourceFrames - 1, Math.floor(sourcePosition));
    const rightFrame = Math.min(sourceFrames - 1, leftFrame + 1);
    const mix = sourcePosition - leftFrame;
    for (let channel = 0; channel < OUTPUT_CHANNELS; channel += 1) {
      const sourceChannel = Math.min(channel, channels - 1);
      const left = source[leftFrame * channels + sourceChannel] ?? 0;
      const right = source[rightFrame * channels + sourceChannel] ?? left;
      output[frame * OUTPUT_CHANNELS + channel] = left + (right - left) * mix;
    }
  }
  return output;
}

async function transcodeWithFfmpeg(encoded: Buffer): Promise<Float32Array> {
  const executable = process.env.FFMPEG_PATH ?? "ffmpeg";
  return new Promise((resolve, reject) => {
    const processHandle = spawn(executable, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "f32le",
      "-ac",
      String(OUTPUT_CHANNELS),
      "-ar",
      String(OUTPUT_SAMPLE_RATE),
      "pipe:1"
    ]);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    processHandle.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    processHandle.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    processHandle.on("error", (error) => reject(new Error(`Cannot start ${executable}: ${error.message}`)));
    processHandle.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Audio decode failed: ${Buffer.concat(errors).toString("utf8").trim()}`));
        return;
      }
      const decoded = Buffer.concat(output);
      const copy = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
      resolve(new Float32Array(copy));
    });
    processHandle.stdin.end(encoded);
  });
}

export class GoogleAudioDecoder {
  private pending = Buffer.alloc(0);
  private compressed: Buffer[] = [];
  private wavFormat: WavFormat | null = null;
  private mimeType: string | undefined;
  private sampleRate: number;
  private channels: number;

  constructor(defaults: { mimeType?: string; sampleRate: number; channels: number }) {
    this.mimeType = defaults.mimeType;
    this.sampleRate = defaults.sampleRate;
    this.channels = defaults.channels;
  }

  push(data: Buffer, metadata?: { mimeType?: string; sampleRate?: number; channels?: number }): Float32Array[] {
    this.mimeType = metadata?.mimeType ?? this.mimeType;
    this.sampleRate = metadata?.sampleRate ?? this.sampleRate;
    this.channels = metadata?.channels ?? this.channels;
    const mime = this.mimeType?.toLowerCase() ?? "";

    if (mime.includes("l16") || mime.includes("pcm") || (!mime && data.toString("ascii", 0, 4) !== "RIFF")) {
      return this.decodeRawPcm(data);
    }
    if (mime.includes("wav") || data.toString("ascii", 0, 4) === "RIFF" || this.wavFormat) {
      return this.decodeWavBytes(data);
    }
    this.compressed.push(data);
    return [];
  }

  async flush(): Promise<Float32Array[]> {
    if (this.wavFormat && this.pending.length) {
      const decoded = this.decodeWavPayload(this.pending);
      this.pending = Buffer.alloc(0);
      return decoded.length ? [decoded] : [];
    }
    if (this.compressed.length) return [await transcodeWithFfmpeg(Buffer.concat(this.compressed))];
    if (this.pending.length) return this.decodeRawPcm(Buffer.alloc(0));
    return [];
  }

  private decodeRawPcm(data: Buffer): Float32Array[] {
    this.pending = Buffer.concat([this.pending, data]);
    const frameBytes = this.channels * 2;
    const alignedBytes = this.pending.length - (this.pending.length % frameBytes);
    if (alignedBytes === 0) return [];
    const payload = this.pending.subarray(0, alignedBytes);
    this.pending = this.pending.subarray(alignedBytes);
    return [decodePcm(payload, { audioFormat: 1, channels: this.channels, sampleRate: this.sampleRate, bitsPerSample: 16 })];
  }

  private decodeWavBytes(data: Buffer): Float32Array[] {
    if (data.toString("ascii", 0, 4) === "RIFF") {
      this.wavFormat = null;
      this.pending = Buffer.alloc(0);
    }
    this.pending = Buffer.concat([this.pending, data]);
    if (!this.wavFormat) {
      const format = parseWavFormat(this.pending);
      if (!format) return [];
      this.wavFormat = format;
      this.pending = this.pending.subarray(format.dataOffset);
    }
    const frameBytes = this.wavFormat.channels * (this.wavFormat.bitsPerSample / 8);
    const alignedBytes = this.pending.length - (this.pending.length % frameBytes);
    if (alignedBytes === 0) return [];
    const payload = this.pending.subarray(0, alignedBytes);
    this.pending = this.pending.subarray(alignedBytes);
    const decoded = this.decodeWavPayload(payload);
    return decoded.length ? [decoded] : [];
  }

  private decodeWavPayload(payload: Buffer): Float32Array {
    if (!this.wavFormat) return new Float32Array();
    return decodePcm(payload, this.wavFormat);
  }
}

export function pcm16StereoToFloat(data: Buffer): Float32Array {
  return decodePcm(data, { audioFormat: 1, channels: 2, sampleRate: OUTPUT_SAMPLE_RATE, bitsPerSample: 16 });
}

export function chunkPcm(pcm: Float32Array, chunkMs = 100): Float32Array[] {
  const samplesPerChunk = Math.round((OUTPUT_SAMPLE_RATE * OUTPUT_CHANNELS * chunkMs) / 1_000);
  const chunks: Float32Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += samplesPerChunk) chunks.push(pcm.slice(offset, offset + samplesPerChunk));
  return chunks;
}
