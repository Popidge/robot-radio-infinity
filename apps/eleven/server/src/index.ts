import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import {
  trackSpecSchema,
  transitionSpecSchema,
  ttsRequestSchema,
  type AudioStream,
  type MusicStream
} from "@robot-radio/eleven-shared";
import { WebSocket, WebSocketServer } from "ws";
import { createDebugLogger } from "./debug/logger";
import { createProviders } from "./providers";
import { handleDebugRoute } from "./routes/debug";
import { handleLLMRoute } from "./routes/llm";
import { handleMusicRoute } from "./routes/music";
import { sendJson } from "./routes/http";
import { handleTTSRoute } from "./routes/tts";
import { handleWebRoute, webDistDirectory } from "./web/static";

type StreamKind = "music" | "transition" | "tts";

interface StreamContext {
  connectionId: string;
  kind: StreamKind;
  streamId: string;
}

async function sendBinary(webSocket: WebSocket, chunk: Uint8Array): Promise<void> {
  const payload = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  await new Promise<void>((resolve, reject) => {
    webSocket.send(payload, { binary: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const port = Number(process.env.PORT ?? 8787);
const logger = createDebugLogger();
const providers = (() => {
  try {
    return createProviders();
  } catch (error) {
    logger.error("server.provider_initialization_failed", error);
    if (logger.filePath) console.error(`Provider startup failed. Debug log: ${logger.filePath}`);
    logger.close();
    throw error;
  }
})();
const { music: musicProvider, transitions: transitionProvider, tts: ttsProvider, llm: llmProvider } = providers;

logger.log("info", "server.run_started", {
  pid: process.pid,
  nodeVersion: process.version,
  port,
  providers: providers.selections,
  models: {
    llm: process.env.OPENAI_LLM_MODEL ?? "gpt-5.6-luna",
    llmFast: process.env.OPENAI_FAST_LLM_MODEL ?? "gpt-5.6-luna",
    music: process.env.ELEVENLABS_MUSIC_MODEL ?? "music_v2",
    tts: process.env.ELEVENLABS_TTS_MODEL ?? "eleven_flash_v2_5"
  }
});

const server = createServer(async (request, response) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  logger.log("debug", "http.request_started", { requestId, method: request.method, pathname: url.pathname });
  response.once("finish", () => {
    logger.log("debug", "http.request_completed", {
      requestId,
      method: request.method,
      pathname: url.pathname,
      statusCode: response.statusCode,
      durationMs: performance.now() - startedAt
    });
  });

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS"
    });
    response.end();
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      runId: logger.runId,
      debugLog: logger.filePath,
      providers: { ...providers.selections }
    });
    return;
  }
  if (await handleDebugRoute(url.pathname, request, response, logger)) return;
  if (await handleLLMRoute(url.pathname, request, response, llmProvider, logger)) return;
  if (await handleMusicRoute(url.pathname, request, response, musicProvider, logger)) return;
  if (handleTTSRoute(url.pathname, request, response, providers.selections.tts)) return;
  if (await handleWebRoute(url.pathname, request, response)) return;
  sendJson(response, 404, { error: "Route not found" });
});

const webSocketServer = new WebSocketServer({ noServer: true });

async function pipeStream(
  webSocket: WebSocket,
  stream: MusicStream | AudioStream,
  context: StreamContext
): Promise<void> {
  const startedAt = performance.now();
  let firstChunkMs: number | null = null;
  let transportChunks = 0;
  let transportBytes = 0;
  let lastProgressAtMs = 0;
  let peakSocketBufferedBytes = 0;

  logger.log("info", "stream.started", {
    ...context,
    encoding: stream.encoding,
    sampleRate: stream.sampleRate,
    channels: stream.channels,
    declaredDurationMs: stream.durationMs
  });
  webSocket.send(
    JSON.stringify({
      type: "stream-start",
      id: stream.id,
      encoding: stream.encoding,
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      durationMs: stream.durationMs
    })
  );
  const unsubscribeMetadata = "subscribeMetadata" in stream
    ? stream.subscribeMetadata?.((metadata) => {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(JSON.stringify({ type: "stream-metadata", id: stream.id, ...metadata }));
        }
      })
    : undefined;

  try {
    for await (const chunk of stream.chunks) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        logger.log("warn", "stream.client_closed", { ...context, transportChunks, transportBytes });
        break;
      }
      const elapsedMs = performance.now() - startedAt;
      firstChunkMs ??= elapsedMs;
      transportChunks += 1;
      transportBytes += chunk.byteLength;
      await sendBinary(webSocket, chunk);
      peakSocketBufferedBytes = Math.max(peakSocketBufferedBytes, webSocket.bufferedAmount);

      if (transportChunks === 1) {
        logger.log("info", "stream.first_chunk", {
          ...context,
          encoding: stream.encoding,
          firstChunkMs,
          chunkBytes: chunk.byteLength
        });
      }
      if (elapsedMs - lastProgressAtMs >= 5_000) {
        lastProgressAtMs = elapsedMs;
        logger.log("debug", "stream.transport_progress", {
          ...context,
          encoding: stream.encoding,
          elapsedMs,
          transportChunks,
          transportBytes,
          socketBufferedBytes: webSocket.bufferedAmount,
          peakSocketBufferedBytes
        });
      }
    }
    const elapsedMs = performance.now() - startedAt;
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify({ type: "stream-end" }));
    logger.log("info", "stream.completed", {
      ...context,
      elapsedMs,
      firstChunkMs,
      encoding: stream.encoding,
      transportChunks,
      transportBytes,
      peakSocketBufferedBytes,
      clientConnected: webSocket.readyState === WebSocket.OPEN
    });
  } catch (error) {
    const expectedCancellation = webSocket.readyState !== WebSocket.OPEN
      && error instanceof Error
      && error.name === "AbortError";
    const failureContext = {
      ...context,
      elapsedMs: performance.now() - startedAt,
      firstChunkMs,
      encoding: stream.encoding,
      transportChunks,
      transportBytes,
      peakSocketBufferedBytes
    };
    if (expectedCancellation) logger.log("info", "stream.cancelled", failureContext);
    else logger.error("stream.failed", error, failureContext);
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify({ type: "stream-error", error: logger.message(error) }));
    }
  } finally {
    unsubscribeMetadata?.();
  }
}

