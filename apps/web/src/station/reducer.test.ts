import { describe, expect, it } from "vitest";
import type {
  MusicalIntent,
  StationEvent,
  StationState,
  TrackSpec,
  UrgencyAssessment,
  UserIntentPlan
} from "@robot-radio/shared";
import {
  NEXT_TRACK_HORIZON_MS,
  NEXT_TRACK_REQUEST_GUARD_MS,
  PROMOTED_FRAGMENT_MS,
  compileTrackSpec,
  reduce
} from "./reducer";
import { createInitialState } from "./state";

const at = 100_000;

const destinationIntent: MusicalIntent = {
  description: "Heavy nocturnal industrial techno",
  styles: ["industrial techno", "dark techno"],
  mood: ["driving", "intense"],
  energy: 0.82,
  bpmRange: [122, 128],
  keyPreference: "E minor",
  vocals: "instrumental",
  djTalkativeness: 0.25
};

const userPlan: UserIntentPlan = {
  destinationIntent,
  nextTrack: {
    description: "Distorted bass pulses and driving industrial drums",
    styles: destinationIntent.styles,
    mood: destinationIntent.mood,
    energy: destinationIntent.energy,
    bpm: 126,
    key: "E minor",
    vocals: "instrumental",
    durationMs: 180_000
  },
  transition: {
    sourceSummary: "Warm ambient techno",
    destinationSummary: destinationIntent.description,
    suggestedDurationMs: 6_000,
    lyriaKeyframes: [
      { at: 0, description: "Warm ambient techno", bpm: 116, key: "E minor", energy: 0.55 },
      { at: 1, description: destinationIntent.description, bpm: 126, key: "E minor", energy: 0.82 }
    ]
  },
  dj: { speak: true, text: "Adding more weight to the signal." }
};

const immediateAssessment: UrgencyAssessment = {
  timing: "immediate",
  interruptCurrentTrack: true,
  confidence: 0.98
};

function playingState(remainingMs = NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS + 10_000): StationState {
  return {
    ...createInitialState(),
    running: true,
    phase: "playing",
    playback: {
      trackId: "current",
      title: "Current",
      playheadMs: 180_000 - remainingMs,
      durationMs: 180_000,
      remainingMs,
      bpm: 116,
      key: "E minor",
      styleSummary: "Warm ambient techno",
      energy: 0.55,
      bufferedMs: remainingMs
    }
  };
}

function healthyContinuity(state = playingState(), leases: Array<"startup" | "user" | "horizon"> = ["user"]): StationState {
  return {
    ...state,
    continuity: {
      status: "healthy",
      streamId: "lyria-1",
      bufferedMs: 5_000,
      audible: false,
      leases,
      seed: { styleSummary: "Warm ambient techno", bpm: 116, key: "E minor", energy: 0.55 }
    }
  };
}

function trackSpec(id: string, description = "A continuation of the current sound"): TrackSpec {
  return compileTrackSpec(
    id,
    { description, durationMs: 180_000 },
    createInitialState().intent
  );
}

