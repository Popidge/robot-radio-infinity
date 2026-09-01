import { describe, expect, it } from "vitest";
import type {
  MusicalIntent,
  ProducerPlan,
  StationCommand,
  StationEvent,
  StationState,
  TrackDirective,
  TrackSpec
} from "@robot-radio/eleven-shared";
import {
  MAX_TRACK_REPAIR_ATTEMPTS,
  NEXT_TRACK_HORIZON_MS,
  NEXT_TRACK_REQUEST_GUARD_MS,
  NORMAL_CROSSFADE_MS,
  UNDERRUN_THREAT_MS,
  compileTrackSpec,
  reduce
} from "./reducer";
import { createInitialState } from "./state";
import { makeProducerPlan } from "./test-support";

const intent: MusicalIntent = {
  description: "patient nocturnal synth soul",
  styles: ["synth soul", "downtempo"],
  mood: ["warm", "nocturnal"],
  energy: 0.52,
  bpmRange: [104, 112],
  keyPreference: "E minor",
  vocals: "sparse original vocals",
  language: "English"
};

const continuation: TrackDirective = {
  title: "Soft Voltage",
  description: "patient nocturnal synth soul with a brighter analogue hook",
  styles: intent.styles,
  mood: intent.mood,
  energy: 0.56,
  bpm: 110,
  key: "E minor",
  vocals: intent.vocals,
  language: intent.language,
  durationMs: 180_000
};

const harderIntent: MusicalIntent = {
  ...intent,
  description: "high-speed distorted industrial hardcore",
  styles: ["industrial hardcore", "gabber"],
  mood: ["ferocious", "euphoric"],
  energy: 0.98,
  bpmRange: [182, 194],
  vocals: "instrumental"
};

const harderTrack: TrackDirective = {
  title: "Concrete Halo",
  description: harderIntent.description,
  styles: harderIntent.styles,
  mood: harderIntent.mood,
  energy: harderIntent.energy,
  bpm: 188,
  key: "F minor",
  vocals: harderIntent.vocals,
  durationMs: 180_000
};

const harderPlan: ProducerPlan = makeProducerPlan(harderIntent, harderTrack);

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
      playheadMs: 180_000 - remainingMs,
      durationMs: 180_000,
      remainingMs,
      styleSummary: intent.description,
      bpm: 108,
      key: "E minor",
      energy: 0.52,
      bufferedMs: remainingMs
    }
  };
}

function event<T extends Omit<StationEvent, "at">>(value: T, at = 1_000): StationEvent {
  return { ...value, at } as StationEvent;
}

function commandsOfType<T extends StationCommand["type"]>(commands: StationCommand[], type: T): Extract<StationCommand, { type: T }>[] {
  return commands.filter((command): command is Extract<StationCommand, { type: T }> => command.type === type);
}

function requestImmediate(state: StationState, requestId = "immediate"): StationState {
  state = reduce(state, event({ type: "USER_MESSAGE", requestId, message: "Harder, right now." })).state;
  state = reduce(state, event({
    type: "URGENCY_ASSESSMENT_RECEIVED",
    requestId,
    assessment: {
      timing: "immediate",
      interruptCurrentTrack: true,
      confidence: 0.99,
      immediateTransition: {
        description: "Accelerate through an instrumental wall of percussion.",
        sourceSummary: intent.description,
        destinationSketch: harderIntent.description,
        energyDirection: "up"
      }
    }
  })).state;
  return reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId, plan: harderPlan })).state;
}

