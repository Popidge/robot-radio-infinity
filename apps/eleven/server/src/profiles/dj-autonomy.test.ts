import { describe, expect, it } from "vitest";
import {
  selectAutonomyMode,
  shouldAuthorizeAutonomousCue,
  type ProducerPlan,
  type ShowState
} from "@robot-radio/eleven-shared";
import { profilePlan, renderProfileMarkdown, type AutonomyProfile } from "./dj-autonomy";

const showState: ShowState = {
  presenter: { name: "DJ", identity: "Test presenter", voiceRules: ["Be concise"] },
  listener: { preferences: [], dislikes: [], callbacks: [], notablePhrases: [] },
  musicalThesis: { current: "Dub at night", intendedTrajectory: ["Deepen it"] },
  recentProductionFingerprints: ["Old Signal; dub; warm; 110 BPM"],
  recentLinkFingerprints: [],
  speechCadence: { lastCueAt: null, cooldownMs: 45_000, sessionTalkativeness: 0.5, cuesSpoken: 0 }
};

const plan: ProducerPlan = {
  musicalDirection: {
    intent: { description: "Dub at night", styles: ["dub"], mood: ["warm"], energy: 0.6 },
    nextTrack: {
      title: "New Signal",
      description: "Warm nocturnal dub with hand percussion",
      styles: ["dub"],
      mood: ["warm", "nocturnal"],
      energy: 0.62,
      bpm: 112,
      durationMs: 180_000,
      sections: [
        { name: "Intro", durationMs: 20_000, description: "Instrumental presenter ramp" },
        { name: "Body", durationMs: 140_000, description: "Full dub development" },
        { name: "Outro", durationMs: 20_000, description: "Clean resolved ending" }
      ]
    }
  },
  memoryUpdates: { productionFingerprint: "New Signal; hand percussion; 112 BPM" },
  editorialNotes: ["Keep the opening instrumental"],
  suggestedTiming: "continuity"
};

describe("DJ autonomy profiler", () => {
  it("uses the same deterministic mode boundaries as the live reducer", () => {
    expect(selectAutonomyMode({ tracksSinceListener: 1, silenceMs: 479_999 })).toBe("interactive");
    expect(selectAutonomyMode({ tracksSinceListener: 2, silenceMs: 1 })).toBe("cruise");
    expect(selectAutonomyMode({ tracksSinceListener: 0, silenceMs: 480_000 })).toBe("cruise");
    expect(selectAutonomyMode({ tracksSinceListener: 4, silenceMs: 1 })).toBe("exploratory");
    expect(selectAutonomyMode({ tracksSinceListener: 0, silenceMs: 1_080_000 })).toBe("exploratory");
    expect(shouldAuthorizeAutonomousCue({ mode: "interactive", listenerSilenceMs: 900_000, speechSilenceMs: 900_000 })).toBe(false);
    expect(shouldAuthorizeAutonomousCue({ mode: "cruise", listenerSilenceMs: 900_000, speechSilenceMs: 479_999 })).toBe(false);
    expect(shouldAuthorizeAutonomousCue({ mode: "cruise", listenerSilenceMs: 900_000, speechSilenceMs: 480_000 })).toBe(true);
  });

  it("profiles structural radiocraft and recent-output novelty without model calls", () => {
    const metrics = profilePlan(plan, {
      currentIntent: plan.musicalDirection.intent,
      showState,
      recentTitles: ["Old Signal"]
    });
    expect(metrics).toMatchObject({
      sectionCount: 3,
      durationDeltaMs: 0,
      hasInstrumentalOpening: true,
      hasDefinedEnding: true,
      repeatsRecentTitle: false,
      repeatsProductionFingerprint: false
    });
    expect(metrics.novelty).toBeGreaterThan(0);
    expect(metrics.intentCoverage).toBeGreaterThan(0);
  });

  it("renders a reviewable report with the model and scenario output", () => {
    const profile: AutonomyProfile = {
      generatedAt: "2026-09-01T00:00:00.000Z",
      model: "gpt-5.6-luna",
      calls: 1,
      thresholds: { cruiseTracks: 2, cruiseSilenceMs: 480_000, exploratoryTracks: 4, exploratorySilenceMs: 1_080_000 },
      scenarios: [{
        id: "test",
        description: "Test scenario",
        steps: [{
          scenario: "test",
          label: "Test horizon",
          kind: "continuity",
          atMs: 130_000,
          mode: "interactive",
          tracksSinceListener: 0,
          silenceMs: 130_000,
          latencyMs: 100,
          cueAuthorized: false,
          plan,
          metrics: profilePlan(plan, { currentIntent: plan.musicalDirection.intent, showState, recentTitles: [] })
        }]
      }],
      reviewFlags: []
    };
    const report = renderProfileMarkdown(profile);
    expect(report).toContain("gpt-5.6-luna");
    expect(report).toContain("New Signal");
    expect(report).toContain("Automated review flags");
  });
});
