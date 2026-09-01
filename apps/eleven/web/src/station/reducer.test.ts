import { describe, expect, it } from "vitest";
import type { MusicalIntent, ProducerPlan, StationEvent, StationState, TrackDirective, TrackSpec } from "@robot-radio/eleven-shared";
import { NORMAL_CROSSFADE_MS, UNDERRUN_THREAT_MS, compileTrackSpec, reduce } from "./reducer";
import { createInitialState } from "./state";
import { makeProducerPlan } from "./test-support";
import { buildTrackPresentationMap } from "./presentation-map";

const intent: MusicalIntent = {
  description: "nocturnal analogue synth soul",
  styles: ["synth soul", "downtempo"],
  mood: ["warm", "nocturnal"],
  energy: 0.55,
  bpmRange: [104, 112],
  keyPreference: "E minor",
  vocals: "sparse original vocals"
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

const plan: ProducerPlan = makeProducerPlan(darkerIntent, nextDirective);

function playingState(remainingMs = 90_000): StationState {
  const sections = [
    { name: "Instrumental intro", durationMs: 30_000, description: "Sparse clean bed", transitionFriendly: true },
    { name: "Instrumental development", durationMs: 120_000, description: "Stable instrumental body" },
    { name: "Instrumental outro", durationMs: 30_000, description: "Reduced clean bed", transitionFriendly: true }
  ];
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
      sections,
      presentationMap: buildTrackPresentationMap("current", 180_000, sections),
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

function event<T extends Omit<StationEvent, "at">>(value: T, at = 1_000): StationEvent {
  return { ...value, at } as StationEvent;
}

describe("ElevenLabs station reducer", () => {
  it("carries one opening ProducerPlan through memory, composition, and the first playable cue window", () => {
    const started = reduce(createInitialState(), event({ type: "START_STATION", sessionId: "start-1", message: "rainy synth soul" }));
    expect(started.commands.map((command) => command.type)).toEqual(["PLAN_INITIAL_INTENT"]);

    const openingSections = [
      { name: "Instrumental intro", durationMs: 8_000, description: "Sparse presenter ramp", transitionFriendly: true },
      { name: "Verse", durationMs: 82_000, description: "Close vocal", lyrics: "Rain on the glass\nSignal coming through" },
      { name: "Outro", durationMs: 90_000, description: "Instrumental handoff", transitionFriendly: true }
    ];
    const openingPlan = makeProducerPlan(intent, { title: "Wet Neon", description: intent.description, sections: openingSections }, {
      onAirCue: { text: "Come in out of the rain. This signal is yours.", purpose: "opening" },
      memoryUpdates: {
        listener: { preferences: ["rainy synth soul"] },
        musicalThesis: "A rain-soaked late-night soul transmission",
        productionFingerprint: "soft analogue bass; brushed electronic drums; glassy two-note hook"
      },
      editorialNotes: ["Make the glassy two-note hook legible within eight seconds"],
      suggestedTiming: "opening"
    });
    const planned = reduce(started.state, event({
      type: "INITIAL_INTENT_RECEIVED",
      requestId: "start-1",
      plan: openingPlan
    }));
    expect(planned.commands[0]?.type).toBe("GENERATE_TRACK");
    expect(planned.state.nextTrack.spec?.title).toBe("Wet Neon");
    expect(planned.state.nextTrack.spec?.editorialNotes).toEqual(openingPlan.editorialNotes);
    expect(planned.state.showState.listener.preferences).toEqual(["rainy synth soul"]);
    expect(planned.state.showState.musicalThesis.current).toBe("A rain-soaked late-night soul transmission");
    expect(planned.state.showState.recentLinkFingerprints).toEqual(["opening: direct concise link"]);
    expect(planned.commands.some((command) => command.type === "PLAY_SPEECH")).toBe(false);
    expect(planned.commands.map((command) => command.type)).toContain("PREPARE_SPEECH");

    const trackId = planned.state.nextTrack.trackId!;
    const revision = planned.state.nextTrack.revision!;
    let state = reduce(planned.state, event({ type: "TTS_PREPARED", speechId: "cue-start-1", durationMs: 2_000 }, 2_000)).state;
    state = reduce(state, event({
      type: "TRACK_BUFFER_UPDATED", trackId, revision, bufferedMs: 12_000, generatedMs: 15_000, generationRate: 4
    })).state;
    const ready = reduce(state, event({ type: "TRACK_READY", trackId, revision }));
    expect(ready.commands.map((command) => command.type)).toEqual(["PLAY_TRACK"]);
    const audible = reduce(ready.state, event({ type: "TRACK_STARTED", trackId, revision, spec: planned.state.nextTrack.spec! }));
    expect(audible.commands.map((command) => command.type)).toEqual(["GENERATE_CART", "GENERATE_CART"]);
    const ramp = reduce(audible.state, event({
      type: "TRACK_PROGRESS", trackId, playheadMs: 5_600, remainingMs: 174_400, bufferedMs: 12_000
    }, 8_000));
    expect(ramp.commands).toEqual([{ type: "PLAY_SPEECH", speechId: "cue-start-1" }]);
    expect(ramp.state.showState.speechCadence).toMatchObject({ lastCuePurpose: "opening", cuesSpoken: 1 });
    expect(audible.state.playback.sections).toEqual(openingSections);
    expect(ramp.state.conversation.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "listener", text: "rainy synth soul" },
      { role: "dj", text: openingPlan.onAirCue!.text }
    ]);
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
    expect(resolved.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK"]);
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

  it("treats ProducerPlan timing as advisory and lets the urgency classifier decide", () => {
    const misleadingPlan = makeProducerPlan(darkerIntent, nextDirective, { suggestedTiming: "immediate" });
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "advisory", message: "Make it darker over time." })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "advisory", plan: misleadingPlan })).state;
    const resolved = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "advisory",
      assessment: { timing: "future", interruptCurrentTrack: false, confidence: 0.97 }
    }));

    expect(resolved.commands).toEqual([]);
    expect(resolved.state.pendingUser?.resolution).toBe("deferred");
    expect(resolved.state.transition.status).toBe("none");
    expect(resolved.state.queuedDirective?.title).toBe(nextDirective.title);
  });

  it("promotes a next-track request near the horizon to a generated bridge", () => {
    let state = reduce(playingState(55_000), event({ type: "USER_MESSAGE", requestId: "u3", message: "next one should be much heavier" })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "u3", plan })).state;
    const resolved = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "u3",
      assessment: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.95 }
    }));
    expect(resolved.commands.map((command) => command.type)).toEqual(["GENERATE_TRANSITION", "GENERATE_TRACK"]);
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

  it("starts an already-ready immediate transition when the slower full plan arrives", () => {
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "race", message: "gabber now" })).state;
    state = reduce(state, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "race", assessment: immediateAssessment() })).state;
    const transitionId = state.transition.transitionId!;

    const earlyBridge = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision }));
    expect(earlyBridge.commands).toEqual([]);
    expect(earlyBridge.state.transition.status).toBe("ready");

    const planned = reduce(earlyBridge.state, event({ type: "USER_PLAN_RECEIVED", requestId: "race", plan }));
    expect(planned.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK", "PLAY_TRANSITION"]);
    expect(planned.state.nextTrack.trackId).toBe("race-track");
    expect(planned.state.transition.status).toBe("starting");
  });

  it("does not let horizon overwrite an active immediate replacement pipeline", () => {
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "race", message: "gabber now" })).state;
    state = reduce(state, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "race", assessment: immediateAssessment() })).state;
    const transitionId = state.transition.transitionId!;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "race", plan })).state;
    const intendedTrackId = state.nextTrack.trackId;
    state = reduce(state, event({ type: "TRACK_READY", trackId: intendedTrackId!, revision: state.intentRevision })).state;

    const horizon = reduce(state, event({ type: "NEXT_TRACK_HORIZON", requestId: "h-race", trackId: "current" }));
    expect(horizon.commands).toEqual([]);
    expect(horizon.state.nextTrack.trackId).toBe(intendedTrackId);
    expect(horizon.state.nextTrack.status).toBe("ready");
    expect(horizon.state.continuityPlanRequestId).toBeUndefined();
    expect(horizon.state.horizonFiredForTrackId).toBe("current");
  });

  it("holds a due horizon while a listener message is unresolved, then uses that message's queued track", () => {
    let state = reduce(playingState(45_000), event({ type: "USER_MESSAGE", requestId: "near", message: "from now on make it darker" })).state;
    const horizon = reduce(state, event({ type: "NEXT_TRACK_HORIZON", requestId: "h-near", trackId: "current" }));
    expect(horizon.commands).toEqual([]);
    expect(horizon.state.horizonRequestId).toBe("h-near");

    state = reduce(horizon.state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "near",
      assessment: { timing: "future", interruptCurrentTrack: false, confidence: 0.94 }
    })).state;
    const resolved = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "near", plan }));
    expect(resolved.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK"]);
    expect(resolved.state.nextTrack.trackId).toBe("h-near-queued");
    expect(resolved.state.nextTrack.spec?.description).toBe(nextDirective.description);
    expect(resolved.state.continuityPlanRequestId).toBeUndefined();
  });

  it("keeps horizon generation inside the existing persistent intent", () => {
    const horizon = reduce(playingState(50_000), event({ type: "NEXT_TRACK_HORIZON", requestId: "h1", trackId: "current" }));
    expect(horizon.commands.map((command) => command.type)).toEqual(["PLAN_CONTINUITY"]);
    const continuityPlan = makeProducerPlan(
      { ...intent, description: "an unsolicited completely different station" },
      { ...nextDirective, title: "A Different Arrangement" },
      { suggestedTiming: "continuity" }
    );

    const planned = reduce(horizon.state, event({ type: "CONTINUITY_PLAN_RECEIVED", requestId: "h1", plan: continuityPlan }));
    expect(planned.state.intent).toEqual(intent);
    expect(planned.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK"]);
    expect(planned.state.nextTrack.trackId).toBe("h1-track");
    expect(planned.state.nextTrack.spec).toMatchObject({
      programmeId: "h1",
      styles: intent.styles,
      mood: intent.mood,
      energy: intent.energy,
      bpm: intent.bpmRange?.[1],
      key: intent.keyPreference,
      vocals: intent.vocals
    });
    expect(planned.state.nextTrack.spec?.description).toContain(intent.description);
  });

  it("ignores a superseded horizon plan after a listener message arrives", () => {
    const horizon = reduce(playingState(50_000), event({ type: "NEXT_TRACK_HORIZON", requestId: "old-horizon", trackId: "current" })).state;
    const requested = reduce(horizon, event({ type: "USER_MESSAGE", requestId: "new-user", message: "actually, change direction" })).state;
    const stalePlan = makeProducerPlan(intent, nextDirective, { suggestedTiming: "continuity" });
    const stale = reduce(requested, event({ type: "CONTINUITY_PLAN_RECEIVED", requestId: "old-horizon", plan: stalePlan }));

    expect(stale.commands).toEqual([]);
    expect(stale.state.nextTrack.status).toBe("none");
    expect(stale.state.horizonRequestId).toBe("old-horizon");
  });

  it("drops a producer cue whose subject track has been replaced", () => {
    const spec = compileTrackSpec("replacement", 1, nextDirective, darkerIntent);
    const state: StationState = {
      ...playingState(),
      intentRevision: 1,
      dj: {
        muted: false,
        speaking: false,
        pending: {
          speechId: "cue-old",
          text: "Coming up: the track that no longer exists.",
          purpose: "handoff_setup",
          revision: 1,
          trackId: "discarded-track"
        }
      },
      nextTrack: { status: "ready", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 12_000, generatedMs: 20_000 }
    };
    const result = reduce(state, event({ type: "TRACK_PROGRESS", trackId: "current", playheadMs: 90_000, remainingMs: 90_000, bufferedMs: 90_000 }));

    expect(result.commands).toEqual([]);
    expect(result.state.dj.pending).toBeUndefined();
  });

  it("keeps listener acknowledgement silent until the current music has a safe buffer", () => {
    let state: StationState = {
      ...playingState(),
      playback: { ...playingState().playback, bufferedMs: 2_000 },
      pendingUser: {
        requestId: "buffered-ack",
        revision: 1,
        message: "Keep this feeling.",
        applied: true,
        resolution: "conversation"
      },
      dj: {
        muted: false,
        speaking: false,
        pending: {
          speechId: "cue-buffered-ack",
          text: "I’ll hold this feeling a little longer.",
          purpose: "listener_acknowledgement",
          revision: 1
        }
      }
    };

    const unsafe = reduce(state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 91_000, remainingMs: 89_000, bufferedMs: 2_000
    }, 5_000));
    expect(unsafe.commands.map((command) => command.type)).toEqual(["PREPARE_SPEECH"]);
    expect(unsafe.state.dj.prepared).toMatchObject({ speechId: "cue-buffered-ack", status: "preparing" });

    state = reduce(unsafe.state, event({ type: "TTS_PREPARED", speechId: "cue-buffered-ack", durationMs: 1_000 }, 5_500)).state;
    const safe = reduce(state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 92_000, remainingMs: 88_000, bufferedMs: 5_000
    }, 6_000));
    expect(safe.commands.map((command) => command.type)).toEqual(["PLAY_SPEECH"]);
  });

  it("authorizes a handoff setup only inside the deterministic handoff window", () => {
    const spec = compileTrackSpec("teased-track", 1, nextDirective, darkerIntent);
    const state: StationState = {
      ...playingState(20_000),
      showState: {
        ...playingState().showState,
        speechCadence: { ...playingState().showState.speechCadence, sessionTalkativeness: 0.6 }
      },
      nextTrack: { status: "ready", trackId: spec.id, revision: 1, spec, bufferedMs: 12_000, generatedMs: 20_000 },
      dj: {
        muted: false,
        speaking: false,
        pending: { speechId: "cue-tease", text: "The next room has heavier walls.", purpose: "handoff_setup", revision: 1, trackId: spec.id }
      }
    };

    const early = reduce(state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 161_000, remainingMs: 19_000, bufferedMs: 19_000
    }, 10_000));
    expect(early.commands.map((command) => command.type)).toEqual(["PREPARE_SPEECH"]);
    expect(early.state.dj.prepared).toMatchObject({ speechId: "cue-tease", status: "preparing" });

    const prepared = reduce(early.state, event({ type: "TTS_PREPARED", speechId: "cue-tease", durationMs: 3_000 }, 11_000));
    expect(prepared.commands).toEqual([]);
    const window = reduce(prepared.state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 176_600, remainingMs: 3_400, bufferedMs: 18_000
    }, 12_000));
    expect(window.commands).toEqual([{ type: "PLAY_SPEECH", speechId: "cue-tease" }]);
  });

  it("authorizes a rare observation only inside the middle of a stable track", () => {
    const base = playingState(136_000);
    const state: StationState = {
      ...base,
      playback: { ...base.playback, playheadMs: 44_000 },
      showState: {
        ...base.showState,
        speechCadence: { ...base.showState.speechCadence, sessionTalkativeness: 0.8 }
      },
      dj: {
        muted: false,
        speaking: false,
        pending: {
          speechId: "cue-mid-track",
          text: "That tiny bass hesitation is holding the whole track open.",
          purpose: "mid_track_observation",
          revision: 1
        }
      }
    };

    const edge = reduce(state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 44_000, remainingMs: 136_000, bufferedMs: 90_000
    }, 10_000));
    expect(edge.commands.map((command) => command.type)).toEqual(["PREPARE_SPEECH"]);
    const prepared = reduce(edge.state, event({ type: "TTS_PREPARED", speechId: "cue-mid-track", durationMs: 2_000 }, 10_500));
    expect(prepared.commands).toEqual([]);

    const middle = reduce(prepared.state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 45_000, remainingMs: 135_000, bufferedMs: 90_000
    }, 11_000));
    expect(middle.commands).toEqual([{
      type: "PLAY_SPEECH",
      speechId: "cue-mid-track"
    }]);
  });

  it("drops cues during cooldown and prevents consecutive mid-track observations", () => {
    const cooledState: StationState = {
      ...playingState(),
      showState: {
        ...playingState().showState,
        speechCadence: {
          ...playingState().showState.speechCadence,
          lastCueAt: 10_000,
          lastCuePurpose: "listener_acknowledgement",
          sessionTalkativeness: 1
        }
      },
      pendingUser: {
        requestId: "cooldown",
        revision: 1,
        message: "Thanks.",
        applied: true,
        resolution: "conversation"
      },
      dj: {
        muted: false,
        speaking: false,
        pending: { speechId: "cue-cooldown", text: "Still here.", purpose: "listener_acknowledgement", revision: 1 }
      }
    };
    const cooled = reduce(cooledState, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 91_000, remainingMs: 89_000, bufferedMs: 89_000
    }, 20_000));
    expect(cooled.commands).toEqual([]);
    expect(cooled.state.dj.pending).toBeUndefined();

    const repeatedObservation: StationState = {
      ...playingState(),
      showState: {
        ...playingState().showState,
        speechCadence: {
          ...playingState().showState.speechCadence,
          lastCueAt: 0,
          lastCuePurpose: "mid_track_observation",
          sessionTalkativeness: 1
        }
      },
      dj: {
        muted: false,
        speaking: false,
        pending: { speechId: "cue-observation", text: "Notice how the pulse keeps folding.", purpose: "mid_track_observation", revision: 1 }
      }
    };
    const repeated = reduce(repeatedObservation, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 90_000, remainingMs: 90_000, bufferedMs: 90_000
    }, 100_000));
    expect(repeated.commands).toEqual([]);
    expect(repeated.state.dj.pending).toBeUndefined();
  });

  it("keeps a muted presenter in text chat without requesting TTS", () => {
    const text = "I’ll keep shaping the night from here.";
    const state: StationState = {
      ...playingState(),
      dj: {
        muted: false,
        speaking: false,
        pending: { speechId: "cue-text-only", text, purpose: "mid_track_observation", revision: 1 }
      }
    };

    const muted = reduce(state, event({ type: "SET_DJ_MUTED", muted: true }, 12_000));

    expect(muted.commands).toEqual([]);
    expect(muted.state.dj).toMatchObject({ muted: true, speaking: false });
    expect(muted.state.dj.pending).toBeUndefined();
    expect(muted.state.recentDjLines.at(-1)).toBe(text);
    expect(muted.state.conversation.at(-1)).toMatchObject({ role: "dj", text });
    expect(muted.state.showState.speechCadence.cuesSpoken).toBe(0);
  });

  it("cancels active speech, ignores its late start, and preserves mute across sessions", () => {
    const speaking: StationState = {
      ...playingState(),
      dj: { muted: false, speaking: true, speechId: "cue-active" }
    };

    const muted = reduce(speaking, event({ type: "SET_DJ_MUTED", muted: true }));
    expect(muted.commands).toEqual([{ type: "CANCEL_SPEECH", speechId: "cue-active" }]);
    expect(muted.state.dj).toMatchObject({ muted: true, speaking: false });
    expect(muted.state.dj.speechId).toBeUndefined();

    const late = reduce(muted.state, event({ type: "TTS_STARTED", speechId: "cue-active" }));
    expect(late.state.dj).toMatchObject({ muted: true, speaking: false });

    const stopped = reduce(late.state, event({ type: "STOP_STATION" }));
    const restarted = reduce(stopped.state, event({ type: "START_STATION", sessionId: "muted-session", message: "Keep it quiet." }));
    expect(restarted.state.dj.muted).toBe(true);
  });

  it("bounds producer memory without allowing a plan to rewrite presenter identity", () => {
    const base = playingState();
    const presenter = structuredClone(base.showState.presenter);
    const seeded: StationState = {
      ...base,
      showState: {
        ...base.showState,
        listener: {
          preferences: Array.from({ length: 8 }, (_, index) => `preference-${index}`),
          dislikes: [],
          callbacks: Array.from({ length: 6 }, (_, index) => `callback-${index}`),
          notablePhrases: []
        },
        recentProductionFingerprints: Array.from({ length: 8 }, (_, index) => `fingerprint-${index}`)
      }
    };
    const memoryPlan = makeProducerPlan(intent, nextDirective, {
      memoryUpdates: {
        listener: {
          preferences: ["PREFERENCE-7", "warm bass", "broken rhythm", "nocturnal pacing"],
          callbacks: ["callback-5", "the rain room"]
        },
        musicalThesis: "Keep warmth while roughening the rhythmic edges",
        productionFingerprint: "new fingerprint",
        sessionTalkativeness: 0.62
      },
      suggestedTiming: "conversation_only"
    });
    let state = reduce(seeded, event({ type: "USER_MESSAGE", requestId: "memory", message: "That warmth is right." })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "memory", plan: memoryPlan })).state;
    const resolved = reduce(state, event({
      type: "URGENCY_ASSESSMENT_RECEIVED",
      requestId: "memory",
      assessment: { timing: "conversation_only", interruptCurrentTrack: false, confidence: 0.99 }
    }));

    expect(resolved.state.showState.presenter).toEqual(presenter);
    expect(resolved.state.showState.listener.preferences).toHaveLength(8);
    expect(resolved.state.showState.listener.preferences.at(-4)).toBe("PREFERENCE-7");
    expect(resolved.state.showState.listener.callbacks).toHaveLength(6);
    expect(resolved.state.showState.listener.callbacks.at(-1)).toBe("the rain room");
    expect(resolved.state.showState.recentProductionFingerprints).toHaveLength(8);
    expect(resolved.state.showState.recentProductionFingerprints.at(-1)).toBe("new fingerprint");
    expect(resolved.state.showState.speechCadence.sessionTalkativeness).toBe(0.62);
  });

  it("will not hand a transition to an unrelated track from the same intent revision", () => {
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "matched", message: "gabber now" })).state;
    state = reduce(state, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "matched", assessment: immediateAssessment() })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "matched", plan })).state;
    const transitionId = state.transition.transitionId!;
    const trackId = state.nextTrack.trackId!;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision })).state;
    state = reduce(state, event({ type: "TRANSITION_STARTED", transitionId, revision: state.intentRevision })).state;
    state = reduce(state, event({ type: "TRACK_READY", trackId, revision: state.intentRevision })).state;
    state = {
      ...state,
      nextTrack: { ...state.nextTrack, spec: { ...state.nextTrack.spec!, programmeId: "different-programme" } }
    };

    const minimum = reduce(state, event({ type: "TRANSITION_MINIMUM_PLAYED", transitionId, revision: state.intentRevision }));
    expect(minimum.commands).toEqual([]);
    expect(minimum.state.phase).toBe("transition");
  });

  it("holds the musical handoff until requested DJ speech finishes", () => {
    const spokenPlan = makeProducerPlan(darkerIntent, nextDirective, {
      onAirCue: { text: "Harder, faster, and gloriously unreasonable.", purpose: "listener_acknowledgement" },
      suggestedTiming: "immediate"
    });
    let state = reduce(playingState(), event({ type: "USER_MESSAGE", requestId: "spoken", message: "gabber now" })).state;
    state = reduce(state, event({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: "spoken", assessment: immediateAssessment() })).state;
    state = reduce(state, event({ type: "USER_PLAN_RECEIVED", requestId: "spoken", plan: spokenPlan })).state;
    state = reduce(state, event({ type: "TTS_PREPARED", speechId: "cue-spoken", durationMs: 2_000 }, 2_000)).state;
    const transitionId = state.transition.transitionId!;
    const trackId = state.nextTrack.trackId!;
    state = reduce(state, event({
      type: "TRANSITION_BUFFER_UPDATED", transitionId, revision: state.intentRevision, bufferedMs: 12_000, generatedMs: 12_000, generationRate: 4
    })).state;
    state = reduce(state, event({ type: "TRANSITION_READY", transitionId, revision: state.intentRevision })).state;
    const line = reduce(state, event({ type: "TRANSITION_STARTED", transitionId, revision: state.intentRevision }));
    expect(line.commands.map((command) => command.type)).toEqual(["PLAY_SPEECH"]);
    expect(line.state.dj.speaking).toBe(true);
    state = line.state;
    state = reduce(state, event({ type: "TRACK_READY", trackId, revision: state.intentRevision })).state;
    const minimum = reduce(state, event({ type: "TRANSITION_MINIMUM_PLAYED", transitionId, revision: state.intentRevision }));
    expect(minimum.commands).toEqual([]);
    const finished = reduce(minimum.state, event({ type: "TTS_FINISHED", speechId: "cue-spoken" }));
    expect(finished.commands.some((command) => command.type === "FADE" && command.trackId === trackId)).toBe(true);
  });

  it("registers reusable dry and wet station elements, then uses the dry ID sparingly in cruise", () => {
    const started = reduce(createInitialState(), event({ type: "START_STATION", sessionId: "carts", message: "slow neon soul" }));
    const planned = reduce(started.state, event({
      type: "INITIAL_INTENT_RECEIVED",
      requestId: "carts",
      plan: makeProducerPlan(intent, { title: "First Light", description: intent.description })
    }));
    expect(planned.state.carts.entries.map(({ kind, mixType, status }) => ({ kind, mixType, status }))).toEqual([
      { kind: "id", mixType: "dry", status: "registered" },
      { kind: "sting", mixType: "wet", status: "registered" }
    ]);
    const firstTrack = reduce(planned.state, event({
      type: "TRACK_STARTED",
      trackId: planned.state.nextTrack.trackId!,
      revision: planned.state.nextTrack.revision!,
      spec: planned.state.nextTrack.spec!
    }));
    const cartCommands = firstTrack.commands.filter((command) => command.type === "GENERATE_CART");
    expect(cartCommands).toHaveLength(2);
    expect(firstTrack.state.carts.entries.map(({ kind, mixType, status }) => ({ kind, mixType, status }))).toEqual([
      { kind: "id", mixType: "dry", status: "generating" },
      { kind: "sting", mixType: "wet", status: "generating" }
    ]);

    const dryId = firstTrack.state.carts.entries.find((entry) => entry.mixType === "dry")!.id;
    const cruising: StationState = {
      ...playingState(130_000),
      autonomy: { lastListenerAt: 1_000, tracksSinceListener: 2, mode: "cruise" },
      carts: {
        entries: firstTrack.state.carts.entries.map((entry) => ({ ...entry, status: "ready" as const }))
      }
    };
    const played = reduce(cruising, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 50_000, remainingMs: 130_000, bufferedMs: 90_000
    }, 500_000));
    expect(played.commands).toEqual([{ type: "PLAY_CART", cartId: dryId }]);
    expect(played.state.carts.entries.find((entry) => entry.id === dryId)).toMatchObject({ useCount: 1, lastUsedAt: 500_000 });

    const finished = reduce(played.state, event({ type: "CART_FINISHED", cartId: dryId }, 503_000));
    expect(finished.state.carts.playingId).toBeUndefined();
    const repeated = reduce(finished.state, event({
      type: "TRACK_PROGRESS", trackId: "current", playheadMs: 55_000, remainingMs: 125_000, bufferedMs: 85_000
    }, 504_000));
    expect(repeated.commands).toEqual([]);
  });

  it("moves from listener-led radio into elastic cruise and exploration, then resets instantly on a listener turn", () => {
    const cruiseState: StationState = {
      ...playingState(49_000),
      autonomy: { lastListenerAt: 1_000, tracksSinceListener: 2, mode: "interactive" }
    };
    const cruise = reduce(cruiseState, event({ type: "NEXT_TRACK_HORIZON", requestId: "cruise-horizon", trackId: "current" }, 100_000));
    expect(cruise.state.autonomy.mode).toBe("cruise");
    expect(cruise.commands.find((command) => command.type === "PLAN_CONTINUITY")?.input.autonomy).toEqual({
      mode: "cruise", tracksSinceListener: 2, silenceMs: 99_000
    });

    const exploratoryState: StationState = {
      ...playingState(49_000),
      autonomy: { lastListenerAt: 1_000, tracksSinceListener: 4, mode: "interactive" }
    };
    const exploratory = reduce(exploratoryState, event({ type: "NEXT_TRACK_HORIZON", requestId: "explore-horizon", trackId: "current" }, 100_000));
    expect(exploratory.state.autonomy.mode).toBe("exploratory");

    const listener = reduce(exploratory.state, event({ type: "USER_MESSAGE", requestId: "back", message: "Give me sparkly J-pop next." }, 101_000));
    expect(listener.state.autonomy).toEqual({ lastListenerAt: 101_000, tracksSinceListener: 0, mode: "interactive" });
  });
});
