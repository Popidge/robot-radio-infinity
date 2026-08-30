import type { IncomingMessage, ServerResponse } from "node:http";

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(body));
}

export function sendError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown server error";
  sendJson(response, 400, { error: message });
}