describe("station reducer normal lifecycles", () => {
  it("runs a complete gapless opening and hands-off track-to-track lifecycle", () => {
    const started = reduce(createInitialState(), event({ type: "START_STATION", sessionId: "session", message: "Warm synth soul." }));
    expect(started.commands.map((command) => command.type)).toEqual(["PLAN_INITIAL_INTENT"]);

    const openingPlanned = reduce(started.state, event({
      type: "INITIAL_INTENT_RECEIVED",
      requestId: "session",
      plan: makeProducerPlan(intent, { ...continuation, title: "Signals Through Glass" }, { suggestedTiming: "opening" })
    }));
    const openingGeneration = commandsOfType(openingPlanned.commands, "GENERATE_TRACK");
    expect(openingGeneration).toHaveLength(1);
    const openingSpec = openingGeneration[0]!.spec;
    expect(openingSpec.programmeId).toBe("session");

    const openingReady = reduce(openingPlanned.state, event({ type: "TRACK_READY", trackId: openingSpec.id, revision: openingSpec.revision }));
    expect(openingReady.commands).toEqual([{ type: "PLAY_TRACK", trackId: openingSpec.id, durationMs: 500 }]);
    const openingStarted = reduce(openingReady.state, event({ type: "TRACK_STARTED", trackId: openingSpec.id, revision: openingSpec.revision, spec: openingSpec }));
    expect(openingStarted.state.phase).toBe("playing");
    expect(openingStarted.state.nextTrack.status).toBe("none");

    const horizon = reduce(openingStarted.state, event({ type: "NEXT_TRACK_HORIZON", requestId: "horizon-1", trackId: openingSpec.id }));
    expect(horizon.commands.map((command) => command.type)).toEqual(["PLAN_CONTINUITY"]);
    const continuityPlan = makeProducerPlan(intent, continuation, { suggestedTiming: "continuity" });
    const nextPlanned = reduce(horizon.state, event({ type: "CONTINUITY_PLAN_RECEIVED", requestId: "horizon-1", plan: continuityPlan }));
    expect(nextPlanned.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK"]);
    const nextSpec = commandsOfType(nextPlanned.commands, "GENERATE_TRACK")[0]!.spec;
    expect(nextSpec.programmeId).toBe("horizon-1");

    let state = reduce(nextPlanned.state, event({ type: "TRACK_FIRST_AUDIO", trackId: nextSpec.id, revision: nextSpec.revision, latencyMs: 3_500 })).state;
    state = reduce(state, event({ type: "TRACK_BUFFER_UPDATED", trackId: nextSpec.id, revision: nextSpec.revision, bufferedMs: 12_000, generatedMs: 18_000, generationRate: 5 })).state;
    const readyEarly = reduce(state, event({ type: "TRACK_READY", trackId: nextSpec.id, revision: nextSpec.revision }));
    expect(readyEarly.commands).toEqual([]);
    expect(readyEarly.state.nextTrack.status).toBe("ready");

    const beforeFade = reduce(readyEarly.state, event({
      type: "TRACK_PROGRESS",
      trackId: openingSpec.id,
      playheadMs: 175_999,
      remainingMs: NORMAL_CROSSFADE_MS + 1_001,
      bufferedMs: 20_000
    }));
    expect(beforeFade.commands).toEqual([]);
    const fade = reduce(beforeFade.state, event({
      type: "TRACK_PROGRESS",
      trackId: openingSpec.id,
      playheadMs: 176_000,
      remainingMs: NORMAL_CROSSFADE_MS + 1_000,
      bufferedMs: 20_000
    }));
    expect(fade.commands).toEqual([{ type: "FADE", from: "track", to: "track", trackId: nextSpec.id, durationMs: NORMAL_CROSSFADE_MS }]);

    const nextStarted = reduce(fade.state, event({ type: "TRACK_STARTED", trackId: nextSpec.id, revision: nextSpec.revision, spec: nextSpec }));
    expect(nextStarted.state.phase).toBe("playing");
    expect(nextStarted.state.playback.title).toBe(continuation.title);
    expect(nextStarted.state.recentTracks.at(-1)?.title).toBe("Signals Through Glass");
    expect(nextStarted.state.horizonFiredForTrackId).toBeNull();
    expect(nextStarted.state.nextTrack.status).toBe("none");
  });

  it("uses a matched underrun transition until the slow next track is safely playable", () => {
    const nextSpec = compileTrackSpec("slow-next", 1, continuation, intent, "horizon-slow");
    const state: StationState = {
      ...playingState(UNDERRUN_THREAT_MS - 1),
      nextTrack: { status: "buffering", trackId: nextSpec.id, revision: nextSpec.revision, spec: nextSpec, bufferedMs: 2_000, generatedMs: 3_000 }
    };
    const threatened = reduce(state, event({
      type: "TRACK_PROGRESS",
      trackId: "current",
      playheadMs: 170_000,
      remainingMs: UNDERRUN_THREAT_MS - 1,
      bufferedMs: 4_000
    }));
    const transitionGeneration = commandsOfType(threatened.commands, "GENERATE_TRANSITION");
    expect(transitionGeneration).toHaveLength(1);
    const transitionSpec = transitionGeneration[0]!.spec;
    expect(transitionSpec.programmeId).toBe(nextSpec.programmeId);

    const transitionReady = reduce(threatened.state, event({
      type: "TRANSITION_READY",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision
    }));
    expect(commandsOfType(transitionReady.commands, "PLAY_TRANSITION")).toHaveLength(1);
    const transitionStarted = reduce(transitionReady.state, event({
      type: "TRANSITION_STARTED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision
    })).state;

    const trackReady = reduce(transitionStarted, event({ type: "TRACK_READY", trackId: nextSpec.id, revision: nextSpec.revision }));
    expect(trackReady.commands).toEqual([]);
    const minimumPlayed = reduce(trackReady.state, event({
      type: "TRANSITION_MINIMUM_PLAYED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision
    }));
    expect(minimumPlayed.commands).toContainEqual({
      type: "FADE",
      from: "transition",
      to: "track",
      trackId: nextSpec.id,
      durationMs: NORMAL_CROSSFADE_MS
    });
  });

  it("keeps conversation-only messages out of the musical pipeline", () => {
    const conversationPlan = makeProducerPlan(intent, harderTrack, {
      onAirCue: { text: "It has found its voltage, hasn’t it?", purpose: "listener_acknowledgement" },
      suggestedTiming: "conversation_only"
    });
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "chat", message: "This is fantastic." })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "chat", plan: conversationPlan })).state;
    const classified = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "chat",
      assessment: { timing: "conversation_only", interruptCurrentTrack: false, confidence: 0.99 }
    }));

    expect(classified.commands.map((command) => command.type)).toEqual(["PREPARE_SPEECH"]);
    expect(classified.state.intent).toEqual(intent);
    expect(classified.state.nextTrack.status).toBe("none");
    expect(classified.state.transition.status).toBe("none");
    expect(classified.state.dj.prepared).toMatchObject({ status: "preparing", purpose: "listener_acknowledgement" });
  });

  it.each([
    [NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS + 1, "deferred", []],
    [NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS, "next", ["GENERATE_TRANSITION", "GENERATE_TRACK"]]
  ] as const)("handles a next-track request at the promotion boundary (%i ms)", (remainingMs, resolution, commandTypes) => {
    let state = reduce(playingState(remainingMs), event({ type: "USER_MESSAGE", requestId: "boundary", message: "Make the next one harder." })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "boundary", plan: harderPlan })).state;
    const classified = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "boundary",
      assessment: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.98 }
    }));
    expect(classified.state.pendingUser?.resolution).toBe(resolution);
    expect(classified.commands.map((command) => command.type)).toEqual(commandTypes);
  });

  it("tracks stream telemetry without allowing late updates to regress readiness", () => {
    const nextSpec = compileTrackSpec("telemetry-track", 1, continuation, intent, "telemetry-programme");
    let state: StationState = {
      ...playingState(),
      nextTrack: { status: "generating", trackId: nextSpec.id, revision: nextSpec.revision, spec: nextSpec, bufferedMs: 0, generatedMs: 0 }
    };
    state = reduce(state, event({ type: "TRACK_GENERATION_STARTED", trackId: nextSpec.id, revision: 1, spec: nextSpec })).state;
    state = reduce(state, event({ type: "TRACK_FIRST_AUDIO", trackId: nextSpec.id, revision: 1, latencyMs: 3_250 })).state;
    state = reduce(state, event({
      type: "TRACK_BUFFER_UPDATED",
      trackId: nextSpec.id,
      revision: 1,
      bufferedMs: 12_000,
      generatedMs: 20_000,
      generationRate: 5.2
    })).state;
    state = reduce(state, event({ type: "TRACK_DURATION_RESOLVED", trackId: nextSpec.id, revision: 1, durationMs: 177_400 })).state;
    state = reduce(state, event({ type: "TRACK_READY", trackId: nextSpec.id, revision: 1 })).state;
    const lateBuffer = reduce(state, event({
      type: "TRACK_BUFFER_UPDATED",
      trackId: nextSpec.id,
      revision: 1,
      bufferedMs: 18_000,
      generatedMs: 30_000,
      generationRate: 4.9
    }));

    expect(lateBuffer.state.nextTrack).toMatchObject({
      status: "ready",
      firstAudioMs: 3_250,
      bufferedMs: 18_000,
      generatedMs: 30_000,
      generationRate: 4.9,
      spec: { durationMs: 177_400, programmeId: "telemetry-programme" }
    });
    expect(lateBuffer.commands).toEqual([]);
  });

  it("keeps transition telemetry in starting and audible states after readiness", () => {
    let state = requestImmediate(playingState());
    const transitionSpec = state.transition.spec!;
    state = reduce(state, event({
      type: "TRANSITION_GENERATION_STARTED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision,
      spec: transitionSpec
    })).state;
    state = reduce(state, event({ type: "TRANSITION_FIRST_AUDIO", transitionId: transitionSpec.id, revision: transitionSpec.revision, latencyMs: 2_900 })).state;
    state = reduce(state, event({
      type: "TRANSITION_BUFFER_UPDATED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision,
      bufferedMs: 9_000,
      generatedMs: 12_000,
      generationRate: 4.1
    })).state;
    const ready = reduce(state, event({ type: "TRANSITION_READY", transitionId: transitionSpec.id, revision: transitionSpec.revision }));
    expect(ready.state.transition.status).toBe("starting");
    const lateStartingBuffer = reduce(ready.state, event({
      type: "TRANSITION_BUFFER_UPDATED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision,
      bufferedMs: 14_000,
      generatedMs: 20_000,
      generationRate: 4.5
    }));
    expect(lateStartingBuffer.state.transition.status).toBe("starting");

    const audible = reduce(lateStartingBuffer.state, event({
      type: "TRANSITION_STARTED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision
    })).state;
    const lateAudibleBuffer = reduce(audible, event({
      type: "TRANSITION_BUFFER_UPDATED",
      transitionId: transitionSpec.id,
      revision: transitionSpec.revision,
      bufferedMs: 18_000,
      generatedMs: 26_000,
      generationRate: 4.8
    }));
    expect(lateAudibleBuffer.state.transition).toMatchObject({ status: "audible", firstAudioMs: 2_900, bufferedMs: 18_000 });
  });

  it("uses a ready safety track at the final crossfade point and preserves an unresolved immediate request", () => {
    const safetySpec = compileTrackSpec("safe-next", 1, continuation, intent, "horizon-safe");
    const state: StationState = {
      ...playingState(NORMAL_CROSSFADE_MS + 1_000),
      horizonFiredForTrackId: "current",
      nextTrack: { status: "ready", trackId: safetySpec.id, revision: safetySpec.revision, spec: safetySpec, bufferedMs: 20_000, generatedMs: 30_000 }
    };
    const requested = reduce(state, event({ type: "USER_MESSAGE", requestId: "last-second", message: "Gabber now." }));
    expect(requested.commands.map((command) => command.type)).toEqual(["ASSESS_USER_MESSAGE", "PLAN_USER_INTENT", "FADE"]);
    expect(commandsOfType(requested.commands, "FADE")[0]?.trackId).toBe(safetySpec.id);

    const safetyStarted = reduce(requested.state, event({
      type: "TRACK_STARTED",
      trackId: safetySpec.id,
      revision: safetySpec.revision,
      spec: safetySpec
    }));
    expect(safetyStarted.state.pendingUser?.requestId).toBe("last-second");
    expect(safetyStarted.state.pendingUser?.applied).toBe(false);
    expect(safetyStarted.state.playback.trackId).toBe(safetySpec.id);

    const classified = reduce(safetyStarted.state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "last-second",
      assessment: {
        timing: "immediate",
        interruptCurrentTrack: true,
        confidence: 0.99,
        immediateTransition: {
          description: "Accelerate rapidly into distorted hardcore.",
          sourceSummary: continuation.description,
          destinationSketch: harderIntent.description,
          energyDirection: "up"
        }
      }
    }));
    expect(commandsOfType(classified.commands, "GENERATE_TRANSITION")).toHaveLength(1);
  });
});

