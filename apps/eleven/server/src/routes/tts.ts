import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http";

export function handleTTSRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  providerName: string
): boolean {
  if (pathname !== "/api/tts/health" || request.method !== "GET") return false;
  sendJson(response, 200, { provider: providerName, streaming: true });
  return true;
}