describe("station startup", () => {
  it("plans the opening vibe before it starts audio providers", () => {
    const result = reduce(createInitialState(), {
      type: "START_STATION",
      at,
      sessionId: "session-1",
      message: "Sunny jazz-house for a Sunday afternoon"
    });

    expect(result.commands.map((command) => command.type)).toEqual(["PLAN_INITIAL_INTENT"]);
    expect(result.state.startup?.status).toBe("planning");
    expect(result.state.nextTrack.status).toBe("none");
  });

  it("starts Lyria and the opening track together after the first intent arrives", () => {
    const started = reduce(createInitialState(), {
      type: "START_STATION",
      at,
      sessionId: "session-2",
      message: "Sunny jazz-house"
    });
    const requestId = started.state.startup?.requestId as string;
    const result = reduce(started.state, {
      type: "INITIAL_INTENT_RECEIVED",
      at: at + 1,
      requestId,
      plan: { intent: destinationIntent }
    });

    expect(result.commands.map((command) => command.type)).toEqual(["PREWARM_CONTINUITY", "GENERATE_TRACK"]);
    expect(result.state.intent).toEqual(destinationIntent);
    expect(result.state.continuity.leases).toContain("startup");
  });

  it("plays the startup bridge when Lyria becomes healthy", () => {
    const state: StationState = {
      ...healthyContinuity(
        {
          ...createInitialState(),
          running: true,
          phase: "generating_next",
          startup: { requestId: "initial-1", message: "A warm opening", status: "generating" },
          nextTrack: {
            status: "generating",
            trackId: "opening",
            spec: trackSpec("opening"),
            bufferedMs: 0,
            generatedMs: 0
          }
        },
        ["startup"]
      ),
      playback: createInitialState().playback
    };
    const result = reduce(state, { type: "LYRIA_HEALTHY", at, streamId: "lyria-1" });

    expect(result.commands.map((command) => command.type)).toEqual(["COMMIT_CONTINUITY", "FADE"]);
    expect(result.commands[1]).toMatchObject({ type: "FADE", from: "silence", to: "lyria" });
    expect(result.state.startup?.status).toBe("bridging");
  });

  it("fades the startup bridge into the opening track", () => {
    const state: StationState = {
      ...createInitialState(),
      running: true,
      phase: "lyria_bridge",
      startup: { requestId: "initial-2", message: "A warm opening", status: "bridging" },
      nextTrack: {
        status: "buffering",
        trackId: "opening",
        spec: trackSpec("opening"),
        bufferedMs: 10_000,
        generatedMs: 10_000
      },
      continuity: {
        status: "committed",
        streamId: "lyria-1",
        bufferedMs: 8_000,
        audible: true,
        bridgeStartedAt: at,
        bridgeDurationMs: 1_500
      }
    };
    const result = reduce(state, { type: "TRACK_READY", at: at + 2_000, trackId: "opening" });

    expect(result.commands.map((command) => command.type)).toEqual(["FADE", "RELEASE_CONTINUITY"]);
    expect(result.commands[0]).toMatchObject({ type: "FADE", from: "lyria", to: "track", trackId: "opening" });
  });
});