describe("station reducer failure and end-of-audio safety", () => {
  it("falls directly into a ready replacement if an immediate transition fails", () => {
    let state = requestImmediate(playingState());
    const transitionId = state.transition.transitionId!;
    const trackId = state.nextTrack.trackId!;
    const revision = state.intentRevision;
    state = reduce(state, event({
      type: "TRANSITION_GENERATION_FAILED",
      transitionId,
      revision,
      error: "Transition provider disconnected"
    })).state;
    const ready = reduce(state, event({ type: "TRACK_READY", trackId, revision }));

    expect(ready.commands).toContainEqual({ type: "FADE", from: "track", to: "track", trackId, durationMs: NORMAL_CROSSFADE_MS });
    expect(ready.state.phase).toBe("handoff");
  });

  it("starts a ready transition immediately when the current track ends", () => {
    let state = reduce(playingState(20_000), event({ type: "USER_MESSAGE", requestId: "ending", message: "Change now." })).state;
    state = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "ending",
      assessment: {
        timing: "immediate",
        interruptCurrentTrack: true,
        confidence: 0.99,
        immediateTransition: {
          description: "Keep a continuous instrumental bed while changing direction.",
          sourceSummary: intent.description,
          destinationSketch: harderIntent.description,
          energyDirection: "up"
        }
      }
    })).state;
    const transitionId = state.transition.transitionId!;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision })).state;
    expect(state.transition.status).toBe("ready");

    const ended = reduce(state, event({ type: "TRACK_ENDED", trackId: "current" }));
    expect(ended.commands).toEqual([{
      type: "PLAY_TRANSITION",
      transitionId,
      durationMs: 250,
      minimumPlayMs: 8_000
    }]);
    expect(ended.state.transition.status).toBe("starting");
  });

  it("starts a ready next track rather than declaring dead air when the current track ends", () => {
    const nextSpec = compileTrackSpec("ready-next", 1, continuation, intent, "horizon-ready");
    const state: StationState = {
      ...playingState(1_000),
      nextTrack: { status: "ready", trackId: nextSpec.id, revision: nextSpec.revision, spec: nextSpec, bufferedMs: 20_000, generatedMs: 30_000 }
    };
    const ended = reduce(state, event({ type: "TRACK_ENDED", trackId: "current" }));
    expect(ended.commands).toEqual([{ type: "PLAY_TRACK", trackId: nextSpec.id, durationMs: 250 }]);
    expect(ended.state.phase).toBe("handoff");
  });

  it("enters an inspectable error state when audio ends with no recovery stream", () => {
    const ended = reduce(playingState(1_000), event({ type: "TRACK_ENDED", trackId: "current" }));
    expect(ended.commands).toEqual([]);
    expect(ended.state.phase).toBe("error");
    expect(ended.state.error).toMatch(/before another playable stream was ready/i);
  });

  it("hands off at transition end only when the destination programme matches and is ready", () => {
    let state = requestImmediate(playingState());
    const transitionId = state.transition.transitionId!;
    const trackId = state.nextTrack.trackId!;
    const revision = state.intentRevision;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision })).state;
    state = reduce(state, event({ type: "TRANSITION_STARTED", transitionId, revision })).state;
    state = reduce(state, event({ type: "TRACK_READY", trackId, revision })).state;

    const ended = reduce(state, event({ type: "TRANSITION_ENDED", transitionId, revision }));
    expect(ended.commands).toContainEqual({ type: "FADE", from: "transition", to: "track", trackId, durationMs: NORMAL_CROSSFADE_MS });
    expect(ended.state.phase).toBe("handoff");
  });

  it("reports an exhausted transition instead of playing an unmatched or unavailable track", () => {
    let state = requestImmediate(playingState());
    const transitionId = state.transition.transitionId!;
    const revision = state.intentRevision;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision })).state;
    state = reduce(state, event({ type: "TRANSITION_STARTED", transitionId, revision })).state;

    const ended = reduce(state, event({ type: "TRANSITION_ENDED", transitionId, revision }));
    expect(ended.commands).toEqual([]);
    expect(ended.state.phase).toBe("error");
    expect(ended.state.error).toMatch(/transition ended before replacement music was ready/i);
  });

  it("does not issue a second handoff when readiness is reported again", () => {
    const nextSpec = compileTrackSpec("ready-next", 1, continuation, intent, "horizon-ready");
    const state: StationState = {
      ...playingState(NORMAL_CROSSFADE_MS),
      nextTrack: { status: "buffering", trackId: nextSpec.id, revision: nextSpec.revision, spec: nextSpec, bufferedMs: 20_000, generatedMs: 30_000 }
    };
    const firstReady = reduce(state, event({ type: "TRACK_READY", trackId: nextSpec.id, revision: 1 }));
    expect(commandsOfType(firstReady.commands, "FADE")).toHaveLength(1);
    const duplicateReady = reduce(firstReady.state, event({ type: "TRACK_READY", trackId: nextSpec.id, revision: 1 }));
    expect(duplicateReady.commands).toEqual([]);
    expect(duplicateReady.state.phase).toBe("handoff");
  });

  it("correlates planning failures so stale errors cannot poison the current programme", () => {
    const startup = reduce(createInitialState(), event({ type: "START_STATION", sessionId: "new-session", message: "Warm synth soul." })).state;
    const staleStartupFailure = reduce(startup, event({ type: "INITIAL_INTENT_FAILED", requestId: "old-session", error: "stale" }));
    expect(staleStartupFailure.state.phase).not.toBe("error");
    const startupFailure = reduce(staleStartupFailure.state, event({ type: "INITIAL_INTENT_FAILED", requestId: "new-session", error: "planner unavailable" }));
    expect(startupFailure.state).toMatchObject({ phase: "error", error: "planner unavailable" });

    const requested = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "current-user", message: "Change this." })).state;
    const staleUserFailure = reduce(requested, event({ type: "USER_PLAN_FAILED", requestId: "old-user", error: "stale" }));
    expect(staleUserFailure.state.pendingUser?.requestId).toBe("current-user");
    expect(staleUserFailure.state.error).toBeUndefined();
    const userFailure = reduce(staleUserFailure.state, event({ type: "USER_PLAN_FAILED", requestId: "current-user", error: "intent planner unavailable" }));
    expect(userFailure.state.pendingUser).toBeUndefined();
    expect(userFailure.state.error).toBe("intent planner unavailable");

    const horizon = reduce(playingState(), event({ type: "NEXT_TRACK_HORIZON", requestId: "current-horizon", trackId: "current" })).state;
    const staleHorizonFailure = reduce(horizon, event({ type: "CONTINUITY_PLAN_FAILED", requestId: "old-horizon", error: "stale" }));
    expect(staleHorizonFailure.state.phase).not.toBe("error");
    const horizonFailure = reduce(staleHorizonFailure.state, event({ type: "CONTINUITY_PLAN_FAILED", requestId: "current-horizon", error: "continuity planner unavailable" }));
    expect(horizonFailure.state).toMatchObject({ phase: "error", error: "continuity planner unavailable" });
  });

  it("resumes hands-off horizon planning if urgency classification fails", () => {
    let state = reduce(playingState(NEXT_TRACK_HORIZON_MS), event({ type: "USER_MESSAGE", requestId: "unclassified", message: "Maybe change this?" })).state;
    state = reduce(state, event({ type: "NEXT_TRACK_HORIZON", requestId: "held-horizon", trackId: "current" })).state;
    const failed = reduce(state, event({
      type: "URGENCY_ASSESSMENT_FAILED",
      requestId: "unclassified",
      error: "urgency classifier unavailable"
    }));

    expect(failed.state.pendingUser).toBeUndefined();
    expect(failed.state.error).toBe("urgency classifier unavailable");
    expect(failed.commands.map((command) => command.type)).toEqual(["PLAN_CONTINUITY"]);
    expect(failed.state.continuityPlanRequestId).toBe("held-horizon");
  });

  it("stops policy-repair retries at the configured cost limit and preserves programme identity", () => {
    const original = compileTrackSpec("rejected", 1, continuation, intent, "horizon-repair");
    let state: StationState = {
      ...playingState(),
      nextTrack: { status: "generating", trackId: original.id, revision: original.revision, spec: original, bufferedMs: 0, generatedMs: 0 }
    };
    const rejection = "Eleven Music HTTP 422: bad_composition_plan";

    for (let attempt = 1; attempt <= MAX_TRACK_REPAIR_ATTEMPTS; attempt += 1) {
      const failedTrackId = state.nextTrack.trackId!;
      const failed = reduce(state, event({ type: "TRACK_GENERATION_FAILED", trackId: failedTrackId, revision: 1, error: rejection }));
      expect(commandsOfType(failed.commands, "REPAIR_TRACK_SPEC")).toHaveLength(1);
      const repaired = reduce(failed.state, event({
        type: "TRACK_REPAIR_RECEIVED",
        failedTrackId,
        requestId: `repair-${attempt}`,
        attempt,
        plan: { track: { ...continuation, title: `Soft Voltage ${attempt}` } }
      }));
      expect(repaired.state.nextTrack.spec?.programmeId).toBe("horizon-repair");
      state = repaired.state;
    }

    const exhausted = reduce(state, event({
      type: "TRACK_GENERATION_FAILED",
      trackId: state.nextTrack.trackId!,
      revision: 1,
      error: rejection
    }));
    expect(exhausted.commands).toEqual([]);
    expect(exhausted.state.nextTrack.status).toBe("failed");
    expect(exhausted.state.nextTrack.repairAttempts).toBe(MAX_TRACK_REPAIR_ATTEMPTS);
  });

  it("correlates track-repair planning failures to the rejected track", () => {
    const spec = compileTrackSpec("rejected", 1, continuation, intent, "repair-programme");
    const state: StationState = {
      ...playingState(),
      nextTrack: { status: "planning", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0, repairAttempts: 1 }
    };
    const stale = reduce(state, event({ type: "TRACK_REPAIR_FAILED", failedTrackId: "old-track", requestId: "old-repair", error: "stale" }));
    expect(stale.state.nextTrack.status).toBe("planning");
    expect(stale.state.error).toBeUndefined();

    const current = reduce(stale.state, event({ type: "TRACK_REPAIR_FAILED", failedTrackId: spec.id, requestId: "repair", error: "repair planner unavailable" }));
    expect(current.commands).toEqual([]);
    expect(current.state.nextTrack).toMatchObject({ status: "failed", error: "repair planner unavailable" });
    expect(current.state.error).toBe("repair planner unavailable");
  });

  it("resets all programme leases and emits one stop command", () => {
    const active = requestImmediate(playingState());
    const stopped = reduce(active, event({ type: "STOP_STATION" }));
    expect(stopped.commands).toEqual([{ type: "STOP_ALL" }]);
    expect(stopped.state).toMatchObject({
      running: false,
      phase: "idle",
      nextTrack: { status: "none" },
      transition: { status: "none" },
      dj: { speaking: false }
    });
    expect(stopped.state.pendingUser).toBeUndefined();
  });
});
