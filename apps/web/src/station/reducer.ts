import type {
  ContinuityInput,
  DJLineInput,
  MusicalIntent,
  MusicalSnapshot,
  StationCommand,
  StationEvent,
  StationState,
  TrackDirective,
  TrackSpec,
  TransitionSketch,
  TransitionSpec,
  UrgencyAssessment,
  UrgencyInput,
  UserIntentInput
} from "@robot-radio/shared";
import { createInitialState } from "./state";

export const NEXT_TRACK_HORIZON_MS = Number(import.meta.env.VITE_NEXT_TRACK_HORIZON_MS ?? 50_000);
export const NEXT_TRACK_REQUEST_GUARD_MS = 10_000;
export const SAFE_START_BUFFER_MS = 10_000;
export const TRANSITION_SAFE_BUFFER_MS = 8_000;
export const UNDERRUN_THREAT_MS = 15_000;
export const NORMAL_CROSSFADE_MS = 3_000;
export const IMMEDIATE_CROSSFADE_MS = 1_800;
export const TRANSITION_MINIMUM_PLAY_MS = 8_000;
export const TRANSITION_DURATION_MS = 30_000;
export const MAX_TRACK_REPAIR_ATTEMPTS = 2;
export const PROGRAM_TRACK_DURATION_MS = Number(import.meta.env.VITE_PROGRAM_TRACK_DURATION_MS ?? 180_000);

export interface Reduction { state: StationState; commands: StationCommand[] }

