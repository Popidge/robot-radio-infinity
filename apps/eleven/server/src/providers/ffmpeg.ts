import { existsSync } from "node:fs";
import ffmpegStaticPath from "ffmpeg-static";

export function resolveFfmpegExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.FFMPEG_PATH) return environment.FFMPEG_PATH;
  return ffmpegStaticPath && existsSync(ffmpegStaticPath) ? ffmpegStaticPath : "ffmpeg";
}
