import { describe, expect, it } from "vitest";
import {
  ELEVENLABS_CREDITS_EXHAUSTED_MESSAGE,
  elevenLabsResponseError,
  isElevenLabsCreditsError
} from "./eleven-error";

describe("ElevenLabs API errors", () => {
  it("recognizes current and legacy credit errors", () => {
    expect(isElevenLabsCreditsError(402, { detail: { code: "insufficient_credits" } })).toBe(true);
    expect(isElevenLabsCreditsError(401, { detail: { status: "quota_exceeded" } })).toBe(true);
    expect(isElevenLabsCreditsError(429, { detail: { code: "rate_limit_exceeded" } })).toBe(false);
  });

  it("returns safe listener copy for an exhausted credit limit", async () => {
    const error = await elevenLabsResponseError(
      new Response(JSON.stringify({ detail: { type: "payment_required", code: "insufficient_credits" } }), { status: 402 }),
      "Eleven Music rejected track track-1"
    );
    expect(error.message).toBe(ELEVENLABS_CREDITS_EXHAUSTED_MESSAGE);
  });

  it("keeps non-credit provider detail for repair diagnostics", async () => {
    const error = await elevenLabsResponseError(
      new Response(JSON.stringify({ detail: { status: "bad_composition_plan" } }), { status: 422 }),
      "Eleven Music rejected track track-1"
    );
    expect(error.message).toContain("HTTP 422");
    expect(error.message).toContain("bad_composition_plan");
  });
});
