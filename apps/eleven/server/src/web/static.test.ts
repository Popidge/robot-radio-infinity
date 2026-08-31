import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleWebRoute } from "./static";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function withStaticServer(root: string, test: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    void handleWebRoute(pathname, request, response, root).then((handled) => {
      if (handled) return;
      response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("production web route", () => {
  it("serves the Vite output and uses the index for client routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "robot-radio-web-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>Robot Radio</title>");
    writeFileSync(join(root, "assets", "app-123.js"), "console.log('radio')");

    await withStaticServer(root, async (baseUrl) => {
      const home = await fetch(baseUrl);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await home.text()).toContain("Robot Radio");

      const asset = await fetch(`${baseUrl}/assets/app-123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toContain("immutable");

      const clientRoute = await fetch(`${baseUrl}/station/live`);
      expect(clientRoute.status).toBe(200);
      expect(await clientRoute.text()).toContain("Robot Radio");

      expect((await fetch(`${baseUrl}/missing.js`)).status).toBe(404);
    });
  });
});
