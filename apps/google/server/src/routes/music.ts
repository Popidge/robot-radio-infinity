import type { IncomingMessage, ServerResponse } from "node:http";
import type { MusicProvider } from "@robot-radio/google-shared";
import type { DebugLogger } from "../debug/logger";
import { sendError, sendJson } from "./http";

export async function handleMusicRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  provider: MusicProvider,
  logger?: DebugLogger
): Promise<boolean> {
  const match = pathname.match(/^\/api\/music\/([^/]+)$/);
  if (!match || request.method !== "DELETE") return false;
  const trackId = decodeURIComponent(match[1] ?? "");
  const startedAt = performance.now();
  try {
    logger?.log("info", "music.cancel_started", { trackId });
    await provider.cancel(trackId);
    logger?.log("info", "music.cancel_completed", { trackId, durationMs: performance.now() - startedAt });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    logger?.error("music.cancel_failed", error, { trackId, durationMs: performance.now() - startedAt });
    if (logger) sendJson(response, 400, { error: logger.message(error) });
    else sendError(response, error);
  }
  return true;
}
