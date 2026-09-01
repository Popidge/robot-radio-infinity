import { MPEGDecoderWebWorker, type MPEGDecodedAudio } from "mpg123-decoder";
import type { AudioStreamEncoding } from "@robot-radio/eleven-shared";

const OUTPUT_SAMPLE_RATE = 48_000;
const OUTPUT_CHANNELS = 2;
export const MP3_DECODER_READY_TIMEOUT_MS = 8_000;

interface MpegDecoder {
  ready: Promise<void>;
  decode(bytes: Uint8Array): Promise<MPEGDecodedAudio>;
  free(): Promise<void>;
  terminate?(): void;
}

type MpegDecoderFactory = () => MpegDecoder;

export interface EncodedStreamMetadata {
  encoding: AudioStreamEncoding;
  sampleRate: number;
  channels: number;
}

export class PcmNormalizer {
  private left: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private right: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private position = 0;
  private sourceSampleRate: number | null = null;

  push(channelData: Float32Array[], sampleRate: number): Float32Array | null {
    if (!channelData.length || !channelData[0]?.length) return null;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`Invalid decoded sample rate: ${sampleRate}`);
    if (this.sourceSampleRate !== null && this.sourceSampleRate !== sampleRate) {
      throw new Error(`Decoded sample rate changed from ${this.sourceSampleRate} to ${sampleRate}`);
    }
    this.sourceSampleRate = sampleRate;

    const inputLeft = channelData[0]!;
    const inputRight = channelData[1] ?? inputLeft;
    const frames = Math.min(inputLeft.length, inputRight.length);
    this.left = append(this.left, inputLeft.subarray(0, frames));
    this.right = append(this.right, inputRight.subarray(0, frames));
    return this.drain(false);
  }

  flush(): Float32Array | null {
    const output = this.drain(true);
    this.left = new Float32Array(0);
    this.right = new Float32Array(0);
    this.position = 0;
    this.sourceSampleRate = null;
    return output;
  }

  private drain(final: boolean): Float32Array | null {
    if (this.sourceSampleRate === null || !this.left.length) return null;
    const step = this.sourceSampleRate / OUTPUT_SAMPLE_RATE;
    let cursor = this.position;
    let outputFrames = 0;
    while (final ? cursor < this.left.length : cursor + 1 < this.left.length) {
      outputFrames += 1;
      cursor += step;
    }
    if (!outputFrames) return null;

    const output = new Float32Array(outputFrames * OUTPUT_CHANNELS);
    cursor = this.position;
    for (let frame = 0; frame < outputFrames; frame += 1) {
      const lower = Math.floor(cursor);
      const upper = Math.min(lower + 1, this.left.length - 1);
      const mix = cursor - lower;
      output[frame * 2] = this.left[lower]! + (this.left[upper]! - this.left[lower]!) * mix;
      output[frame * 2 + 1] = this.right[lower]! + (this.right[upper]! - this.right[lower]!) * mix;
      cursor += step;
    }

    if (final) return output;
    const consumed = Math.min(Math.floor(cursor), this.left.length - 1);
    this.left = this.left.slice(consumed);
    this.right = this.right.slice(consumed);
    this.position = cursor - consumed;
    return output;
  }
}

export class StreamAudioDecoder {
  private readonly normalizer = new PcmNormalizer();
  private readonly mpeg: MpegDecoder | null;
  private mpegReady: Promise<void> | null = null;
  private closed = false;
  private mpegTerminated = false;

  constructor(
    private readonly metadata: EncodedStreamMetadata,
    createMpegDecoder: MpegDecoderFactory = () => new MPEGDecoderWebWorker()
  ) {
    this.mpeg = metadata.encoding === "mp3" ? createMpegDecoder() : null;
  }

  async push(bytes: Uint8Array): Promise<Float32Array[]> {
    if (this.closed) return [];
    if (this.metadata.encoding === "pcm-f32le") {
      if (this.metadata.sampleRate !== OUTPUT_SAMPLE_RATE || this.metadata.channels !== OUTPUT_CHANNELS) {
        throw new Error(`PCM stream must be ${OUTPUT_SAMPLE_RATE} Hz stereo`);
      }
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error("PCM stream ended on an incomplete Float32 sample");
      }
      const aligned = bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
        ? bytes
        : Uint8Array.from(bytes);
      return [new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / Float32Array.BYTES_PER_ELEMENT)];
    }

    if (!this.mpeg) throw new Error("MP3 decoder was not initialized");
    this.mpegReady ??= decoderReady(this.mpeg);
    try {
      await this.mpegReady;
    } catch (error) {
      this.terminateMpeg();
      throw error;
    }
    const decoded = await this.mpeg.decode(bytes);
    const pcm = this.normalizer.push(decoded.channelData, decoded.sampleRate);
    return pcm ? [pcm] : [];
  }

  finish(): Float32Array[] {
    if (this.metadata.encoding !== "mp3") return [];
    const pcm = this.normalizer.flush();
    return pcm ? [pcm] : [];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.mpeg?.terminate) {
      this.terminateMpeg();
      return;
    }
    await this.mpeg?.free();
  }

  private terminateMpeg(): void {
    if (this.mpegTerminated) return;
    this.mpegTerminated = true;
    this.mpeg?.terminate?.();
  }
}

function decoderReady(decoder: MpegDecoder): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(
        `MP3 decoder did not initialize within ${MP3_DECODER_READY_TIMEOUT_MS} ms. `
        + "Content-Security-Policy must allow WebAssembly with script-src 'wasm-unsafe-eval'."
      ));
    }, MP3_DECODER_READY_TIMEOUT_MS);
  });
  return Promise.race([decoder.ready, deadline]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function append(existing: Float32Array<ArrayBufferLike>, next: Float32Array<ArrayBufferLike>): Float32Array<ArrayBufferLike> {
  if (!existing.length) return next.slice();
  const joined = new Float32Array(existing.length + next.length);
  joined.set(existing);
  joined.set(next, existing.length);
  return joined;
}
