import { describe, expect, it } from "vitest";
import type {
  MusicalIntent,
  ProducerPlan,
  StationCommand,
  StationEvent,
  StationState,
  TrackDirective
} from "@robot-radio/eleven-shared";
import { reduce } from "./reducer";
import { createInitialState } from "./state";
import { makeProducerPlan } from "./test-support";

const currentIntent: MusicalIntent = {
  description: "warm nocturnal analogue synth soul",
  styles: ["synth soul", "downtempo"],
  mood: ["warm", "nocturnal"],
  energy: 0.5,
  bpmRange: [104, 112],
  keyPreference: "E minor",
  vocals: "sparse original vocals"
};

const destinationIntent: MusicalIntent = {
  ...currentIntent,
  description: "ferocious distorted gabber with industrial percussion",
  styles: ["gabber", "industrial hardcore"],
  mood: ["ferocious", "euphoric"],
  energy: 0.98,
  bpmRange: [180, 195],
  vocals: "instrumental"
};

const destinationTrack: TrackDirective = {
  title: "Concrete Halo",
  description: destinationIntent.description,
  styles: destinationIntent.styles,
  mood: destinationIntent.mood,
  energy: destinationIntent.energy,
  bpm: 188,
  key: "F minor",
  durationMs: 180_000
};

const userPlan: ProducerPlan = makeProducerPlan(destinationIntent, destinationTrack);

const horizonTrack: TrackDirective = {
  title: "Neon Patience",
  description: currentIntent.description,
  styles: currentIntent.styles,
  mood: currentIntent.mood,
  energy: currentIntent.energy,
  bpm: 108,
  key: "E minor",
  durationMs: 180_000
};

const horizonPlan: ProducerPlan = makeProducerPlan(currentIntent, horizonTrack, { suggestedTiming: "continuity" });

function playingState(remainingMs = 50_000): StationState {
  return {
    ...createInitialState(),
    running: true,
    phase: "playing",
    intent: currentIntent,
    intentRevision: 1,
    playback: {
      trackId: "current",
      title: "Signals Through Glass",
      playheadMs: 180_000 - remainingMs,
      durationMs: 180_000,
      remainingMs,
      styleSummary: currentIntent.description,
      bpm: 108,
      key: "E minor",
      energy: 0.5,
      bufferedMs: remainingMs
    }
  };
}

function event<T extends Omit<StationEvent, "at">>(value: T): StationEvent {
  return { ...value, at: 1_000 } as StationEvent;
}

const userMessage = event({ type: "USER_MESSAGE", requestId: "user-close", message: "Gabber, immediately." });
const horizon = event({ type: "NEXT_TRACK_HORIZON", requestId: "horizon-current", trackId: "current" });
const urgency = event({
  type: "URGENCY_ASSESSMENT_RECEIVED",
  requestId: "user-close",
  assessment: {
    timing: "immediate",
    interruptCurrentTrack: true,
    confidence: 0.99,
    immediateTransition: {
      description: "Strip the warm groove to percussion, then accelerate into distorted hardcore kicks.",
      sourceSummary: currentIntent.description,
      destinationSketch: destinationIntent.description,
      energyDirection: "up"
    }
  }
});
const fullPlan = event({ type: "USER_PLAN_RECEIVED", requestId: "user-close", plan: userPlan });

type RaceStep = "horizon" | "urgency" | "plan";
const closeHorizonOrderings: Array<[string, RaceStep[]]> = [
  ["horizon → urgency → plan", ["horizon", "urgency", "plan"]],
  ["horizon → plan → urgency", ["horizon", "plan", "urgency"]],
  ["urgency → horizon → plan", ["urgency", "horizon", "plan"]],
  ["urgency → plan → horizon", ["urgency", "plan", "horizon"]],
  ["plan → horizon → urgency", ["plan", "horizon", "urgency"]],
  ["plan → urgency → horizon", ["plan", "urgency", "horizon"]]
];

function raceEvent(step: RaceStep): StationEvent {
  if (step === "horizon") return horizon;
  if (step === "urgency") return urgency;
  return fullPlan;
}

function runEvents(initial: StationState, events: StationEvent[]): { state: StationState; commands: StationCommand[] } {
  let state = initial;
  const commands: StationCommand[] = [];
  for (const nextEvent of events) {
    const result = reduce(state, nextEvent);
    state = result.state;
    commands.push(...result.commands);
  }
  return { state, commands };
}

function commandsOfType<T extends StationCommand["type"]>(commands: StationCommand[], type: T): Extract<StationCommand, { type: T }>[] {
  return commands.filter((command): command is Extract<StationCommand, { type: T }> => command.type === type);
}