function midpoint(range?: [number, number]): number | undefined {
  return range ? Math.round((range[0] + range[1]) / 2) : undefined;
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

export function compileTrackSpec(id: string, revision: number, directive: TrackDirective, intent: MusicalIntent): TrackSpec {
  return {
    id,
    revision,
    title: directive.title.trim() || "Untitled Signal",
    description: directive.description,
    styles: directive.styles ?? intent.styles,
    mood: directive.mood ?? intent.mood,
    energy: directive.energy ?? intent.energy ?? 0.6,
    bpm: directive.bpm ?? midpoint(intent.bpmRange) ?? 116,
    key: directive.key ?? intent.keyPreference ?? "E minor",
    vocals: directive.vocals ?? intent.vocals,
    language: directive.language ?? intent.language,
    durationMs: directive.durationMs ?? PROGRAM_TRACK_DURATION_MS,
    sections: directive.sections
  };
}

function compileTransitionSpec(
  id: string,
  revision: number,
  state: StationState,
  sketch: TransitionSketch | undefined,
  destination: MusicalIntent,
  reason: TransitionSpec["reason"]
): TransitionSpec {
  const direction = sketch?.energyDirection ?? "steady";
  const sourceEnergy = state.playback.energy ?? state.intent.energy ?? 0.55;
  const destinationEnergy = destination.energy ?? sourceEnergy;
  return {
    id,
    revision,
    description: sketch?.description ?? `An instrumental radio bridge that naturally moves from ${snapshot(state).styleSummary} toward ${destination.description}.`,
    sourceSummary: sketch?.sourceSummary ?? snapshot(state).styleSummary,
    destinationSummary: sketch?.destinationSketch ?? destination.description,
    styles: [...new Set([...state.intent.styles.slice(0, 3), ...destination.styles.slice(0, 3)])].slice(0, 6),
    mood: [...new Set([...state.intent.mood.slice(0, 3), ...destination.mood.slice(0, 3)])].slice(0, 6),
    energy: direction === "up" ? Math.max(sourceEnergy, destinationEnergy) : direction === "down" ? Math.min(sourceEnergy, destinationEnergy) : (sourceEnergy + destinationEnergy) / 2,
    bpm: midpoint(destination.bpmRange) ?? state.playback.bpm ?? midpoint(state.intent.bpmRange) ?? 116,
    durationMs: TRANSITION_DURATION_MS,
    instrumental: true,
    reason
  };
}

function urgencyInput(state: StationState, requestId: string, message: string): UrgencyInput {
  return { requestId, message, currentIntent: state.intent, currentTrack: state.playback.trackId ? snapshot(state) : null };
}

function userIntentInput(state: StationState, requestId: string, message: string): UserIntentInput {
  return {
    ...urgencyInput(state, requestId, message),
    remainingMs: state.playback.remainingMs,
    recentTracks: state.recentTracks.slice(-6),
    recentUserMessages: state.recentUserMessages.slice(-6),
    recentDjLines: state.recentDjLines.slice(-6)
  };
}

function continuityInput(state: StationState, requestId: string): ContinuityInput {
  return {
    requestId,
    currentIntent: state.intent,
    currentTrack: state.playback.trackId ? snapshot(state) : null,
    recentTracks: state.recentTracks.slice(-6),
    recentUserMessages: state.recentUserMessages.slice(-6),
    recentDjLines: state.recentDjLines.slice(-6)
  };
}

function djInput(
  state: StationState,
  requestId: string,
  reason: DJLineInput["reason"],
  userMessage?: string,
  nextTrack?: TrackDirective
): DJLineInput {
  return {
    requestId,
    userMessage,
    reason,
    currentIntent: state.intent,
    currentTrack: state.playback.trackId ? snapshot(state) : null,
    nextTrack,
    recentTracks: state.recentTracks.slice(-6),
    recentUserMessages: state.recentUserMessages.slice(-6),
    recentDjLines: state.recentDjLines.slice(-6)
  };
}

function append<T>(items: T[], item: T, limit: number): T[] { return [...items, item].slice(-limit) }

function finish(state: StationState, event: StationEvent, commands: StationCommand[]): Reduction {
  const recentDjLines = commands.reduce(
    (lines, command) => command.type === "SPEAK" ? append(lines, command.text, 12) : lines,
    state.recentDjLines
  );
  return {
    state: {
      ...state,
      recentDjLines,
      recentEvents: append(state.recentEvents, event, 500),
      recentCommands: [...state.recentCommands, ...commands].slice(-500)
    },
    commands
  };
}

function emptyNext(): StationState["nextTrack"] { return { status: "none", bufferedMs: 0, generatedMs: 0 } }
function emptyTransition(): StationState["transition"] { return { status: "none", bufferedMs: 0, generatedMs: 0 } }

function handoff(state: StationState): Reduction {
  const trackId = state.nextTrack.trackId;
  if (!trackId) return { state, commands: [] };
  const from = state.transition.status === "audible" ? "transition" : state.playback.trackId ? "track" : "silence";
  const commands: StationCommand[] = [];
  let nextState = state;
  if (state.dj.pending) {
    commands.push({ type: "SPEAK", speechId: state.dj.pending.speechId, text: state.dj.pending.text });
    nextState = { ...state, dj: { ...state.dj, pending: undefined } };
  }
  commands.push({ type: "FADE", from, to: "track", trackId, durationMs: NORMAL_CROSSFADE_MS });
  if (state.transition.transitionId) commands.push({ type: "CANCEL_TRANSITION", transitionId: state.transition.transitionId, afterMs: NORMAL_CROSSFADE_MS + 100 });
  return { state: { ...nextState, phase: "handoff" }, commands };
}

function canHandoff(state: StationState): boolean {
  return state.nextTrack.status === "ready" && Boolean(state.nextTrack.trackId) && !state.dj.speaking && !state.dj.pending &&
    state.transition.status === "audible" && state.transition.minimumPlayed === true;
}

function resolveUser(state: StationState, at: number): Reduction {
  const pending = state.pendingUser;
  if (!pending || pending.applied || !pending.urgency || !pending.plan) return { state, commands: [] };
  const { urgency, plan, requestId, revision, message } = pending;
  if (revision !== state.intentRevision) return { state: { ...state, pendingUser: undefined }, commands: [] };

  if (urgency.timing === "conversation_only") {
    const commands: StationCommand[] = [{ type: "PLAN_DJ_LINE", revision, input: djInput(state, `dj-${requestId}`, "conversation", message) }];
    return { state: { ...state, pendingUser: { ...pending, applied: true, resolution: "conversation" } }, commands };
  }

  const nearHorizon = (state.playback.remainingMs ?? Infinity) <= NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS || state.nextTrack.status !== "none";
  const promoted = urgency.timing === "immediate" || (urgency.timing === "next_track" && nearHorizon);
  if (!promoted) {
    const commands: StationCommand[] = [];
    if (state.transition.transitionId && state.transition.revision === revision) {
      commands.push({ type: "CANCEL_TRANSITION", transitionId: state.transition.transitionId });
    }
    return {
      state: {
        ...state,
        intent: plan.destinationIntent,
        queuedDirective: plan.nextTrack,
        transition: state.transition.revision === revision ? emptyTransition() : state.transition,
        pendingUser: { ...pending, applied: true, resolution: "deferred" }
      },
      commands
    };
  }

  const trackSpec = compileTrackSpec(`${requestId}-track`, revision, plan.nextTrack, plan.destinationIntent);
  const commands: StationCommand[] = [];
  let transitionState = state.transition;
  if (state.nextTrack.trackId && state.nextTrack.trackId !== trackSpec.id) commands.push({ type: "CANCEL_TRACK", trackId: state.nextTrack.trackId });
  if (state.transition.revision !== revision || state.transition.status === "failed" || state.transition.status === "none") {
    const transition = compileTransitionSpec(`${requestId}-transition`, revision, state, urgency.immediateTransition, plan.destinationIntent, "immediate");
    if (state.transition.transitionId && state.transition.transitionId !== transition.id) commands.push({ type: "CANCEL_TRANSITION", transitionId: state.transition.transitionId });
    transitionState = { status: "generating", transitionId: transition.id, revision, spec: transition, bufferedMs: 0, generatedMs: 0 };
    commands.push({ type: "GENERATE_TRANSITION", spec: transition });
  }
  commands.push({ type: "GENERATE_TRACK", spec: trackSpec });
  commands.push({ type: "PLAN_DJ_LINE", revision, input: djInput({ ...state, intent: plan.destinationIntent }, `dj-${requestId}`, "user_change", message, plan.nextTrack) });
  return {
    state: {
      ...state,
      phase: "generating_next",
      intent: plan.destinationIntent,
      nextTrack: { status: "generating", trackId: trackSpec.id, revision, spec: trackSpec, bufferedMs: 0, generatedMs: 0 },
      transition: transitionState,
      pendingUser: { ...pending, applied: true, resolution: urgency.timing === "immediate" ? "immediate" : "next" }
    },
    commands
  };
}

function beginTransitionFromUrgency(state: StationState, assessment: UrgencyAssessment): Reduction {
  const pending = state.pendingUser;
  if (!pending || assessment.timing !== "immediate" || !assessment.interruptCurrentTrack || !assessment.immediateTransition) return { state, commands: [] };
  if (state.transition.revision === pending.revision && state.transition.status !== "none") return { state, commands: [] };
  const provisionalIntent: MusicalIntent = {
    ...state.intent,
    description: assessment.immediateTransition.destinationSketch,
    energy: assessment.immediateTransition.energyDirection === "up" ? Math.min(1, (state.intent.energy ?? 0.55) + 0.15) :
      assessment.immediateTransition.energyDirection === "down" ? Math.max(0, (state.intent.energy ?? 0.55) - 0.15) : state.intent.energy
  };
  const spec = compileTransitionSpec(`${pending.requestId}-transition`, pending.revision, state, assessment.immediateTransition, provisionalIntent, "immediate");
  const commands: StationCommand[] = [];
  if (state.transition.transitionId) commands.push({ type: "CANCEL_TRANSITION", transitionId: state.transition.transitionId });
  commands.push({ type: "GENERATE_TRANSITION", spec });
  return {
    state: { ...state, transition: { status: "generating", transitionId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 } },
    commands
  };
}

function eventMatchesNext(state: StationState, trackId: string, revision: number): boolean {
  return state.nextTrack.trackId === trackId && state.nextTrack.revision === revision;
}
function eventMatchesTransition(state: StationState, transitionId: string, revision: number): boolean {
  return state.transition.transitionId === transitionId && state.transition.revision === revision;
}

export function reduce(state: StationState, event: StationEvent): Reduction {
  let next = state;
  let commands: StationCommand[] = [];

  switch (event.type) {
    case "START_STATION": {
      const fresh = createInitialState();
      next = { ...fresh, running: true, intentRevision: 1, startup: { requestId: event.sessionId, message: event.message, status: "planning" } };
      commands = [{ type: "PLAN_INITIAL_INTENT", input: { requestId: event.sessionId, message: event.message } }];
      break;
    }
    case "STOP_STATION":
      next = createInitialState();
      commands = [{ type: "STOP_ALL" }];
      break;
    case "INITIAL_INTENT_RECEIVED": {
      if (state.startup?.requestId !== event.requestId) break;
      const spec = compileTrackSpec(`${event.requestId}-opening`, state.intentRevision, event.plan.firstTrack, event.plan.intent);
      next = {
        ...state,
        phase: "generating_next",
        intent: event.plan.intent,
        startup: { ...state.startup, status: "generating" },
        nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
      };
      commands = [{ type: "GENERATE_TRACK", spec }];
      break;
    }
    case "INITIAL_INTENT_FAILED":
      if (state.startup?.requestId === event.requestId) next = { ...state, phase: "error", error: event.error };
      break;
    case "USER_MESSAGE": {
      const revision = state.intentRevision + 1;
      next = {
        ...state,
        intentRevision: revision,
        pendingUser: { requestId: event.requestId, revision, message: event.message, applied: false },
        recentUserMessages: append(state.recentUserMessages, event.message, 12)
      };
      commands = [
        { type: "ASSESS_USER_MESSAGE", input: urgencyInput(state, event.requestId, event.message) },
        { type: "PLAN_USER_INTENT", input: userIntentInput(state, event.requestId, event.message) }
      ];
      break;
    }
    case "URGENCY_ASSESSMENT_RECEIVED": {
      if (state.pendingUser?.requestId !== event.requestId) break;
      next = { ...state, pendingUser: { ...state.pendingUser, urgency: event.assessment } };
      const begun = beginTransitionFromUrgency(next, event.assessment);
      next = begun.state;
      commands.push(...begun.commands);
      const resolved = resolveUser(next, event.at);
      next = resolved.state;
      commands.push(...resolved.commands);
      break;
    }
    case "URGENCY_ASSESSMENT_FAILED":
      if (state.pendingUser?.requestId === event.requestId) next = { ...state, pendingUser: undefined, error: event.error };
      break;
    case "USER_PLAN_RECEIVED": {
      if (state.pendingUser?.requestId !== event.requestId) break;
      next = { ...state, pendingUser: { ...state.pendingUser, plan: event.plan } };
      const resolved = resolveUser(next, event.at);
      next = resolved.state;
      commands = resolved.commands;
      break;
    }
    case "USER_PLAN_FAILED":
      if (state.pendingUser?.requestId === event.requestId) next = { ...state, pendingUser: undefined, error: event.error };
      break;
    case "NEXT_TRACK_HORIZON": {
      if (event.trackId !== state.playback.trackId || state.horizonFiredForTrackId === event.trackId) break;
      const requestId = event.requestId;
      next = { ...state, horizonFiredForTrackId: event.trackId, phase: "generating_next" };
      if (state.queuedDirective) {
        const spec = compileTrackSpec(`${requestId}-queued`, state.intentRevision, state.queuedDirective, state.intent);
        next = { ...next, queuedDirective: undefined, nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 } };
        commands = [{ type: "GENERATE_TRACK", spec }];
      } else {
        next = { ...next, continuityPlanRequestId: requestId, nextTrack: { status: "planning", revision: state.intentRevision, bufferedMs: 0, generatedMs: 0 } };
        commands = [{ type: "PLAN_CONTINUITY", input: continuityInput(state, requestId) }];
      }
      break;
    }
    case "CONTINUITY_PLAN_RECEIVED": {
      if (state.continuityPlanRequestId !== event.requestId) break;
      const intent = event.plan.intentPatch ? { ...state.intent, ...event.plan.intentPatch } : state.intent;
      const spec = compileTrackSpec(`${event.requestId}-track`, state.intentRevision, event.plan.nextTrack, intent);
      next = {
        ...state, intent, continuityPlanRequestId: undefined,
        nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
      };
      commands = [
        { type: "GENERATE_TRACK", spec },
        { type: "PLAN_DJ_LINE", revision: state.intentRevision, input: djInput({ ...state, intent }, `dj-${event.requestId}`, "track_change", undefined, event.plan.nextTrack) }
      ];
      break;
    }
    case "CONTINUITY_PLAN_FAILED":
      if (state.continuityPlanRequestId === event.requestId) next = { ...state, phase: "error", error: event.error };
      break;
    case "DJ_LINE_RECEIVED": {
      if (event.revision !== state.intentRevision || !event.plan.speak || !event.plan.text) break;
      const pending = { speechId: event.requestId, text: event.plan.text, revision: event.revision };
      next = { ...state, dj: { ...state.dj, pending } };
      const noPendingTrackChange = state.nextTrack.status === "none" || (state.playback.remainingMs ?? Infinity) <= UNDERRUN_THREAT_MS;
      if (state.transition.status === "audible" || (state.transition.status === "none" && noPendingTrackChange)) {
        next = { ...next, dj: { ...next.dj, pending: undefined } };
        commands = [{ type: "SPEAK", speechId: pending.speechId, text: pending.text }];
      }
      break;
    }
    case "DJ_LINE_FAILED":
      break;
    case "TRACK_GENERATION_STARTED":
      if (eventMatchesNext(state, event.trackId, event.revision)) next = { ...state, nextTrack: { ...state.nextTrack, status: "generating", spec: event.spec } };
      break;
    case "TRACK_FIRST_AUDIO":
      if (eventMatchesNext(state, event.trackId, event.revision)) next = { ...state, nextTrack: { ...state.nextTrack, status: "buffering", firstAudioMs: event.latencyMs } };
      break;
    case "TRACK_BUFFER_UPDATED":
      if (eventMatchesNext(state, event.trackId, event.revision)) next = { ...state, nextTrack: { ...state.nextTrack, status: state.nextTrack.status === "ready" ? "ready" : "buffering", bufferedMs: event.bufferedMs, generatedMs: event.generatedMs, generationRate: event.generationRate } };
      break;
    case "TRACK_DURATION_RESOLVED":
      if (eventMatchesNext(state, event.trackId, event.revision) && state.nextTrack.spec) next = { ...state, nextTrack: { ...state.nextTrack, spec: { ...state.nextTrack.spec, durationMs: event.durationMs } } };
      break;
    case "TRACK_READY": {
      if (!eventMatchesNext(state, event.trackId, event.revision)) break;
      next = { ...state, nextTrack: { ...state.nextTrack, status: "ready" } };
      if (!state.playback.trackId) commands = [{ type: "PLAY_TRACK", trackId: event.trackId, durationMs: 500 }];
      else if (canHandoff(next)) {
        const ready = handoff(next);
        next = ready.state;
        commands = ready.commands;
      } else if (state.transition.status === "failed" && state.pendingUser?.resolution === "immediate") {
        const ready = handoff(next);
        next = ready.state;
        commands = ready.commands;
      } else if (state.transition.status === "none" && (state.playback.remainingMs ?? Infinity) <= NORMAL_CROSSFADE_MS + 1_000) {
        const ready = handoff(next);
        next = ready.state;
        commands = ready.commands;
      }
      break;
    }
    case "TRACK_GENERATION_FAILED": {
      if (!eventMatchesNext(state, event.trackId, event.revision) || !state.nextTrack.spec) break;
      const attempt = (state.nextTrack.repairAttempts ?? 0) + 1;
      if (attempt > MAX_TRACK_REPAIR_ATTEMPTS) {
        next = { ...state, nextTrack: { ...state.nextTrack, status: "failed", error: event.error }, error: event.error };
        break;
      }
      next = { ...state, nextTrack: { ...state.nextTrack, status: "planning", repairAttempts: attempt, error: event.error } };
      commands = [{ type: "REPAIR_TRACK_SPEC", failedTrackId: event.trackId, input: { requestId: `${event.trackId}-repair-${attempt}`, attempt, rejectedSpec: state.nextTrack.spec, providerError: event.error, currentIntent: state.intent } }];
      break;
    }
    case "TRACK_REPAIR_RECEIVED": {
      if (state.nextTrack.trackId !== event.failedTrackId || !state.nextTrack.spec) break;
      const spec = compileTrackSpec(`${event.failedTrackId}-r${event.attempt}`, state.nextTrack.spec.revision, event.plan.track, state.intent);
      next = { ...state, nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0, repairAttempts: event.attempt } };
      commands = [{ type: "GENERATE_TRACK", spec }];
      break;
    }
    case "TRACK_REPAIR_FAILED":
      if (state.nextTrack.trackId === event.failedTrackId) next = { ...state, nextTrack: { ...state.nextTrack, status: "failed", error: event.error }, error: event.error };
      break;
    case "TRANSITION_GENERATION_STARTED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) next = { ...state, transition: { ...state.transition, status: "generating", spec: event.spec } };
      break;
    case "TRANSITION_FIRST_AUDIO":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) next = { ...state, transition: { ...state.transition, status: "buffering", firstAudioMs: event.latencyMs } };
      break;
    case "TRANSITION_BUFFER_UPDATED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        const status = state.transition.status === "audible" ? "audible" : state.transition.status === "ready" ? "ready" : "buffering";
        next = { ...state, transition: { ...state.transition, status, bufferedMs: event.bufferedMs, generatedMs: event.generatedMs, generationRate: event.generationRate } };
      }
      break;
    case "TRANSITION_READY":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        next = { ...state, transition: { ...state.transition, status: "ready" } };
        if (state.pendingUser?.revision === event.revision && ["immediate", "next"].includes(state.pendingUser.resolution ?? "")) {
          commands = [{ type: "PLAY_TRANSITION", transitionId: event.transitionId, durationMs: IMMEDIATE_CROSSFADE_MS, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }];
        } else if ((state.playback.remainingMs ?? Infinity) <= UNDERRUN_THREAT_MS) {
          commands = [{ type: "PLAY_TRANSITION", transitionId: event.transitionId, durationMs: NORMAL_CROSSFADE_MS, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }];
        }
      }
      break;
    case "TRANSITION_GENERATION_FAILED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) next = { ...state, transition: { ...state.transition, status: "failed", error: event.error }, error: event.error };
      break;
    case "TRANSITION_STARTED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        next = { ...state, phase: "transition", transition: { ...state.transition, status: "audible", startedAt: event.at, minimumPlayed: false } };
        if (state.dj.pending?.revision === event.revision) {
          commands = [{ type: "SPEAK", speechId: state.dj.pending.speechId, text: state.dj.pending.text }];
          next = { ...next, dj: { ...state.dj, pending: undefined } };
        }
      }
      break;
    case "TRANSITION_MINIMUM_PLAYED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        next = { ...state, transition: { ...state.transition, minimumPlayed: true } };
        if (canHandoff(next)) {
          const ready = handoff(next);
          next = ready.state;
          commands = ready.commands;
        }
      }
      break;
    case "TRANSITION_ENDED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        if (state.nextTrack.status === "ready") {
          const ready = handoff({ ...state, transition: { ...state.transition, minimumPlayed: true } });
          next = ready.state;
          commands = ready.commands;
        } else next = { ...state, phase: "error", error: "The transition ended before replacement music was ready." };
      }
      break;
    case "TTS_STARTED":
      next = { ...state, dj: { ...state.dj, speaking: true } };
      break;
    case "TTS_FINISHED": {
      next = { ...state, dj: { ...state.dj, speaking: false }, recentDjLines: state.dj.speaking ? state.recentDjLines : state.recentDjLines };
      if (canHandoff(next)) {
        const ready = handoff(next);
        next = ready.state;
        commands = ready.commands;
      }
      break;
    }
    case "TRACK_STARTED": {
      if (state.nextTrack.trackId !== event.trackId) break;
      if (state.playback.trackId && state.playback.title) {
        next = { ...state, recentTracks: append(state.recentTracks, { trackId: state.playback.trackId, title: state.playback.title, description: state.playback.styleSummary ?? "", bpm: state.playback.bpm, key: state.playback.key, energy: state.playback.energy }, 12) };
      }
      next = {
        ...next,
        phase: "playing",
        playback: {
          trackId: event.trackId, title: event.spec.title, playheadMs: 0, durationMs: event.spec.durationMs, remainingMs: event.spec.durationMs,
          bpm: event.spec.bpm, key: event.spec.key, styleSummary: event.spec.description, energy: event.spec.energy, bufferedMs: state.nextTrack.bufferedMs
        },
        nextTrack: emptyNext(),
        transition: emptyTransition(),
        horizonFiredForTrackId: null,
        startup: undefined,
        pendingUser: state.pendingUser?.applied ? undefined : state.pendingUser,
        error: undefined
      };
      break;
    }
    case "TRACK_PROGRESS": {
      if (event.trackId !== state.playback.trackId) break;
      next = { ...state, playback: { ...state.playback, playheadMs: event.playheadMs, remainingMs: event.remainingMs, bufferedMs: event.bufferedMs } };
      if (state.nextTrack.status === "ready" && state.transition.status === "none" && event.remainingMs <= NORMAL_CROSSFADE_MS + 1_000) {
        const ready = handoff(next);
        next = ready.state;
        commands = ready.commands;
      } else if (["planning", "generating", "buffering"].includes(state.nextTrack.status) && event.remainingMs <= UNDERRUN_THREAT_MS && state.transition.status === "none") {
        const destination = state.nextTrack.spec ? {
          ...state.intent,
          description: state.nextTrack.spec.description,
          styles: state.nextTrack.spec.styles,
          mood: state.nextTrack.spec.mood,
          energy: state.nextTrack.spec.energy,
          bpmRange: [state.nextTrack.spec.bpm, state.nextTrack.spec.bpm] as [number, number]
        } : state.intent;
        const revision = state.nextTrack.revision ?? state.intentRevision;
        const spec = compileTransitionSpec(`underrun-${event.trackId}-${revision}`, revision, state, undefined, destination, "underrun");
        next = { ...next, transition: { status: "generating", transitionId: spec.id, revision, spec, bufferedMs: 0, generatedMs: 0 } };
        commands = [{ type: "GENERATE_TRANSITION", spec }];
      } else if (state.transition.status === "ready" && event.remainingMs <= UNDERRUN_THREAT_MS && state.transition.transitionId) {
        commands = [{ type: "PLAY_TRANSITION", transitionId: state.transition.transitionId, durationMs: NORMAL_CROSSFADE_MS, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }];
      }
      break;
    }
    case "TRACK_ENDED":
      if (event.trackId !== state.playback.trackId) break;
      if (state.transition.status === "ready" && state.transition.transitionId) commands = [{ type: "PLAY_TRANSITION", transitionId: state.transition.transitionId, durationMs: 250, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }];
      else if (state.nextTrack.status === "ready" && state.nextTrack.trackId) commands = [{ type: "PLAY_TRACK", trackId: state.nextTrack.trackId, durationMs: 250 }];
      else next = { ...state, phase: "error", error: "Playback ended before another playable stream was ready." };
      break;
  }

  return finish(next, event, commands);
}
