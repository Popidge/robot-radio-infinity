import { describe, expect, it } from "vitest";
import { trackDirectiveSchema, type TrackSpec } from "@robot-radio/google-shared";
import { compileLyria3Prompt } from "./prompt-compiler";

const spec: TrackSpec = {
  id: "titanic-fly-monster",
  title: "The Titanic Fly Monster",
  description: "Angular comedy prog with elastic bass and theatrical vocals",
  styles: ["progressive metal", "comedy rock"],
  mood: ["playful", "dramatic"],
  energy: 0.86,
  bpm: 132,
  key: "E minor",
  vocals: "A detailed theatrical vocal direction that can safely exceed the old arbitrary one-hundred-and-twenty-character limit without invalidating the complete musical plan",
  durationMs: 180_000
};

describe("Google music prompt compiler", () => {
  it("passes the planned track title to Lyria as creative context", () => {
    const prompt = compileLyria3Prompt(spec);

    expect(prompt).toContain('Working title: "The Titanic Fly Monster"');
    expect(prompt).toContain("Musical direction: Angular comedy prog");
  });

  it("accepts a detailed vocal direction without rejecting the complete plan", () => {
    expect(() => trackDirectiveSchema.parse(spec)).not.toThrow();
  });
});
