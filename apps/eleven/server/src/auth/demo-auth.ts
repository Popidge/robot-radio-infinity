import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "../routes/http";

export const DEMO_AUTH_COOKIE = "robot_radio_access";
const COOKIE_CONTEXT = "robot-radio-infinity-demo-access-v1";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface DemoAuthStatus {
  passwordRequired: boolean;
  configured: boolean;
  authenticated: boolean;
}

interface DemoAuthOptions {
  password?: string;
  requirePassword?: boolean;
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function opaqueAccessToken(password: string): string {
  return createHmac("sha256", password).update(COOKIE_CONTEXT).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function requestIsSecure(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  if (protocol?.trim().toLowerCase() === "https") return true;
  return Boolean((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted);
}

function accessCookie(request: IncomingMessage, token: string, maxAge = COOKIE_MAX_AGE_SECONDS): string {
  return [
    `${DEMO_AUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    requestIsSecure(request) ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

export class DemoAuth {
  private readonly password: string;
  readonly passwordRequired: boolean;
  readonly configured: boolean;

  constructor(options: DemoAuthOptions = {}) {
    this.password = options.password ?? process.env.DEMO_PASSWORD ?? "";
    this.configured = this.password.length > 0;
    this.passwordRequired = options.requirePassword ?? (this.configured || Boolean(process.env.VERCEL));
  }

  status(request: IncomingMessage): DemoAuthStatus {
    return {
      passwordRequired: this.passwordRequired,
      configured: this.configured || !this.passwordRequired,
      authenticated: this.isAuthenticated(request)
    };
  }

  isAuthenticated(request: IncomingMessage): boolean {
    if (!this.passwordRequired) return true;
    if (!this.configured) return false;
    const supplied = cookieValue(request, DEMO_AUTH_COOKIE);
    return supplied !== undefined && safeEqual(supplied, opaqueAccessToken(this.password));
  }

  reject(request: IncomingMessage, response: ServerResponse): void {
    const status = this.configured ? 401 : 503;
    sendJson(response, status, {
      error: this.configured
        ? "Enter the demo password to start this private transmission."
        : "This private demo is not configured yet.",
      code: this.configured ? "AUTH_REQUIRED" : "AUTH_NOT_CONFIGURED",
      ...this.status(request)
    });
  }

  async handleRoute(
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<boolean> {
    if (pathname !== "/api/auth/session") return false;

    if (request.method === "GET") {
      sendJson(response, 200, this.status(request));
      return true;
    }

    if (request.method === "POST") {
      if (!this.passwordRequired) {
        sendJson(response, 200, this.status(request));
        return true;
      }
      if (!this.configured) {
        this.reject(request, response);
        return true;
      }

      let submitted = "";
      try {
        const body = await readJson(request);
        if (body && typeof body === "object" && "password" in body && typeof body.password === "string") {
          submitted = body.password;
        }
      } catch {
        sendJson(response, 400, { error: "The password request was not valid." });
        return true;
      }

      if (!safeEqual(submitted, this.password)) {
        sendJson(response, 401, { error: "That password is not right." });
        return true;
      }

      sendJson(response, 200, this.statusWithAuthentication(), {
        "set-cookie": accessCookie(request, opaqueAccessToken(this.password))
      });
      return true;
    }

    if (request.method === "DELETE") {
      sendJson(response, 200, { ...this.status(request), authenticated: false }, {
        "set-cookie": accessCookie(request, "", 0)
      });
      return true;
    }

    sendJson(response, 405, { error: "Method not allowed" }, { allow: "GET, POST, DELETE" });
    return true;
  }

  private statusWithAuthentication(): DemoAuthStatus {
    return { passwordRequired: this.passwordRequired, configured: true, authenticated: true };
  }
}

export function sameOriginWebSocket(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const forwardedHost = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(",")[0]?.trim()
    ?? request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
