import type {
  ContinuityInput,
  MusicalIntent,
  MusicalSnapshot,
  NextTrackState,
  StationCommand,
  StationEvent,
  StationState,
  TrackDirective,
  TrackSpec,
  UrgencyInput,
  UserIntentInput
} from "@robot-radio/shared";
import { createInitialState } from "./state";

export const NEXT_TRACK_HORIZON_MS = Number(import.meta.env.VITE_NEXT_TRACK_HORIZON_MS ?? 50_000);
export const NEXT_TRACK_REQUEST_GUARD_MS = 10_000;
export const SAFE_START_BUFFER_MS = 4_000;
export const CONTINUITY_HEALTHY_BUFFER_MS = 3_000;
export const UNDERRUN_THREAT_MS = 8_000;
export const NORMAL_CROSSFADE_MS = 3_000;
export const IMMEDIATE_CROSSFADE_MS = 1_800;
export const DEFAULT_BRIDGE_MS = 4_000;
export const STARTUP_BRIDGE_MS = 1_500;
export const PROMOTED_FRAGMENT_MS = 4_000;
export const MAX_TRACK_REPAIR_ATTEMPTS = 2;
export const PROGRAM_TRACK_DURATION_MS = Number(import.meta.env.VITE_PROGRAM_TRACK_DURATION_MS ?? 180_000);

export interface Reduction {
  state: StationState;
  commands: StationCommand[];
}

function snapshot(state: StationState): MusicalSnapshot {
  return {
    title: state.playback.title ?? undefined,
    styleSummary: state.playback.styleSummary ?? state.intent.description,
    bpm: state.playback.bpm ?? midpoint(state.intent.bpmRange),
    key: state.playback.key ?? state.intent.keyPreference,
    energy: state.playback.energy ?? state.intent.energy
  };
}

function snapshotFromIntent(intent: MusicalIntent): MusicalSnapshot {
  return {
    styleSummary: intent.description,
    bpm: midpoint(intent.bpmRange),
    key: intent.keyPreference,
    energy: intent.energy
  };
}

function midpoint(range?: [number, number]): number | undefined {
  return range ? Math.round((range[0] + range[1]) / 2) : undefined;
}

function directiveFromIntent(intent: MusicalIntent, title = "A New Signal"): TrackDirective {
  return {
    title,
    description: intent.description,
    styles: intent.styles,
    mood: intent.mood,
    energy: intent.energy,
    bpm: midpoint(intent.bpmRange),
    key: intent.keyPreference,
    vocals: intent.vocals,
    language: intent.language,
    durationMs: PROGRAM_TRACK_DURATION_MS
  };
}

function urgencyInput(state: StationState, requestId: string, message: string): UrgencyInput {
  return {
    requestId,
    message,
    currentIntent: state.intent,
    currentTrack: state.playback.trackId ? snapshot(state) : null
  };
}

function userIntentInput(state: StationState, requestId: string, message: string): UserIntentInput {
  return {
    ...urgencyInput(state, requestId, message),
    remainingMs: state.playback.remainingMs,
    recentTracks: state.recentTracks.slice(-5),
    recentUserMessages: state.recentUserMessages.slice(-5),
    recentDjLines: state.recentDjLines.slice(-5)
  };
}

function continuityInput(state: StationState, requestId: string): ContinuityInput {
  return {
    requestId,
    currentIntent: state.intent,
    currentTrack: state.playback.trackId ? snapshot(state) : null,
    recentTracks: state.recentTracks.slice(-5),
    recentUserMessages: state.recentUserMessages.slice(-5),
    recentDjLines: state.recentDjLines.slice(-5)
  };
}

export function compileTrackSpec(id: string, directive: TrackDirective, intent: MusicalIntent): TrackSpec {
  const bpm = directive.bpm ?? midpoint(intent.bpmRange) ?? 116;
  const title = directive.title.trim();
  return {
    id,
    title: title || "Untitled Signal",
    description: directive.description,
    styles: directive.styles ?? intent.styles,
    mood: directive.mood ?? intent.mood,
    energy: directive.energy ?? intent.energy ?? 0.6,
    bpm,
    key: directive.key ?? intent.keyPreference ?? "E minor",
    vocals: directive.vocals ?? intent.vocals,
    language: directive.language ?? intent.language,
    durationMs: directive.durationMs ?? PROGRAM_TRACK_DURATION_MS
  };
}

function append<T>(items: T[], item: T, limit: number): T[] {
  return [...items, item].slice(-limit);
}

