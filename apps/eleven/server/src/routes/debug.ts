import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { DebugLogger } from "../debug/logger";
import { readJson, sendError, sendJson } from "./http";

const transitionSchema = z.looseObject({
  sequence: z.number().int().nonnegative(),
  clientAt: z.number(),
  event: z.looseObject({ type: z.string() }),
  commands: z.array(z.looseObject({ type: z.string() })).max(50),
  state: z.looseObject({ phase: z.string(), running: z.boolean() })
});

const transitionBatchSchema = z.object({
  transitions: z.array(transitionSchema).min(1).max(100)
});

export async function handleDebugRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  logger: DebugLogger
): Promise<boolean> {
  if (pathname !== "/api/debug/station-transitions" || request.method !== "POST") return false;
  try {
    const batch = transitionBatchSchema.parse(await readJson(request));
    for (const transition of batch.transitions) {
      logger.log("debug", "station.transition", transition);
    }
    sendJson(response, 200, { ok: true, accepted: batch.transitions.length, runId: logger.runId });
  } catch (error) {
    logger.error("station.transition_rejected", error);
    sendError(response, error);
  }
  return true;
}
