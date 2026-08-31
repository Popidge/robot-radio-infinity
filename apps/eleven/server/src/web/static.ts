import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp"
};

export function webDistDirectory(cwd = process.cwd()): string {
  if (process.env.ROBOT_RADIO_WEB_DIST_DIR) {
    return resolve(cwd, process.env.ROBOT_RADIO_WEB_DIST_DIR);
  }
  const rootCandidate = resolve(cwd, "apps/eleven/web/dist");
  if (existsSync(rootCandidate)) return rootCandidate;
  const packageCandidate = resolve(cwd, "../web/dist");
  if (existsSync(packageCandidate)) return packageCandidate;
  return rootCandidate;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function safePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidate = resolve(root, decoded.replace(/^\/+/, ""));
  const fromRoot = relative(root, candidate);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return candidate;
}

export async function handleWebRoute(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  root = webDistDirectory()
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (pathname.startsWith("/api/") || pathname.startsWith("/stream/")) return false;

  const requestedPath = safePath(root, pathname === "/" ? "/index.html" : pathname);
  if (!requestedPath) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid path");
    return true;
  }

  let filePath = requestedPath;
  if (!(await isFile(filePath))) {
    if (extname(pathname)) return false;
    filePath = resolve(root, "index.html");
    if (!(await isFile(filePath))) return false;
  }

  const body = await readFile(filePath);
  const extension = extname(filePath).toLowerCase();
  response.writeHead(200, {
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "content-length": String(body.byteLength),
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  });
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}
