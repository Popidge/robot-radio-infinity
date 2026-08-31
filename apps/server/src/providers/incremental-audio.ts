import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import ffmpegStaticPath from "ffmpeg-static";
import { AsyncQueue } from "./async-queue";

export interface DecodedAudioStream {
  chunks: AsyncIterable<Float32Array>;
  stop(): void;
  completed: Promise<void>;
}

export function resolveFfmpegExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.FFMPEG_PATH) return environment.FFMPEG_PATH;
  return ffmpegStaticPath && existsSync(ffmpegStaticPath) ? ffmpegStaticPath : "ffmpeg";
}

/** Decode an encoded HTTP audio body to interleaved 48 kHz stereo float PCM as bytes arrive. */
export function decodeAudioResponse(body: ReadableStream<Uint8Array>): DecodedAudioStream {
  const queue = new AsyncQueue<Float32Array>();
  const decoder: ChildProcessWithoutNullStreams = spawn(resolveFfmpegExecutable(), [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "2", "-ar", "48000", "pipe:1"
  ]);
  const errors: Buffer[] = [];
  let remainder = Buffer.alloc(0);
  let stopped = false;

  decoder.stdout.on("data", (chunk: Buffer) => {
    const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const completeBytes = bytes.length - (bytes.length % 4);
    if (completeBytes > 0) {
      const copy = Uint8Array.from(bytes.subarray(0, completeBytes));
      queue.push(new Float32Array(copy.buffer));
    }
    remainder = Buffer.from(bytes.subarray(completeBytes));
  });
  decoder.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  decoder.once("error", (error) => queue.fail(new Error(`Could not start the audio decoder: ${error.message}`)));

  const completed = (async () => {
    const reader = body.getReader();
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!decoder.stdin.write(Buffer.from(value))) await once(decoder.stdin, "drain");
      }
      decoder.stdin.end();
      const [code] = (await once(decoder, "close")) as [number | null];
      if (!stopped && code !== 0) throw new Error(`Audio decode failed: ${Buffer.concat(errors).toString("utf8").trim() || `ffmpeg exited ${code}`}`);
      queue.end();
    } catch (error) {
      if (!stopped) queue.fail(error);
      else queue.end();
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    chunks: queue,
    completed,
    stop: () => {
      stopped = true;
      void body.cancel().catch(() => undefined);
      decoder.kill("SIGTERM");
      queue.end();
    }
  };
}