function finish(state: StationState, event: StationEvent, commands: StationCommand[]): Reduction {
  const recentDjLines = commands.reduce(
    (lines, command) => command.type === "SPEAK" ? append(lines, command.text, 12) : lines,
    state.recentDjLines
  );
  return {
    state: {
      ...state,
      recentEvents: [...state.recentEvents, event],
      recentCommands: [...state.recentCommands, ...commands],
      recentDjLines
    },
    commands
  };
}

function resetContinuity(state: StationState): StationState {
  return {
    ...state,
    continuity: { status: "none", bufferedMs: 0, audible: false }
  };
}

function addContinuityLease(
  continuity: StationState["continuity"],
  lease: NonNullable<StationState["continuity"]["leases"]>[number]
): StationState["continuity"] {
  return {
    ...continuity,
    leases: continuity.leases?.includes(lease) ? continuity.leases : [...(continuity.leases ?? []), lease]
  };
}

function withoutLease(
  continuity: StationState["continuity"],
  lease: NonNullable<StationState["continuity"]["leases"]>[number]
): StationState["continuity"] {
  return { ...continuity, leases: (continuity.leases ?? []).filter((candidate) => candidate !== lease) };
}

function releaseUserLease(state: StationState): Reduction {
  const continuity = withoutLease(state.continuity, "user");
  if ((continuity.leases?.length ?? 0) > 0 || continuity.audible || continuity.status === "committed") {
    return { state: { ...state, continuity }, commands: [] };
  }
  return { state: resetContinuity(state), commands: [{ type: "RELEASE_CONTINUITY" }] };
}

function isNearOrInsideHorizon(state: StationState): boolean {
  if (!state.playback.trackId) return false;
  if (state.horizonFiredForTrackId === state.playback.trackId) return true;
  if (state.nextTrack.status !== "none") return true;
  return (state.playback.remainingMs ?? Number.POSITIVE_INFINITY) <= NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS;
}

function bridgeCanHandoff(state: StationState, at: number): boolean {
  if (state.continuity.status !== "committed" || !state.continuity.audible) return false;
  if (state.nextTrack.status !== "ready" || !state.nextTrack.trackId) return false;
  const startedAt = state.continuity.bridgeStartedAt ?? at;
  const durationMs = state.continuity.bridgeDurationMs ?? 0;
  return at - startedAt >= durationMs;
}

function handoffFromBridge(state: StationState): Reduction {
  if (!state.nextTrack.trackId) return { state, commands: [] };
  return {
    state: { ...state, phase: "handoff" },
    commands: [
      {
        type: "FADE",
        from: "lyria",
        to: "track",
        trackId: state.nextTrack.trackId,
        durationMs: NORMAL_CROSSFADE_MS
      },
      { type: "RELEASE_CONTINUITY", afterMs: NORMAL_CROSSFADE_MS + 100 }
    ]
  };
}

function commitBridge(state: StationState, at: number, durationMs: number): Reduction {
  if (state.continuity.status === "committed") return { state, commands: [] };
  let nextState: StationState = {
    ...state,
    phase: "lyria_bridge",
    continuity: {
      ...state.continuity,
      status: "committed",
      audible: true,
      bridgeStartedAt: at,
      bridgeDurationMs: durationMs
    }
  };
  const commands: StationCommand[] = [
    { type: "COMMIT_CONTINUITY" },
    {
      type: "FADE",
      from: state.playback.trackId ? "track" : "silence",
      to: "lyria",
      durationMs: state.playback.trackId ? IMMEDIATE_CROSSFADE_MS : 500
    }
  ];
  if (state.pendingBridgeSpeech) {
    commands.push({ type: "SPEAK", ...state.pendingBridgeSpeech });
    nextState = { ...nextState, pendingBridgeSpeech: undefined };
  }
  return { state: nextState, commands };
}

function playableTransitionFragment(state: StationState): boolean {
  return Boolean(
    state.transitionFragment?.trackId &&
      state.transitionFragment.spec &&
      state.transitionFragment.status === "ready"
  );
}

function startTransitionFragment(state: StationState): Reduction {
  const trackId = state.transitionFragment?.trackId;
  if (!trackId) return { state, commands: [] };
  return {
    state: { ...state, phase: "handoff", transitionFragmentDue: false },
    commands: [
      {
        type: "PLAY_TRACK_FRAGMENT",
        trackId,
        fadeMs: NORMAL_CROSSFADE_MS,
        fragmentMs: PROMOTED_FRAGMENT_MS
      }
    ]
  };
}