describe("station request routing", () => {
  it("prewarms continuity before the two concurrent user calls", () => {
    const result = reduce(playingState(), {
      type: "USER_MESSAGE",
      at,
      requestId: "request-1",
      message: "Make the next track heavier"
    });
    expect(result.commands.map((command) => command.type)).toEqual([
      "PREWARM_CONTINUITY",
      "ASSESS_USER_MESSAGE",
      "PLAN_USER_INTENT"
    ]);
  });

  it("queues a well-ahead next-track request and releases speculative Lyria", () => {
    const state = healthyContinuity({
      ...playingState(),
      pendingUser: { requestId: "request-2", message: "Next track heavier", applied: false, plan: userPlan }
    });
    const result = reduce(state, {
      type: "URGENCY_ASSESSMENT_RECEIVED",
      at,
      requestId: "request-2",
      assessment: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.98 }
    });

    expect(result.state.intent).toEqual(destinationIntent);
    expect(result.state.queuedDirective).toEqual(userPlan.nextTrack);
    expect(result.state.pendingUser?.resolution).toBe("deferred");
    expect(result.commands.map((command) => command.type)).toEqual(["RELEASE_CONTINUITY"]);
  });

  it("generates a queued user track immediately when the horizon arrives", () => {
    const state: StationState = {
      ...playingState(NEXT_TRACK_HORIZON_MS),
      intent: destinationIntent,
      queuedDirective: userPlan.nextTrack
    };
    const result = reduce(state, {
      type: "NEXT_TRACK_HORIZON",
      at,
      requestId: "horizon-1",
      trackId: "current"
    });

    expect(result.commands.map((command) => command.type)).toEqual(["PREWARM_CONTINUITY", "GENERATE_TRACK"]);
    expect(result.state.continuityPlanRequestId).toBeUndefined();
    expect(result.state.nextTrack.spec?.description).toBe(userPlan.nextTrack.description);
  });

  it("asks the continuity planner at the horizon when no user track is queued", () => {
    const result = reduce(playingState(NEXT_TRACK_HORIZON_MS), {
      type: "NEXT_TRACK_HORIZON",
      at,
      requestId: "horizon-2",
      trackId: "current"
    });

    expect(result.commands.map((command) => command.type)).toEqual(["PREWARM_CONTINUITY", "PLAN_CONTINUITY"]);
  });

  it("promotes a next-track request inside the guard band without fading early", () => {
    const oldSpec = trackSpec("old-next");
    const state = healthyContinuity({
      ...playingState(NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS - 1),
      nextTrack: {
        status: "buffering",
        trackId: oldSpec.id,
        spec: oldSpec,
        bufferedMs: 2_000,
        generatedMs: 2_000
      },
      pendingUser: { requestId: "request-3", message: "Next track heavier", applied: false, plan: userPlan }
    });
    const result = reduce(state, {
      type: "URGENCY_ASSESSMENT_RECEIVED",
      at,
      requestId: "request-3",
      assessment: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.98 }
    });

    expect(result.state.pendingUser?.resolution).toBe("promoted");
    expect(result.state.transitionFragment?.trackId).toBe("old-next");
    expect(result.state.nextTrack.trackId).toBe("requested-request-3");
    expect(result.commands.map((command) => command.type)).toEqual(["STEER_CONTINUITY", "GENERATE_TRACK"]);
    expect(result.commands.some((command) => command.type === "FADE")).toBe(false);
  });

  it("plays a healthy old-next fragment at the natural boundary", () => {
    const fragment = trackSpec("old-next");
    const desired = trackSpec("requested");
    const state = healthyContinuity({
      ...playingState(2_500),
      pendingUser: {
        requestId: "request-4",
        message: "Next track heavier",
        applied: true,
        resolution: "promoted",
        urgency: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.98 },
        plan: userPlan
      },
      transitionFragment: {
        status: "ready",
        trackId: fragment.id,
        spec: fragment,
        bufferedMs: 8_000,
        generatedMs: 180_000
      },
      nextTrack: {
        status: "generating",
        trackId: desired.id,
        spec: desired,
        bufferedMs: 0,
        generatedMs: 0
      }
    });
    const result = reduce(state, {
      type: "TRACK_PROGRESS",
      at,
      trackId: "current",
      playheadMs: 177_500,
      remainingMs: 2_500,
      bufferedMs: 2_500
    });

    expect(result.commands).toEqual([
      { type: "PLAY_TRACK_FRAGMENT", trackId: "old-next", fadeMs: 3_000, fragmentMs: PROMOTED_FRAGMENT_MS }
    ]);
  });

  it("moves a transition fragment into Lyria and starts queued speech", () => {
    const fragment = trackSpec("old-next");
    const state = healthyContinuity({
      ...playingState(PROMOTED_FRAGMENT_MS),
      pendingUser: {
        requestId: "request-5",
        message: "Next track heavier",
        applied: true,
        resolution: "promoted",
        urgency: { timing: "next_track", interruptCurrentTrack: false, confidence: 0.98 },
        plan: userPlan
      },
      pendingBridgeSpeech: { speechId: "speech-request-5", text: "Adding more weight." },
      transitionFragment: {
        status: "ready",
        trackId: fragment.id,
        spec: fragment,
        bufferedMs: 8_000,
        generatedMs: 180_000
      }
    });
    const result = reduce(state, { type: "TRACK_FRAGMENT_ENDED", at, trackId: "old-next" });

    expect(result.commands.map((command) => command.type)).toEqual(["COMMIT_CONTINUITY", "FADE", "SPEAK", "CANCEL_TRACK"]);
    expect(result.state.phase).toBe("lyria_bridge");
  });

  it("commits Lyria as soon as an immediate request and its prewarm are ready", () => {
    const state = healthyContinuity({
      ...playingState(),
      pendingUser: { requestId: "request-6", message: "Switch now", applied: false }
    });
    const result = reduce(state, {
      type: "URGENCY_ASSESSMENT_RECEIVED",
      at,
      requestId: "request-6",
      assessment: immediateAssessment
    });

    expect(result.commands.map((command) => command.type)).toEqual(["COMMIT_CONTINUITY", "FADE"]);
    expect(result.state.phase).toBe("lyria_bridge");
  });

  it("always generates and steers when the immediate plan arrives", () => {
    const state: StationState = {
      ...playingState(),
      phase: "lyria_bridge",
      continuity: {
        status: "committed",
        streamId: "lyria-1",
        bufferedMs: 8_000,
        audible: true,
        bridgeStartedAt: at,
        bridgeDurationMs: 4_000,
        leases: ["user"]
      },
      pendingUser: {
        requestId: "request-7",
        message: "Switch now",
        applied: false,
        urgency: immediateAssessment
      }
    };
    const result = reduce(state, {
      type: "USER_PLAN_RECEIVED",
      at: at + 1,
      requestId: "request-7",
      plan: userPlan
    });

    expect(result.commands.map((command) => command.type)).toEqual(["STEER_CONTINUITY", "GENERATE_TRACK", "SPEAK"]);
    expect(result.state.nextTrack.trackId).toBe("replacement-request-7");
    expect(result.state.intent).toEqual(destinationIntent);
    expect(result.state.phase).toBe("lyria_bridge");
  });

  it("keeps waiting for Lyria when an immediate replacement track wins the race", () => {
    const desired = trackSpec("replacement-fast");
    const state: StationState = {
      ...playingState(),
      phase: "generating_next",
      nextTrack: {
        status: "buffering",
        trackId: desired.id,
        spec: desired,
        bufferedMs: 8_000,
        generatedMs: 8_000
      },
      continuity: {
        status: "starting",
        bufferedMs: 0,
        audible: false,
        leases: ["user"]
      },
      pendingUser: {
        requestId: "request-fast-track",
        message: "Switch now",
        applied: true,
        resolution: "immediate",
        urgency: immediateAssessment,
        plan: userPlan
      }
    };

    const result = reduce(state, { type: "TRACK_READY", at, trackId: desired.id });

    expect(result.commands).toEqual([]);
    expect(result.state.nextTrack.status).toBe("ready");
    expect(result.state.continuity.status).toBe("starting");
  });

  it("waits for the planned bridge duration before it plays a ready replacement", () => {
    const desired = trackSpec("replacement");
    const state: StationState = {
      ...playingState(),
      phase: "lyria_bridge",
      nextTrack: {
        status: "buffering",
        trackId: desired.id,
        spec: desired,
        bufferedMs: 10_000,
        generatedMs: 10_000
      },
      continuity: {
        status: "committed",
        streamId: "lyria-1",
        bufferedMs: 8_000,
        audible: true,
        bridgeStartedAt: at,
        bridgeDurationMs: 6_000
      }
    };
    const ready = reduce(state, { type: "TRACK_READY", at: at + 2_000, trackId: desired.id });
    expect(ready.commands).toEqual([]);

    const elapsed = reduce(ready.state, {
      type: "LYRIA_BUFFER_UPDATED",
      at: at + 6_100,
      streamId: "lyria-1",
      bufferedMs: 9_000
    });
    expect(elapsed.commands.map((command) => command.type)).toEqual(["FADE", "RELEASE_CONTINUITY"]);
  });

  it("releases Lyria for a conversation-only message", () => {
    const state = healthyContinuity({
      ...playingState(),
      pendingUser: { requestId: "request-8", message: "This is great", applied: false, plan: userPlan }
    });
    const result = reduce(state, {
      type: "URGENCY_ASSESSMENT_RECEIVED",
      at,
      requestId: "request-8",
      assessment: { timing: "conversation_only", interruptCurrentTrack: false, confidence: 0.98 }
    });

    expect(result.commands.map((command) => command.type)).toEqual(["RELEASE_CONTINUITY"]);
    expect(result.state.intent).toEqual(createInitialState().intent);
  });
});