webSocketServer.on("connection", async (webSocket, request) => {
  const connectionId = randomUUID();
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  logger.log("info", "websocket.connected", { connectionId, pathname: url.pathname });
  webSocket.once("close", (code, reason) => {
    logger.log("info", "websocket.closed", {
      connectionId,
      pathname: url.pathname,
      code,
      reason: reason.toString("utf8")
    });
  });

  try {
    const encoded = url.searchParams.get("payload") ?? "";
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") throw new Error("Stream payload must be an object");

    if (url.pathname === "/stream/music") {
      const spec = trackSpecSchema.parse("spec" in payload ? payload.spec : undefined);
      const generationRate = Number("generationRate" in payload ? payload.generationRate : 2.5);
      const context: StreamContext = { connectionId, kind: "music", streamId: spec.id };
      logger.log("info", "music.generation_requested", { ...context, spec, requestedGenerationRate: generationRate });
      const release = (): void => {
        logger.log("info", "music.cancel_on_disconnect", { ...context });
        void musicProvider.cancel(spec.id);
      };
      webSocket.once("close", release);
      const stream = await musicProvider.generate(spec, generationRate);
      if (webSocket.readyState !== WebSocket.OPEN) {
        release();
        return;
      }
      try {
        await pipeStream(webSocket, stream, context);
      } finally {
        webSocket.off("close", release);
        await musicProvider.cancel(spec.id);
        logger.log("debug", "music.provider_released", { ...context });
      }
      return;
    }

    if (url.pathname === "/stream/transition") {
      const spec = transitionSpecSchema.parse("spec" in payload ? payload.spec : undefined);
      const generationRate = Number("generationRate" in payload ? payload.generationRate : 5);
      const context: StreamContext = { connectionId, kind: "transition", streamId: spec.id };
      logger.log("info", "transition.generation_requested", { ...context, spec, requestedGenerationRate: generationRate });
      const release = (): void => {
        logger.log("info", "transition.cancel_on_disconnect", { ...context });
        void transitionProvider.cancel(spec.id);
      };
      webSocket.once("close", release);
      const stream = await transitionProvider.generate(spec, generationRate);
      if (webSocket.readyState !== WebSocket.OPEN) {
        release();
        return;
      }
      try {
        await pipeStream(webSocket, stream, context);
      } finally {
        webSocket.off("close", release);
        await transitionProvider.cancel(spec.id);
        logger.log("debug", "transition.provider_released", { ...context });
      }
      return;
    }

    if (url.pathname === "/stream/tts") {
      const requestPayload = ttsRequestSchema.parse(payload);
      const context: StreamContext = { connectionId, kind: "tts", streamId: requestPayload.id };
      logger.log("info", "tts.generation_requested", { ...context, text: requestPayload.text });
      const release = (): void => { void ttsProvider.cancel(requestPayload.id) };
      webSocket.once("close", release);
      try {
        await pipeStream(webSocket, await ttsProvider.speak(requestPayload.id, requestPayload.text), context);
      } finally {
        webSocket.off("close", release);
        await ttsProvider.cancel(requestPayload.id);
      }
      return;
    }
    logger.log("warn", "websocket.unknown_route", { connectionId, pathname: url.pathname });
    webSocket.close(1008, "Unknown stream route");
  } catch (error) {
    logger.error("websocket.request_failed", error, { connectionId, pathname: url.pathname });
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify({ type: "stream-error", error: logger.message(error) }));
      webSocket.close(1008, "Invalid stream request");
    }
  }
});

server.on("upgrade", (request, socket: Socket, head) => {
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.error("process.uncaught_exception", error, { origin });
});
process.on("warning", (warning) => {
  logger.error("process.warning", warning);
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log("info", "server.shutdown_started", { signal, openWebSockets: webSocketServer.clients.size });
  for (const client of webSocketServer.clients) client.close(1001, "Server shutting down");
  server.close(() => {
    logger.log("info", "server.shutdown_completed", { signal });
    logger.close();
  });
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", (code) => {
  logger.log("info", "server.process_exit", { code });
  logger.close();
});

server.listen(port, "0.0.0.0", () => {
  logger.log("info", "server.listening", { port, webDistDirectory: webDistDirectory() });
  console.log(`Robot Radio server listening on http://0.0.0.0:${port}`);
  if (logger.filePath) console.log(`Structured debug log: ${logger.filePath}`);
});
