import type { IncomingMessage, ServerResponse } from "node:http";
import { lyriaSteerSchema, type ContinuityProvider } from "@robot-radio/shared";
import type { DebugLogger } from "../debug/logger";
import { readJson, sendError, sendJson } from "./http";

export async function handleLyriaRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  provider: ContinuityProvider,
  logger?: DebugLogger
): Promise<boolean> {
  const match = pathname.match(/^\/api\/lyria\/([^/]+)\/(steer|stop)$/);
  if (!match || request.method !== "POST") return false;
  const id = decodeURIComponent(match[1] ?? "");
  const operation = match[2] as "steer" | "stop";
  const startedAt = performance.now();
  try {
    if (operation === "steer") {
      const plan = lyriaSteerSchema.parse(await readJson(request));
      logger?.log("info", "lyria.steer_started", { streamId: id, plan });
      await provider.steer(id, plan);
    } else {
      logger?.log("info", "lyria.stop_started", { streamId: id });
      await provider.stop(id);
    }
    logger?.log("info", `lyria.${operation}_completed`, { streamId: id, durationMs: performance.now() - startedAt });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    logger?.error(`lyria.${operation}_failed`, error, { streamId: id, durationMs: performance.now() - startedAt });
    if (logger) sendJson(response, 400, { error: logger.message(error) });
    else sendError(response, error);
  }
  return true;
}
