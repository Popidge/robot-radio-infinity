import { describe, expect, it } from "vitest";
import { MockLLMProvider } from "./llm";

describe("MockLLMProvider visual test data", () => {
  it("supplies timed lyric sections when a listener explicitly requests vocals", async () => {
    const provider = new MockLLMProvider();
    const plan = await provider.planInitialIntent({
      requestId: "opening",
      message: "bright broken beats with original vocals",
      showState: {
        presenter: { name: "DJ", identity: "Test presenter", voiceRules: ["Be concise"] },
        listener: { preferences: [], dislikes: [], callbacks: [], notablePhrases: [] },
        musicalThesis: { current: "Test", intendedTrajectory: [] },
        recentProductionFingerprints: [],
        recentLinkFingerprints: [],
        speechCadence: { lastCueAt: null, cooldownMs: 45_000, sessionTalkativeness: 0.5, cuesSpoken: 0 }
      }
    });

    expect(plan.musicalDirection.nextTrack.vocals).not.toBe("instrumental");
    expect(plan.musicalDirection.nextTrack.sections?.some((section) => section.lyrics)).toBe(true);
  });
});
