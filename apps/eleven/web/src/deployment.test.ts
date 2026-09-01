import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production browser policy", () => {
  it("permits the bundled MP3 decoder without enabling JavaScript eval", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../../../vercel.json", import.meta.url), "utf8")
    ) as {
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    const policy = config.headers
      .flatMap((route) => route.headers)
      .find((header) => header.key.toLowerCase() === "content-security-policy")?.value;

    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("worker-src 'self' blob:");
  });
});
