import { describe, expect, it } from "vitest";
import type { MusicalIntent, StationEvent, StationState, TrackDirective, TrackSpec, UserIntentPlan } from "@robot-radio/shared";
import { NORMAL_CROSSFADE_MS, UNDERRUN_THREAT_MS, compileTrackSpec, reduce } from "./reducer";
import { createInitialState } from "./state";

const intent: MusicalIntent = {
  description: "nocturnal analogue synth soul",
  styles: ["synth soul", "downtempo"],
  mood: ["warm", "nocturnal"],
  energy: 0.55,
  bpmRange: [104, 112],
  keyPreference: "E minor",
  vocals: "sparse original vocals",
  djTalkativeness: 0.4
};

const darkerIntent: MusicalIntent = {
  ...intent,
  description: "dark, heavy German dub-metal with broken reggae rhythm",
  styles: ["dub metal", "broken reggae"],
  mood: ["dark", "urgent"],
  energy: 0.9,
  bpmRange: [138, 148]
};

const nextDirective: TrackDirective = {
  title: "Iron After Midnight",
  description: darkerIntent.description,
  styles: darkerIntent.styles,
  mood: darkerIntent.mood,
  energy: darkerIntent.energy,
  bpm: 144,
  key: "D minor",
  durationMs: 180_000
};

const plan: UserIntentPlan = { destinationIntent: darkerIntent, nextTrack: nextDirective };

function playingState(remainingMs = 90_000): StationState {
  return {
    ...createInitialState(),
    running: true,
    phase: "playing",
    intent,
    intentRevision: 1,
    playback: {
      trackId: "current",
      title: "Signals Through Glass",
      playheadMs: 90_000,
      durationMs: 180_000,
      remainingMs,
      styleSummary: intent.description,
      bpm: 108,
      key: "E minor",
      energy: 0.55,
      bufferedMs: 90_000
    }
  };
}

function immediateAssessment() {
  return {
    timing: "immediate" as const,
    interruptCurrentTrack: true,
    confidence: 0.98,
    immediateTransition: {
      description: "Strip the warm pulse down and grow a distorted offbeat rhythm.",
      sourceSummary: intent.description,
      destinationSketch: darkerIntent.description,
      energyDirection: "up" as const
    }
  };
}

function event<T extends Omit<StationEvent, "at">>(value: T): StationEvent {
  return { ...value, at: 1_000 } as StationEvent;
}

