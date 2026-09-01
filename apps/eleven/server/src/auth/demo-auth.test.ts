import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_AUTH_COOKIE, DemoAuth, sameOriginWebSocket } from "./demo-auth";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

async function withAuthServer(
  auth: DemoAuth,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (await auth.handleRoute(pathname, request, response)) return;
    if (!auth.isAuthenticated(request)) {
      auth.reject(request, response);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ paidRouteReached: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("demo password authentication", () => {
  it("sets an HttpOnly same-site cookie without storing the submitted password", async () => {
    await withAuthServer(new DemoAuth({ password: "broadcast-secret", requirePassword: true }), async (baseUrl) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
        body: JSON.stringify({ password: "broadcast-secret" })
      });
      const cookie = login.headers.get("set-cookie") ?? "";

      expect(login.status).toBe(200);
      expect(cookie).toContain(`${DEMO_AUTH_COOKIE}=`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
      expect(cookie).not.toContain("broadcast-secret");

      const paid = await fetch(`${baseUrl}/api/paid`, { headers: { cookie: cookie.split(";")[0] ?? "" } });
      expect(paid.status).toBe(200);
    });
  });

  it("rejects a wrong password and does not set a cookie", async () => {
    await withAuthServer(new DemoAuth({ password: "broadcast-secret", requirePassword: true }), async (baseUrl) => {
      const login = await fetch(`${baseUrl}/api/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" })
      });

      expect(login.status).toBe(401);
      expect(login.headers.get("set-cookie")).toBeNull();
      await expect(login.json()).resolves.toMatchObject({ error: "That password is not right." });
    });
  });

  it("fails closed on Vercel when the password is missing", async () => {
    process.env.VERCEL = "1";
    delete process.env.DEMO_PASSWORD;
    await withAuthServer(new DemoAuth(), async (baseUrl) => {
      const status = await fetch(`${baseUrl}/api/auth/session`);
      await expect(status.json()).resolves.toEqual({
        passwordRequired: true,
        configured: false,
        authenticated: false
      });
      expect((await fetch(`${baseUrl}/api/paid`)).status).toBe(503);
    });
  });

  it("keeps password-free local development available", async () => {
    delete process.env.VERCEL;
    delete process.env.DEMO_PASSWORD;
    await withAuthServer(new DemoAuth(), async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/paid`)).status).toBe(200);
    });
  });
});

describe("WebSocket origin policy", () => {
  function request(headers: IncomingMessage["headers"]): IncomingMessage {
    return { headers } as IncomingMessage;
  }

  it("accepts same-origin browser upgrades", () => {
    expect(sameOriginWebSocket(request({ origin: "https://radio.example", host: "radio.example" }))).toBe(true);
  });

  it("rejects cross-origin browser upgrades", () => {
    expect(sameOriginWebSocket(request({ origin: "https://attacker.example", host: "radio.example" }))).toBe(false);
  });
});