function promotedBoundary(state: StationState, at: number): Reduction {
  if (state.pendingUser?.resolution !== "promoted") return { state, commands: [] };
  if (playableTransitionFragment(state)) return startTransitionFragment(state);
  if (state.continuity.status !== "healthy") return { state, commands: [] };
  const fragmentId = state.transitionFragment?.trackId;
  const committed = commitBridge({ ...state, transitionFragment: undefined }, at, state.continuity.bridgeDurationMs ?? DEFAULT_BRIDGE_MS);
  if (fragmentId) committed.commands.push({ type: "CANCEL_TRACK", trackId: fragmentId });
  return committed;
}

function updateTrackState(track: NextTrackState, event: StationEvent): NextTrackState {
  if (!("trackId" in event) || event.trackId !== track.trackId) return track;
  switch (event.type) {
    case "TRACK_GENERATION_STARTED":
      return { ...track, status: "generating", spec: event.spec };
    case "TRACK_FIRST_AUDIO":
      return { ...track, status: "buffering", firstAudioMs: event.latencyMs };
    case "TRACK_BUFFER_UPDATED":
      return {
        ...track,
        bufferedMs: event.bufferedMs,
        generatedMs: event.generatedMs,
        generationRate: event.generationRate
      };
    case "TRACK_DURATION_RESOLVED":
      return track.spec ? { ...track, spec: { ...track.spec, durationMs: event.durationMs } } : track;
    case "TRACK_READY":
      return { ...track, status: "ready" };
    case "TRACK_GENERATION_FAILED":
      return { ...track, status: "failed", error: event.error };
    default:
      return track;
  }
}

function resolveUserRequest(state: StationState, at: number): Reduction {
  const pending = state.pendingUser;
  if (!pending?.urgency || !pending.plan || pending.applied) return { state, commands: [] };

  const { plan, urgency, requestId } = pending;
  if (urgency.timing === "conversation_only") {
    const released = releaseUserLease({
      ...state,
      pendingUser: { ...pending, applied: true, resolution: "conversation" }
    });
    return released;
  }

  if (urgency.timing === "immediate" && urgency.interruptCurrentTrack) {
    const spec = compileTrackSpec(`replacement-${requestId}`, plan.nextTrack, plan.destinationIntent);
    let nextState: StationState = {
      ...state,
      intent: plan.destinationIntent,
      phase: state.continuity.audible ? "lyria_bridge" : "generating_next",
      nextTrack: { status: "planning", trackId: spec.id, spec, bufferedMs: 0, generatedMs: 0 },
      transitionFragment: undefined,
      transitionFragmentDue: false,
      continuityPlanRequestId: undefined,
      pendingUser: { ...pending, applied: true, resolution: "immediate" },
      continuity: {
        ...state.continuity,
        target: plan.destinationIntent,
        bridgeDurationMs: plan.transition.suggestedDurationMs
      }
    };
    const commands: StationCommand[] = [];
    if (state.nextTrack.trackId) commands.push({ type: "CANCEL_TRACK", trackId: state.nextTrack.trackId });
    if (state.transitionFragment?.trackId && state.transitionFragment.trackId !== state.nextTrack.trackId) {
      commands.push({ type: "CANCEL_TRACK", trackId: state.transitionFragment.trackId });
    }
    commands.push(
      {
        type: "STEER_CONTINUITY",
        plan: {
          sourceSummary: plan.transition.sourceSummary,
          destinationSummary: plan.transition.destinationSummary,
          durationMs: plan.transition.suggestedDurationMs,
          keyframes: plan.transition.lyriaKeyframes
        }
      },
      { type: "GENERATE_TRACK", spec }
    );
    if (plan.dj.speak && plan.dj.text) {
      const speech = { speechId: `speech-${requestId}`, text: plan.dj.text };
      if (state.continuity.audible || state.continuity.status === "committed") commands.push({ type: "SPEAK", ...speech });
      else nextState = { ...nextState, pendingBridgeSpeech: speech };
    }
    if (nextState.continuity.status === "healthy") {
      const committed = commitBridge(nextState, at, plan.transition.suggestedDurationMs);
      nextState = committed.state;
      commands.unshift(...committed.commands);
    }
    return { state: nextState, commands };
  }

  const promoted = urgency.timing === "next_track" && isNearOrInsideHorizon(state);
  if (!promoted) {
    const released = releaseUserLease({
      ...state,
      intent: plan.destinationIntent,
      queuedDirective: plan.nextTrack,
      pendingUser: { ...pending, applied: true, resolution: "deferred" }
    });
    return released;
  }

  const transitionFragment =
    state.nextTrack.trackId && state.nextTrack.spec && state.nextTrack.status !== "failed"
      ? state.nextTrack
      : undefined;
  const spec = compileTrackSpec(`requested-${requestId}`, plan.nextTrack, plan.destinationIntent);
  let nextState: StationState = {
    ...state,
    phase: "generating_next",
    intent: plan.destinationIntent,
    nextTrack: { status: "planning", trackId: spec.id, spec, bufferedMs: 0, generatedMs: 0 },
    transitionFragment,
    transitionFragmentDue: false,
    continuityPlanRequestId: undefined,
    pendingUser: { ...pending, applied: true, resolution: "promoted" },
    continuity: {
      ...state.continuity,
      target: plan.destinationIntent,
      bridgeDurationMs: plan.transition.suggestedDurationMs
    }
  };
  const commands: StationCommand[] = [
    {
      type: "STEER_CONTINUITY",
      plan: {
        sourceSummary: plan.transition.sourceSummary,
        destinationSummary: plan.transition.destinationSummary,
        durationMs: plan.transition.suggestedDurationMs,
        keyframes: plan.transition.lyriaKeyframes
      }
    },
    { type: "GENERATE_TRACK", spec }
  ];
  if (plan.dj.speak && plan.dj.text) {
    nextState = {
      ...nextState,
      pendingBridgeSpeech: { speechId: `speech-${requestId}`, text: plan.dj.text }
    };
  }
  return { state: nextState, commands };
}