describe("ElevenLabs station reducer", () => {
  it("turns the opening vibe into one track generation after the initial plan", () => {
    const started = reduce(createInitialState(), event({ type: "START_STATION", sessionId: "start-1", message: "rainy synth soul" }));
    expect(started.commands.map((command) => command.type)).toEqual(["PLAN_INITIAL_INTENT"]);

    const planned = reduce(started.state, event({
      type: "INITIAL_INTENT_RECEIVED",
      requestId: "start-1",
      plan: { intent, firstTrack: { title: "Wet Neon", description: intent.description } }
    }));
    expect(planned.commands[0]?.type).toBe("GENERATE_TRACK");
    expect(planned.state.nextTrack.spec?.title).toBe("Wet Neon");
  });

  it("starts urgency and full musical planning concurrently for each message", () => {
    const result = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "u1", message: "change this now" }));
    expect(result.commands.map((command) => command.type)).toEqual(["ASSESS_USER_MESSAGE", "PLAN_USER_INTENT"]);
    expect(result.state.intentRevision).toBe(2);
    expect(result.state.transition.status).toBe("none");
  });

  it("starts an immediate transition as soon as the fast classifier returns", () => {
    const requested = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "u1", message: "change this now" })).state;
    const classified = reduce(requested, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "u1", assessment: immediateAssessment() }));
    expect(classified.commands.map((command) => command.type)).toEqual(["GENERATE_TRANSITION"]);
    expect(classified.state.transition.spec?.instrumental).toBe(true);
    expect(classified.state.transition.spec?.durationMs).toBe(30_000);
  });

  it("does not duplicate the classifier-started transition when the full plan arrives", () => {
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "u1", message: "change this now" })).state;
    state = reduce(state, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "u1", assessment: immediateAssessment() })).state;
    const resolved = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "u1", plan }));
    expect(resolved.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK", "PLAN_DJ_LINE"]);
    expect(resolved.state.nextTrack.spec?.description).toBe(darkerIntent.description);
    expect(resolved.state.intent).toEqual(darkerIntent);
  });

  it("holds a ready replacement until the transition has played its safe minimum", () => {
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "u1", message: "change this now" })).state;
    state = reduce(state, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "u1", assessment: immediateAssessment() })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "u1", plan })).state;
    const revision = state.intentRevision;
    const transitionId = state.transition.transitionId!;
    const trackId = state.nextTrack.trackId!;

    const trackReady = reduce(state, event({ type: "TRACK_READY", trackId, revision }));
    expect(trackReady.commands).toEqual([]);
    const bridgeReady = reduce(trackReady.state, event({ type: "TRANSITION_READY", transitionId, revision }));
    expect(bridgeReady.commands[0]?.type).toBe("PLAY_TRANSITION");
    const audible = reduce(bridgeReady.state, event({ type: "TRANSITION_STARTED", transitionId, revision })).state;
    const stillAudible = reduce(audible, event({
      type: "TRANSITION_BUFFER_UPDATED", transitionId, revision, bufferedMs: 20_000, generatedMs: 30_000, generationRate: 5
    })).state;
    expect(stillAudible.transition.status).toBe("audible");
    const safe = reduce(stillAudible, event({ type: "TRANSITION_MINIMUM_PLAYED", transitionId, revision }));
    expect(safe.commands.some((command) => command.type === "FADE" && command.from === "transition" && command.to === "track")).toBe(true);
    const started = reduce(safe.state, event({ type: "TRACK_STARTED", trackId, revision, spec: safe.state.nextTrack.spec! }));
    expect(started.state.transition.status).toBe("none");
    expect(started.state.phase).toBe("playing");
  });

  it("defers a future request and lets the horizon generate it naturally", () => {
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "u2", message: "from now on, make it darker" })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "u2", plan })).state;
    const resolved = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "u2",
      assessment: { timing: "future", interruptCurrentTrack: false, confidence: 0.9 }
    }));
    expect(resolved.commands).toEqual([]);
    expect(resolved.state.queuedDirective?.title).toBe(nextDirective.title);

    const horizon = reduce(resolved.state, event({ type: "NEXT_TRACK_HORIZON", requestId: "h1", trackId: "current" }));
    expect(horizon.commands[0]?.type).toBe("GENERATE_TRACK");
    expect(horizon.state.queuedDirective).toBeUndefined();
  });

  it("promotes a next-track request near the horizon to a generated bridge", () => {
    let state = reduce(playingState(55_000), event({ type: "USER_MESSAGE", requestId: "u3", message: "next one should be much heavier" })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "u3", plan })).state;
    const resolved = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "u3",
      assessment: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.95 }
    }));
    expect(resolved.commands.map((command) => command.type)).toEqual(["GENERATE_TRANSITION", "GENERATE_TRACK", "PLAN_DJ_LINE"]);
    expect(resolved.state.pendingUser?.resolution).toBe("next");
  });

  it("generates an emergency transition when a pending stream threatens underrun", () => {
    const spec = compileTrackSpec("next", 1, nextDirective, darkerIntent);
    const state: StationState = {
      ...playingState(UNDERRUN_THREAT_MS - 1),
      nextTrack: { status: "buffering", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 2_000, generatedMs: 2_000 }
    };
    const result = reduce(state, event({ type: "TRACK_PROGRESS", trackId: "current", playheadMs: 170_000, remainingMs: UNDERRUN_THREAT_MS - 1, bufferedMs: 5_000 }));
    expect(result.commands[0]?.type).toBe("GENERATE_TRANSITION");
    expect(result.state.transition.spec?.reason).toBe("underrun");
  });

  it("crossfades a healthy normal next track only at the end of the current track", () => {
    const spec: TrackSpec = compileTrackSpec("next", 1, nextDirective, darkerIntent);
    const state: StationState = {
      ...playingState(NORMAL_CROSSFADE_MS),
      nextTrack: { status: "ready", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 20_000, generatedMs: 30_000 }
    };
    const result = reduce(state, event({ type: "TRACK_PROGRESS", trackId: "current", playheadMs: 177_000, remainingMs: NORMAL_CROSSFADE_MS, bufferedMs: 8_000 }));
    expect(result.commands).toContainEqual({ type: "FADE", from: "track", to: "track", trackId: "next", durationMs: NORMAL_CROSSFADE_MS });
    expect(result.commands.some((command) => command.type === "GENERATE_TRANSITION")).toBe(false);
  });

  it("ignores stale provider events after a newer listener request", () => {
    const first = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "old", message: "change now" })).state;
    const oldClassified = reduce(first, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "old", assessment: immediateAssessment() })).state;
    const newer = reduce(oldClassified, event({ type: "USER_MESSAGE", requestId: "new", message: "actually, calm jazz" })).state;
    const stale = reduce(newer, event({ type: "USER_PLAN_RECEIVED", requestId: "old", plan }));
    expect(stale.commands).toEqual([]);
    expect(stale.state.intentRevision).toBe(3);
    expect(stale.state.nextTrack.status).toBe("none");
  });

  it("asks the LLM to repair an explicit provider policy rejection", () => {
    const spec = compileTrackSpec("next", 1, nextDirective, darkerIntent);
    const state: StationState = {
      ...playingState(),
      nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
    };

    const result = reduce(state, event({
      type: "TRACK_GENERATION_FAILED",
      trackId: spec.id,
      revision: spec.revision,
      error: 'Eleven Music rejected track with HTTP 422: {"detail":{"status":"bad_composition_plan"}}'
    }));

    expect(result.commands[0]?.type).toBe("REPAIR_TRACK_SPEC");
    expect(result.state.nextTrack.status).toBe("planning");
    expect(result.state.nextTrack.repairAttempts).toBe(1);
  });

  it("does not spend an LLM repair call on a technical provider failure", () => {
    const spec = compileTrackSpec("next", 1, nextDirective, darkerIntent);
    const state: StationState = {
      ...playingState(),
      nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
    };

    const result = reduce(state, event({
      type: "TRACK_GENERATION_FAILED",
      trackId: spec.id,
      revision: spec.revision,
      error: 'Eleven Music rejected track with HTTP 500: {"status":"internal_server_error"}'
    }));

    expect(result.commands).toEqual([]);
    expect(result.state.nextTrack.status).toBe("failed");
    expect(result.state.nextTrack.repairAttempts).toBeUndefined();
  });
});
