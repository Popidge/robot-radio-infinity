import type { IncomingMessage, ServerResponse } from "node:http";
import {
  continuityInputSchema,
  continuityPlanSchema,
  initialIntentInputSchema,
  initialIntentPlanSchema,
  urgencyAssessmentSchema,
  urgencyInputSchema,
  userIntentInputSchema,
  userIntentPlanSchema
} from "@robot-radio/shared";
import type { LLMProvider } from "@robot-radio/shared";
import type { DebugLogger } from "../debug/logger";
import { readJson, sendError, sendJson } from "./http";

export async function handleLLMRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  provider: LLMProvider,
  logger?: DebugLogger
): Promise<boolean> {
  if (request.method !== "POST") return false;
  const startedAt = performance.now();
  try {
    if (pathname === "/api/llm/initial-intent") {
      const input = initialIntentInputSchema.parse(await readJson(request));
      logger?.log("info", "llm.initial_intent_started", { requestId: input.requestId, input });
      const result = initialIntentPlanSchema.parse(await provider.planInitialIntent(input));
      logger?.log("info", "llm.initial_intent_completed", {
        requestId: input.requestId,
        durationMs: performance.now() - startedAt,
        result
      });
      sendJson(response, 200, result);
      return true;
    }
    if (pathname === "/api/llm/urgency") {
      const input = urgencyInputSchema.parse(await readJson(request));
      logger?.log("info", "llm.urgency_started", { requestId: input.requestId, input });
      const result = urgencyAssessmentSchema.parse(await provider.assessUrgency(input));
      logger?.log("info", "llm.urgency_completed", {
        requestId: input.requestId,
        durationMs: performance.now() - startedAt,
        result
      });
      sendJson(response, 200, result);
      return true;
    }
    if (pathname === "/api/llm/user-plan") {
      const input = userIntentInputSchema.parse(await readJson(request));
      logger?.log("info", "llm.user_plan_started", { requestId: input.requestId, input });
      const result = userIntentPlanSchema.parse(await provider.planUserIntent(input));
      logger?.log("info", "llm.user_plan_completed", {
        requestId: input.requestId,
        durationMs: performance.now() - startedAt,
        result
      });
      sendJson(response, 200, result);
      return true;
    }
    if (pathname === "/api/llm/continuity-plan") {
      const input = continuityInputSchema.parse(await readJson(request));
      logger?.log("info", "llm.continuity_plan_started", { requestId: input.requestId, input });
      const result = continuityPlanSchema.parse(await provider.planContinuity(input));
      logger?.log("info", "llm.continuity_plan_completed", {
        requestId: input.requestId,
        durationMs: performance.now() - startedAt,
        result
      });
      sendJson(response, 200, result);
      return true;
    }
  } catch (error) {
    logger?.error("llm.request_failed", error, { pathname, durationMs: performance.now() - startedAt });
    if (logger) sendJson(response, 400, { error: logger.message(error) });
    else sendError(response, error);
    return true;
  }
  return false;
}