describe("station recovery", () => {
  it("generates a deterministic fallback when the horizon planner fails", () => {
    const state: StationState = {
      ...healthyContinuity(playingState(NEXT_TRACK_HORIZON_MS), ["horizon"]),
      continuityPlanRequestId: "horizon-failed",
      nextTrack: { status: "planning", bufferedMs: 0, generatedMs: 0 }
    };
    const result = reduce(state, {
      type: "CONTINUITY_PLAN_FAILED",
      at,
      requestId: "horizon-failed",
      error: "Planner timed out"
    });

    expect(result.commands.map((command) => command.type)).toEqual(["GENERATE_TRACK"]);
    expect(result.state.nextTrack.trackId).toBe("fallback-horizon-failed");
  });

  it("commits healthy Lyria when an underrun threatens", () => {
    const next = trackSpec("next");
    const state: StationState = {
      ...healthyContinuity(playingState(7_000), ["horizon"]),
      nextTrack: { status: "buffering", trackId: next.id, spec: next, bufferedMs: 2_000, generatedMs: 2_000 }
    };
    const event: StationEvent = {
      type: "TRACK_PROGRESS",
      at,
      trackId: "current",
      playheadMs: 173_000,
      remainingMs: 7_000,
      bufferedMs: 7_000
    };
    const result = reduce(state, event);

    expect(result.commands.map((command) => command.type)).toEqual(["COMMIT_CONTINUITY", "FADE"]);
    expect(result.state.continuity.audible).toBe(true);
  });

  it("uses the duration resolved from received PCM for an audible track", () => {
    const result = reduce(playingState(), {
      type: "TRACK_DURATION_RESOLVED",
      at,
      trackId: "current",
      durationMs: 175_650
    });

    expect(result.state.playback.durationMs).toBe(175_650);
    expect(result.state.playback.remainingMs).toBe(175_650 - result.state.playback.playheadMs);
  });
});