describe("station reducer race safety", () => {
  it.each(closeHorizonOrderings)(
    "creates exactly one immediate programme when close-horizon results arrive as %s",
    (_name, ordering) => {
      const requested = reduce(playingState(), userMessage);
      const raced = runEvents(requested.state, ordering.map(raceEvent));

      expect(commandsOfType(raced.commands, "GENERATE_TRANSITION")).toHaveLength(1);
      expect(commandsOfType(raced.commands, "GENERATE_TRACK")).toHaveLength(1);
      expect(commandsOfType(raced.commands, "PLAN_CONTINUITY")).toHaveLength(0);
      expect(raced.state.nextTrack.spec?.programmeId).toBe("user-close");
      expect(raced.state.transition.spec?.programmeId).toBe("user-close");
      expect(raced.state.horizonRequestId).toBeUndefined();
      expect(raced.state.horizonFiredForTrackId).toBe("current");
    }
  );

  it.each(closeHorizonOrderings)(
    "ignores a superseded horizon plan around an immediate request when results arrive as %s",
    (_name, ordering) => {
      const horizonStarted = reduce(playingState(), horizon);
      expect(commandsOfType(horizonStarted.commands, "PLAN_CONTINUITY")).toHaveLength(1);
      const requested = reduce(horizonStarted.state, userMessage);
      const staleContinuity = event({ type: "CONTINUITY_PLAN_RECEIVED", requestId: "horizon-current", plan: horizonPlan });
      const events = ordering.map((step) => step === "horizon" ? staleContinuity : raceEvent(step));
      const raced = runEvents(requested.state, events);

      expect(commandsOfType(raced.commands, "GENERATE_TRANSITION")).toHaveLength(1);
      expect(commandsOfType(raced.commands, "GENERATE_TRACK")).toHaveLength(1);
      expect(commandsOfType(raced.commands, "PLAN_CONTINUITY")).toHaveLength(0);
      expect(commandsOfType(raced.commands, "GENERATE_TRACK")[0]?.spec.id).toBe("user-close-track");
      expect(raced.state.nextTrack.spec?.programmeId).toBe("user-close");
      expect(raced.state.continuityPlanRequestId).toBeUndefined();
    }
  );

  it.each([
    ["old ready → urgency → plan", ["old_ready", "urgency", "plan"]],
    ["urgency → old ready → plan", ["urgency", "old_ready", "plan"]],
    ["urgency → plan → old ready", ["urgency", "plan", "old_ready"]],
    ["plan → old ready → urgency", ["plan", "old_ready", "urgency"]],
    ["plan → urgency → old ready", ["plan", "urgency", "old_ready"]]
  ] as Array<[string, Array<"old_ready" | "urgency" | "plan">]>) (
    "cancels one already-generating horizon track without ever playing it when %s",
    (_name, ordering) => {
      const horizonStarted = reduce(playingState(), horizon);
      const horizonPlanned = reduce(horizonStarted.state, event({
        type: "CONTINUITY_PLAN_RECEIVED",
        requestId: "horizon-current",
        plan: horizonPlan
      }));
      const oldTrackId = horizonPlanned.state.nextTrack.trackId!;
      const oldRevision = horizonPlanned.state.nextTrack.revision!;
      const requested = reduce(horizonPlanned.state, userMessage);
      const events = ordering.map((step) => {
        if (step === "old_ready") return event({ type: "TRACK_READY", trackId: oldTrackId, revision: oldRevision });
        return step === "urgency" ? urgency : fullPlan;
      });
      const raced = runEvents(requested.state, events);

      expect(commandsOfType(raced.commands, "CANCEL_TRACK")).toEqual([{ type: "CANCEL_TRACK", trackId: oldTrackId }]);
      expect(commandsOfType(raced.commands, "GENERATE_TRANSITION")).toHaveLength(1);
      expect(commandsOfType(raced.commands, "GENERATE_TRACK")).toHaveLength(1);
      expect(commandsOfType(raced.commands, "FADE").some((command) => command.trackId === oldTrackId)).toBe(false);
      expect(commandsOfType(raced.commands, "PLAY_TRACK").some((command) => command.trackId === oldTrackId)).toBe(false);
      expect(raced.state.nextTrack.trackId).toBe("user-close-track");
      expect(raced.state.nextTrack.spec?.programmeId).toBe("user-close");
    }
  );

  it("makes duplicate classifier, planner, ready, and horizon callbacks idempotent", () => {
    let state = reduce(playingState(), userMessage).state;

    const firstUrgency = reduce(state, urgency);
    expect(commandsOfType(firstUrgency.commands, "GENERATE_TRANSITION")).toHaveLength(1);
    state = firstUrgency.state;
    const duplicateUrgency = reduce(state, urgency);
    expect(duplicateUrgency.commands).toEqual([]);

    const firstPlan = reduce(duplicateUrgency.state, fullPlan);
    expect(commandsOfType(firstPlan.commands, "GENERATE_TRACK")).toHaveLength(1);
    state = firstPlan.state;
    const duplicatePlan = reduce(state, fullPlan);
    expect(duplicatePlan.commands).toEqual([]);

    const transitionId = state.transition.transitionId!;
    const firstReady = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision }));
    expect(commandsOfType(firstReady.commands, "PLAY_TRANSITION")).toHaveLength(1);
    const duplicateReady = reduce(firstReady.state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision }));
    expect(duplicateReady.commands).toEqual([]);

    const firstHorizon = reduce(duplicateReady.state, horizon);
    const duplicateHorizon = reduce(firstHorizon.state, horizon);
    expect(firstHorizon.commands).toEqual([]);
    expect(duplicateHorizon.commands).toEqual([]);
  });

  it("starts a current-vibe safety transition when an immediate classifier omits its optional sketch", () => {
    const requested = reduce(playingState(), userMessage).state;
    const classified = reduce(requested, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "user-close",
      assessment: { timing: "immediate", interruptCurrentTrack: false, confidence: 0.91 }
    }));

    const generated = commandsOfType(classified.commands, "GENERATE_TRANSITION");
    expect(generated).toHaveLength(1);
    expect(generated[0]?.spec.programmeId).toBe("user-close");
    expect(generated[0]?.spec.sourceSummary).toBe(currentIntent.description);
    expect(generated[0]?.spec.destinationSummary).toBe(currentIntent.description);

    const planned = reduce(classified.state, fullPlan);
    expect(commandsOfType(planned.commands, "GENERATE_TRANSITION")).toHaveLength(0);
    expect(commandsOfType(planned.commands, "GENERATE_TRACK")).toHaveLength(1);
    expect(planned.state.nextTrack.spec?.programmeId).toBe("user-close");
  });

  it("ignores late audio and discards the cue from a cancelled horizon programme", () => {
    const horizonWithCue = makeProducerPlan(currentIntent, horizonTrack, {
      onAirCue: { text: "Here is the track you cancelled.", purpose: "tease" },
      suggestedTiming: "continuity"
    });
    const horizonStarted = reduce(playingState(), horizon);
    const horizonPlanned = reduce(horizonStarted.state, event({
      type: "CONTINUITY_PLAN_RECEIVED",
      requestId: "horizon-current",
      plan: horizonWithCue
    }));
    const oldTrackId = horizonPlanned.state.nextTrack.trackId!;
    const requested = reduce(horizonPlanned.state, userMessage).state;
    const resolved = runEvents(requested, [urgency, fullPlan]);

    const late = runEvents(resolved.state, [
      event({ type: "TRACK_FIRST_AUDIO", trackId: oldTrackId, revision: 1, latencyMs: 4_000 }),
      event({ type: "TRACK_READY", trackId: oldTrackId, revision: 1 })
    ]);

    expect(late.commands).toEqual([]);
    expect(late.state.nextTrack.trackId).toBe("user-close-track");
    expect(late.state.dj.pending).toBeUndefined();
  });

  it("does not let a stale TTS completion release a newer speech lease or trigger handoff", () => {
    const spokenPlan = makeProducerPlan(destinationIntent, destinationTrack, {
      onAirCue: { text: "Stand by for concrete weather.", purpose: "listener_acknowledgement" },
      suggestedTiming: "immediate"
    });
    let state = reduce(playingState(), userMessage).state;
    state = reduce(state, urgency).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "user-close", plan: spokenPlan })).state;
    const transitionId = state.transition.transitionId!;
    const trackId = state.nextTrack.trackId!;
    const revision = state.intentRevision;
    state = reduce(state, event({
      type: "TRANSITION_BUFFER_UPDATED", transitionId, revision, bufferedMs: 12_000, generatedMs: 12_000, generationRate: 4
    })).state;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision })).state;
    state = reduce(state, event({ type: "TRANSITION_STARTED", transitionId, revision })).state;
    state = reduce(state, event({ type: "TRACK_READY", trackId, revision })).state;
    state = reduce(state, event({ type: "TTS_STARTED", speechId: "cue-user-close" })).state;
    state = reduce(state, event({ type: "TRANSITION_MINIMUM_PLAYED", transitionId, revision })).state;
    expect(state.dj).toMatchObject({ speaking: true, speechId: "cue-user-close" });

    const staleFinished = reduce(state, event({ type: "TTS_FINISHED", speechId: "old-speech" }));
    expect(staleFinished.commands).toEqual([]);
    expect(staleFinished.state.dj).toMatchObject({ speaking: true, speechId: "cue-user-close" });
    expect(staleFinished.state.phase).toBe("transition");

    const currentFinished = reduce(staleFinished.state, event({ type: "TTS_FINISHED", speechId: "cue-user-close" }));
    expect(commandsOfType(currentFinished.commands, "FADE")).toHaveLength(1);
    expect(currentFinished.state.phase).toBe("handoff");
  });

  it("does not mutate the input state while processing a listener request", () => {
    const state = playingState();
    const before = structuredClone(state);
    reduce(state, userMessage);
    expect(state).toEqual(before);
  });
});