export function reduce(state: StationState, event: StationEvent): Reduction {
  let nextState = state;
  let commands: StationCommand[] = [];

  switch (event.type) {
    case "START_STATION": {
      if (state.running) break;
      const requestId = `initial-${event.sessionId}`;
      nextState = {
        ...state,
        running: true,
        phase: "generating_next",
        error: undefined,
        startup: { requestId, message: event.message, status: "planning" },
        recentUserMessages: append(state.recentUserMessages, event.message, 20)
      };
      commands = [{ type: "PLAN_INITIAL_INTENT", input: { requestId, message: event.message } }];
      break;
    }

    case "INITIAL_INTENT_RECEIVED": {
      if (state.startup?.requestId !== event.requestId) break;
      const intent = event.plan.intent;
      const spec = compileTrackSpec(
        `opening-${event.requestId}`,
        directiveFromIntent(intent, event.plan.firstTrackTitle),
        intent
      );
      const seed = snapshotFromIntent(intent);
      nextState = {
        ...state,
        intent,
        startup: { ...state.startup, status: "generating" },
        nextTrack: { status: "planning", trackId: spec.id, spec, bufferedMs: 0, generatedMs: 0 },
        continuity: addContinuityLease(
          { status: "starting", bufferedMs: 0, audible: false, seed, target: intent },
          "startup"
        )
      };
      commands = [
        { type: "PREWARM_CONTINUITY", seed },
        { type: "GENERATE_TRACK", spec }
      ];
      break;
    }

    case "INITIAL_INTENT_FAILED":
      if (state.startup?.requestId !== event.requestId) break;
      nextState = { ...state, running: false, phase: "error", startup: undefined, error: event.error };
      break;

    case "STOP_STATION":
      nextState = {
        ...createInitialState(),
        recentEvents: state.recentEvents,
        recentCommands: state.recentCommands,
        intent: state.intent
      };
      commands = [{ type: "STOP_ALL" }];
      break;

    case "USER_MESSAGE": {
      const seed = snapshot(state);
      const continuityBase =
        state.continuity.status === "none" || state.continuity.status === "failed"
          ? { status: "starting" as const, bufferedMs: 0, audible: false, seed }
          : state.continuity;
      nextState = {
        ...state,
        continuity: addContinuityLease(continuityBase, "user"),
        pendingUser: { requestId: event.requestId, message: event.message, applied: false },
        recentUserMessages: append(state.recentUserMessages, event.message, 20)
      };
      const fastInput = urgencyInput(state, event.requestId, event.message);
      commands = [
        { type: "PREWARM_CONTINUITY", seed },
        { type: "ASSESS_USER_MESSAGE", input: fastInput },
        { type: "PLAN_USER_INTENT", input: userIntentInput(state, event.requestId, event.message) }
      ];
      break;
    }

    case "NEXT_TRACK_HORIZON": {
      const seed = snapshot(state);
      if (state.horizonFiredForTrackId === event.trackId) {
        commands = [{ type: "PREWARM_CONTINUITY", seed }];
        break;
      }
      const continuityBase =
        state.continuity.status === "none" || state.continuity.status === "failed"
          ? { status: "starting" as const, bufferedMs: 0, audible: false, seed }
          : state.continuity;
      nextState = {
        ...state,
        phase: "generating_next",
        horizonFiredForTrackId: event.trackId,
        continuity: addContinuityLease(continuityBase, "horizon")
      };
      commands = [{ type: "PREWARM_CONTINUITY", seed }];
      if (state.nextTrack.status !== "none") break;
      if (state.queuedDirective) {
        const spec = compileTrackSpec(`next-${event.requestId}`, state.queuedDirective, state.intent);
        nextState = {
          ...nextState,
          queuedDirective: undefined,
          nextTrack: { status: "planning", trackId: spec.id, spec, bufferedMs: 0, generatedMs: 0 }
        };
        commands.push({ type: "GENERATE_TRACK", spec });
      } else {
        nextState = {
          ...nextState,
          continuityPlanRequestId: event.requestId,
          nextTrack: { ...state.nextTrack, status: "planning" }
        };
        commands.push({ type: "PLAN_CONTINUITY", input: continuityInput(state, event.requestId) });
      }
      break;
    }

    case "URGENCY_ASSESSMENT_RECEIVED": {
      if (state.pendingUser?.requestId !== event.requestId) break;
      nextState = {
        ...state,
        pendingUser: { ...state.pendingUser, urgency: event.assessment },
        continuityPlanRequestId:
          event.assessment.timing === "immediate" && event.assessment.interruptCurrentTrack
            ? undefined
            : state.continuityPlanRequestId
      };
      if (
        event.assessment.timing === "immediate" &&
        event.assessment.interruptCurrentTrack &&
        nextState.continuity.status === "healthy"
      ) {
        const committed = commitBridge(nextState, event.at, DEFAULT_BRIDGE_MS);
        nextState = committed.state;
        commands.push(...committed.commands);
      }
      const resolved = resolveUserRequest(nextState, event.at);
      nextState = resolved.state;
      commands.push(...resolved.commands);
      break;
    }

    case "URGENCY_ASSESSMENT_FAILED": {
      if (state.pendingUser?.requestId !== event.requestId) break;
      nextState = {
        ...state,
        pendingUser: {
          ...state.pendingUser,
          urgency: { timing: "future", interruptCurrentTrack: false, confidence: 0 }
        },
        error: event.error
      };
      const resolved = resolveUserRequest(nextState, event.at);
      nextState = resolved.state;
      commands = resolved.commands;
      break;
    }

    case "USER_PLAN_RECEIVED": {
      if (state.pendingUser?.requestId !== event.requestId) break;
      nextState = { ...state, error: undefined, pendingUser: { ...state.pendingUser, plan: event.plan } };
      const resolved = resolveUserRequest(nextState, event.at);
      nextState = resolved.state;
      commands = resolved.commands;
      break;
    }

    case "USER_PLAN_FAILED": {
      if (state.pendingUser?.requestId !== event.requestId) break;
      const fallbackSpec = compileTrackSpec(
        `fallback-${event.requestId}`,
        directiveFromIntent(state.intent),
        state.intent
      );
      nextState = {
        ...state,
        error: event.error,
        pendingUser: { ...state.pendingUser, applied: true, resolution: "deferred" }
      };
      if (state.continuity.audible || state.continuity.status === "committed") {
        nextState = {
          ...nextState,
          nextTrack: { status: "planning", trackId: fallbackSpec.id, spec: fallbackSpec, bufferedMs: 0, generatedMs: 0 }
        };
        commands = [{ type: "GENERATE_TRACK", spec: fallbackSpec }];
      } else {
        const released = releaseUserLease(nextState);
        nextState = released.state;
        commands = released.commands;
      }
      break;
    }

    case "CONTINUITY_PLAN_RECEIVED": {
      if (state.continuityPlanRequestId !== event.requestId) break;
      const intent = event.plan.intentPatch ? { ...state.intent, ...event.plan.intentPatch } : state.intent;
      const spec = compileTrackSpec(`next-${event.requestId}`, event.plan.nextTrack, intent);
      nextState = {
        ...state,
        error: undefined,
        intent,
        continuityPlanRequestId: undefined,
        nextTrack: { status: "planning", trackId: spec.id, spec, bufferedMs: 0, generatedMs: 0 }
      };
      commands = [{ type: "GENERATE_TRACK", spec }];
      if (event.plan.dj?.speak && event.plan.dj.text) {
        commands.push({ type: "SPEAK", speechId: `link-${event.requestId}`, text: event.plan.dj.text });
      }
      break;
    }

    case "CONTINUITY_PLAN_FAILED": {
      if (state.continuityPlanRequestId !== event.requestId) break;
      const spec = compileTrackSpec(`fallback-${event.requestId}`, directiveFromIntent(state.intent), state.intent);
      nextState = {
        ...state,
        error: event.error,
        continuityPlanRequestId: undefined,
        nextTrack: { status: "planning", trackId: spec.id, spec, bufferedMs: 0, generatedMs: 0 }
      };
      commands = [{ type: "GENERATE_TRACK", spec }];
      break;
    }

    case "TRACK_REPAIR_RECEIVED": {
      if (state.nextTrack.trackId !== event.failedTrackId) break;
      if (state.nextTrack.repairAttempts !== event.attempt) break;
      const priorSpec = state.nextTrack.spec;
      const directive: TrackDirective = {
        ...event.plan.track,
        durationMs: event.plan.track.durationMs ?? priorSpec?.durationMs ?? PROGRAM_TRACK_DURATION_MS
      };
      const spec = compileTrackSpec(`${event.failedTrackId}-retry-${event.attempt}`, directive, state.intent);
      nextState = {
        ...state,
        error: undefined,
        nextTrack: {
          status: "planning",
          trackId: spec.id,
          spec,
          bufferedMs: 0,
          generatedMs: 0,
          repairAttempts: event.attempt
        }
      };
      commands = [{ type: "GENERATE_TRACK", spec }];
      break;
    }

    case "TRACK_REPAIR_FAILED": {
      if (state.nextTrack.trackId !== event.failedTrackId) break;
      nextState = {
        ...state,
        error: event.error,
        nextTrack: { ...state.nextTrack, status: "failed", error: event.error }
      };
      break;
    }

    case "TRACK_GENERATION_STARTED":
    case "TRACK_FIRST_AUDIO":
    case "TRACK_BUFFER_UPDATED":
    case "TRACK_DURATION_RESOLVED": {
      if (state.nextTrack.trackId === event.trackId) {
        nextState = { ...state, nextTrack: updateTrackState(state.nextTrack, event) };
      } else if (state.transitionFragment?.trackId === event.trackId) {
        nextState = { ...state, transitionFragment: updateTrackState(state.transitionFragment, event) };
      } else if (event.type === "TRACK_BUFFER_UPDATED" && state.playback.trackId === event.trackId) {
        nextState = { ...state, playback: { ...state.playback, bufferedMs: event.bufferedMs } };
      } else if (event.type === "TRACK_DURATION_RESOLVED" && state.playback.trackId === event.trackId) {
        nextState = {
          ...state,
          playback: {
            ...state.playback,
            durationMs: event.durationMs,
            remainingMs: Math.max(0, event.durationMs - state.playback.playheadMs)
          }
        };
      }
      break;
    }

    case "TRACK_READY": {
      if (state.transitionFragment?.trackId === event.trackId) {
        nextState = { ...state, transitionFragment: updateTrackState(state.transitionFragment, event) };
        if ((state.playback.remainingMs ?? Number.POSITIVE_INFINITY) <= NORMAL_CROSSFADE_MS) {
          const fragment = startTransitionFragment(nextState);
          nextState = fragment.state;
          commands = fragment.commands;
        }
        break;
      }
      if (state.nextTrack.trackId !== event.trackId) break;
      nextState = { ...state, nextTrack: updateTrackState(state.nextTrack, event) };
      if (!state.playback.trackId) {
        if (state.continuity.status === "failed" || state.continuity.status === "none") {
          commands = [{ type: "PLAY_TRACK", trackId: event.trackId, fadeMs: 250 }];
          nextState = { ...nextState, phase: "handoff" };
        } else if (bridgeCanHandoff(nextState, event.at)) {
          const handoff = handoffFromBridge(nextState);
          nextState = handoff.state;
          commands = handoff.commands;
        }
      } else if (bridgeCanHandoff(nextState, event.at)) {
        const handoff = handoffFromBridge(nextState);
        nextState = handoff.state;
        commands = handoff.commands;
      } else if (state.pendingUser?.resolution === "immediate") {
        // The replacement waits for the continuity stream even if track generation wins the race.
      } else if (state.pendingUser?.resolution === "promoted") {
        // The requested track waits for the natural boundary and the planned bridge.
      } else if (state.continuity.status !== "none" && state.continuity.status !== "committed") {
        commands = [{ type: "RELEASE_CONTINUITY" }];
        nextState = resetContinuity(nextState);
      }
      break;
    }

    case "TRACK_GENERATION_FAILED": {
      if (state.transitionFragment?.trackId === event.trackId) {
        nextState = { ...state, transitionFragment: undefined, error: event.error };
        commands = [{ type: "CANCEL_TRACK", trackId: event.trackId }];
        break;
      }
      if (state.nextTrack.trackId !== event.trackId) break;
      const failedTrack = updateTrackState(state.nextTrack, event);
      const attempt = (state.nextTrack.repairAttempts ?? 0) + 1;
      nextState = {
        ...state,
        nextTrack: {
          ...failedTrack,
          status: attempt <= MAX_TRACK_REPAIR_ATTEMPTS ? "planning" : "failed",
          repairAttempts: Math.min(attempt, MAX_TRACK_REPAIR_ATTEMPTS)
        },
        error: event.error
      };
      commands = [{ type: "CANCEL_TRACK", trackId: event.trackId }];
      if (state.continuity.status === "healthy" && state.playback.trackId) {
        const committed = commitBridge(nextState, event.at, 0);
        nextState = committed.state;
        commands.push(...committed.commands);
      }
      if (attempt <= MAX_TRACK_REPAIR_ATTEMPTS && state.nextTrack.spec) {
        commands.push({
          type: "REPAIR_TRACK_SPEC",
          failedTrackId: event.trackId,
          input: {
            requestId: `repair-${event.trackId}-${attempt}`,
            attempt,
            rejectedSpec: state.nextTrack.spec,
            providerError: event.error,
            currentIntent: state.intent
          }
        });
      }
      break;
    }

    case "LYRIA_STARTED":
      nextState = {
        ...state,
        continuity: { ...state.continuity, status: "buffering", streamId: event.streamId, seed: event.seed }
      };
      break;

    case "LYRIA_BUFFER_UPDATED": {
      if (state.continuity.streamId !== event.streamId) break;
      nextState = { ...state, continuity: { ...state.continuity, bufferedMs: event.bufferedMs } };
      if (bridgeCanHandoff(nextState, event.at)) {
        const handoff = handoffFromBridge(nextState);
        nextState = handoff.state;
        commands = handoff.commands;
      }
      break;
    }

    case "LYRIA_HEALTHY": {
      if (state.continuity.streamId !== event.streamId) break;
      nextState = { ...state, continuity: { ...state.continuity, status: "healthy" } };
      if (state.startup && !state.playback.trackId) {
        nextState = { ...nextState, startup: { ...state.startup, status: "bridging" } };
        const committed = commitBridge(nextState, event.at, STARTUP_BRIDGE_MS);
        nextState = committed.state;
        commands = committed.commands;
      } else if (state.pendingUser?.urgency?.timing === "immediate" && state.pendingUser.urgency.interruptCurrentTrack) {
        const committed = commitBridge(nextState, event.at, state.continuity.bridgeDurationMs ?? DEFAULT_BRIDGE_MS);
        nextState = committed.state;
        commands = committed.commands;
      } else if (state.transitionFragmentDue && state.pendingUser?.resolution === "promoted") {
        const fragmentId = state.transitionFragment?.trackId;
        const committed = commitBridge(
          { ...nextState, transitionFragment: undefined, transitionFragmentDue: false },
          event.at,
          state.continuity.bridgeDurationMs ?? DEFAULT_BRIDGE_MS
        );
        nextState = committed.state;
        commands = committed.commands;
        if (fragmentId) commands.push({ type: "CANCEL_TRACK", trackId: fragmentId });
      } else if (
        state.pendingUser?.resolution === "promoted" &&
        (state.playback.remainingMs ?? Number.POSITIVE_INFINITY) <= NORMAL_CROSSFADE_MS
      ) {
        const boundary = promotedBoundary(nextState, event.at);
        nextState = boundary.state;
        commands = boundary.commands;
      }
      break;
    }

    case "LYRIA_FAILED":
      nextState = {
        ...state,
        continuity: { ...state.continuity, status: "failed", audible: false, error: event.error },
        error: event.error
      };
      if (!state.playback.trackId && state.nextTrack.status === "ready" && state.nextTrack.trackId) {
        commands = [{ type: "PLAY_TRACK", trackId: state.nextTrack.trackId, fadeMs: 250 }];
        nextState = { ...nextState, phase: "handoff" };
      }
      break;

    case "TTS_STARTED":
      nextState = { ...state, dj: { speaking: true } };
      break;

    case "TTS_FINISHED":
      nextState = { ...state, dj: { speaking: false } };
      break;

    case "TRACK_STARTED": {
      const previousTrack = state.playback.trackId && state.playback.title && state.playback.styleSummary
        ? {
            trackId: state.playback.trackId,
            title: state.playback.title,
            description: state.playback.styleSummary,
            bpm: state.playback.bpm,
            key: state.playback.key,
            energy: state.playback.energy
          }
        : undefined;
      const previousTrackId = state.playback.trackId;
      nextState = {
        ...state,
        error: undefined,
        phase: "playing",
        playback: {
          trackId: event.trackId,
          title: event.spec.title,
          playheadMs: 0,
          durationMs: event.spec.durationMs,
          remainingMs: event.spec.durationMs,
          bpm: event.spec.bpm,
          key: event.spec.key,
          styleSummary: event.spec.description,
          energy: event.spec.energy,
          bufferedMs: state.nextTrack.bufferedMs
        },
        nextTrack: { status: "none", bufferedMs: 0, generatedMs: 0 },
        transitionFragment: undefined,
        transitionFragmentDue: false,
        continuity: { status: "none", bufferedMs: 0, audible: false },
        startup: undefined,
        pendingUser: undefined,
        pendingBridgeSpeech: undefined,
        horizonFiredForTrackId: null,
        continuityPlanRequestId: undefined,
        recentTracks: previousTrack
          ? append(state.recentTracks, previousTrack, 20)
          : state.recentTracks
      };
      if (previousTrackId && previousTrackId !== event.trackId) {
        commands = [{ type: "CANCEL_TRACK", trackId: previousTrackId, afterMs: NORMAL_CROSSFADE_MS + 100 }];
      }
      break;
    }

    case "TRACK_FRAGMENT_STARTED": {
      if (state.transitionFragment?.trackId !== event.trackId || !state.transitionFragment.spec) break;
      const spec = state.transitionFragment.spec;
      const previousTrackId = state.playback.trackId;
      nextState = {
        ...state,
        phase: "handoff",
        transitionFragmentDue: false,
        playback: {
          trackId: event.trackId,
          title: spec.title,
          playheadMs: 0,
          durationMs: event.fragmentMs,
          remainingMs: event.fragmentMs,
          bpm: spec.bpm,
          key: spec.key,
          styleSummary: spec.description,
          energy: spec.energy,
          bufferedMs: state.transitionFragment.bufferedMs
        },
        horizonFiredForTrackId: event.trackId
      };
      if (previousTrackId && previousTrackId !== event.trackId) {
        commands = [{ type: "CANCEL_TRACK", trackId: previousTrackId, afterMs: NORMAL_CROSSFADE_MS + 100 }];
      }
      break;
    }

    case "TRACK_FRAGMENT_ENDED": {
      if (state.transitionFragment?.trackId !== event.trackId) break;
      if (state.continuity.status === "healthy") {
        const committed = commitBridge(
          { ...state, transitionFragment: undefined, transitionFragmentDue: false },
          event.at,
          state.continuity.bridgeDurationMs ?? DEFAULT_BRIDGE_MS
        );
        nextState = committed.state;
        commands = [...committed.commands, { type: "CANCEL_TRACK", trackId: event.trackId }];
      } else {
        nextState = { ...state, transitionFragmentDue: true };
      }
      break;
    }

    case "TRACK_PROGRESS": {
      if (state.playback.trackId !== event.trackId) break;
      nextState = {
        ...state,
        playback: {
          ...state.playback,
          playheadMs: event.playheadMs,
          remainingMs: event.remainingMs,
          bufferedMs: event.bufferedMs
        }
      };
      if (state.pendingUser?.resolution === "promoted" && event.remainingMs <= NORMAL_CROSSFADE_MS) {
        const boundary = promotedBoundary(nextState, event.at);
        nextState = boundary.state;
        commands = boundary.commands;
      } else if (state.phase !== "handoff" && state.nextTrack.status === "ready" && event.remainingMs <= NORMAL_CROSSFADE_MS) {
        nextState = { ...nextState, phase: "handoff" };
        commands = [
          {
            type: "FADE",
            from: "track",
            to: "track",
            trackId: state.nextTrack.trackId,
            durationMs: NORMAL_CROSSFADE_MS
          }
        ];
      } else if (
        state.nextTrack.status !== "ready" &&
        event.remainingMs <= UNDERRUN_THREAT_MS &&
        state.continuity.status === "healthy"
      ) {
        const committed = commitBridge(nextState, event.at, state.continuity.bridgeDurationMs ?? 0);
        nextState = committed.state;
        commands = committed.commands;
      }
      break;
    }

    case "TRACK_ENDED":
      if (state.playback.trackId !== event.trackId) break;
      if (state.pendingUser?.resolution === "promoted") {
        const boundary = promotedBoundary(state, event.at);
        nextState = boundary.state;
        commands = boundary.commands;
      } else if (state.nextTrack.status === "ready" && state.nextTrack.trackId) {
        nextState = { ...state, phase: "handoff" };
        commands = [{ type: "FADE", from: "track", to: "track", trackId: state.nextTrack.trackId, durationMs: 300 }];
      } else if (state.continuity.status === "healthy") {
        const committed = commitBridge(state, event.at, state.continuity.bridgeDurationMs ?? 0);
        nextState = committed.state;
        commands = committed.commands;
      } else if (state.continuity.status !== "committed") {
        nextState = { ...state, phase: "error", error: "No playable source remained at track end." };
      }
      break;
  }

  return finish(nextState, event, commands);
}
