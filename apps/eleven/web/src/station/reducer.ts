import type {
  ContinuityInput,
  MusicalIntent,
  MusicalSnapshot,
  OnAirCuePurpose,
  ProducerPlan,
  ShowMemoryUpdates,
  ShowState,
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
} from "@robot-radio/eleven-shared";
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
export const SPEECH_BUFFER_GUARD_MS = 4_000;
export const HANDOFF_CUE_WINDOW_MS = 18_000;
export const MID_TRACK_CUE_EDGE_MS = 45_000;

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

export function compileTrackSpec(id: string, revision: number, directive: TrackDirective, intent: MusicalIntent, programmeId = id): TrackSpec {
  return {
    id,
    programmeId,
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
    sections: directive.sections,
    editorialNotes: directive.editorialNotes
  };
}

function planDirective(plan: ProducerPlan): TrackDirective {
  return {
    ...plan.musicalDirection.nextTrack,
    editorialNotes: [...new Set([
      ...(plan.musicalDirection.nextTrack.editorialNotes ?? []),
      ...plan.editorialNotes
    ])].slice(0, 8)
  };
}

function compileHorizonTrackSpec(id: string, revision: number, directive: TrackDirective, intent: MusicalIntent, programmeId: string): TrackSpec {
  const bpm = intent.bpmRange
    ? Math.min(intent.bpmRange[1], Math.max(intent.bpmRange[0], directive.bpm ?? midpoint(intent.bpmRange)!))
    : directive.bpm;
  return compileTrackSpec(id, revision, {
    ...directive,
    description: `${intent.description}. Arrangement variation: ${directive.description}`.slice(0, 800),
    styles: intent.styles,
    mood: intent.mood,
    energy: intent.energy ?? directive.energy,
    bpm,
    key: intent.keyPreference ?? directive.key,
    vocals: intent.vocals ?? directive.vocals,
    language: intent.language ?? directive.language
  }, intent, programmeId);
}

function compileTransitionSpec(
  id: string,
  revision: number,
  state: StationState,
  sketch: TransitionSketch | undefined,
  destination: MusicalIntent,
  reason: TransitionSpec["reason"],
  programmeId = id
): TransitionSpec {
  const direction = sketch?.energyDirection ?? "steady";
  const sourceEnergy = state.playback.energy ?? state.intent.energy ?? 0.55;
  const destinationEnergy = destination.energy ?? sourceEnergy;
  return {
    id,
    programmeId,
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
    showState: state.showState
  };
}

function continuityInput(state: StationState, requestId: string): ContinuityInput {
  return {
    requestId,
    currentIntent: state.intent,
    currentTrack: state.playback.trackId ? snapshot(state) : null,
    showState: state.showState
  };
}

function appendUnique(items: string[], additions: string[] | undefined, limit: number): string[] {
  const result = [...items];
  for (const raw of additions ?? []) {
    const value = raw.trim();
    if (!value) continue;
    const existing = result.findIndex((item) => item.toLowerCase() === value.toLowerCase());
    if (existing >= 0) result.splice(existing, 1);
    result.push(value);
  }
  return result.slice(-limit);
}

function productionFingerprint(directive: TrackDirective): string {
  return [
    directive.title,
    directive.description,
    ...(directive.styles ?? []),
    ...(directive.mood ?? []),
    directive.bpm ? `${Math.round(directive.bpm)} BPM` : "",
    directive.key ?? ""
  ].filter(Boolean).join("; ").slice(0, 300);
}

function applyShowMemory(
  showState: ShowState,
  updates: ShowMemoryUpdates,
  fallbackThesis: string,
  fallbackFingerprint?: string
): ShowState {
  const fingerprint = updates.productionFingerprint?.trim() || fallbackFingerprint;
  return {
    ...showState,
    listener: {
      preferences: appendUnique(showState.listener.preferences, updates.listener?.preferences, 8),
      dislikes: appendUnique(showState.listener.dislikes, updates.listener?.dislikes, 8),
      callbacks: appendUnique(showState.listener.callbacks, updates.listener?.callbacks, 6),
      notablePhrases: appendUnique(showState.listener.notablePhrases, updates.listener?.notablePhrases, 6)
    },
    musicalThesis: {
      current: updates.musicalThesis?.trim() || fallbackThesis,
      intendedTrajectory: updates.intendedTrajectory
        ? appendUnique([], updates.intendedTrajectory, 6)
        : showState.musicalThesis.intendedTrajectory
    },
    recentProductionFingerprints: appendUnique(
      showState.recentProductionFingerprints,
      fingerprint ? [fingerprint] : undefined,
      8
    ),
    speechCadence: {
      ...showState.speechCadence,
      sessionTalkativeness: updates.sessionTalkativeness ?? showState.speechCadence.sessionTalkativeness
    }
  };
}

function plannedCue(
  plan: ProducerPlan,
  speechId: string,
  revision: number,
  trackId?: string
): StationState["dj"]["pending"] {
  if (!plan.onAirCue) return undefined;
  return { speechId, text: plan.onAirCue.text, purpose: plan.onAirCue.purpose, revision, trackId };
}

function append<T>(items: T[], item: T, limit: number): T[] { return [...items, item].slice(-limit) }

function finish(state: StationState, event: StationEvent, commands: StationCommand[]): Reduction {
  const recentDjLines = commands.reduce(
    (lines, command) => command.type === "SPEAK" ? append(lines, command.text, 12) : lines,
    state.recentDjLines
  );
  const conversation = commands.reduce(
    (messages, command) => command.type === "SPEAK"
      ? append(messages, { role: "dj" as const, text: command.text, at: event.at }, 24)
      : messages,
    state.conversation
  );
  return {
    state: {
      ...state,
      recentDjLines,
      conversation,
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
  commands.push({ type: "FADE", from, to: "track", trackId, durationMs: NORMAL_CROSSFADE_MS });
  if (state.transition.transitionId) commands.push({ type: "CANCEL_TRANSITION", transitionId: state.transition.transitionId, afterMs: NORMAL_CROSSFADE_MS + 100 });
  return { state: { ...state, phase: "handoff" }, commands };
}

function pipelineMatches(state: StationState): boolean {
  return state.transition.revision === state.nextTrack.revision &&
    state.transition.spec?.programmeId === state.nextTrack.spec?.programmeId;
}

function canHandoff(state: StationState): boolean {
  return state.nextTrack.status === "ready" && Boolean(state.nextTrack.trackId) && !state.dj.speaking && !state.dj.pending &&
    state.transition.status === "audible" && state.transition.minimumPlayed === true && pipelineMatches(state);
}

function resolveUser(state: StationState): Reduction {
  const pending = state.pendingUser;
  if (!pending || pending.applied || !pending.urgency || !pending.plan) return { state, commands: [] };
  const { urgency, plan, requestId, revision } = pending;
  if (revision !== state.intentRevision) return { state: { ...state, pendingUser: undefined }, commands: [] };
  const direction = plan.musicalDirection;
  const directive = planDirective(plan);

  if (urgency.timing === "conversation_only") {
    return {
      state: {
        ...state,
        showState: applyShowMemory(state.showState, plan.memoryUpdates, state.showState.musicalThesis.current),
        dj: { ...state.dj, pending: plannedCue(plan, `cue-${requestId}`, revision) },
        pendingUser: { ...pending, applied: true, resolution: "conversation" }
      },
      commands: []
    };
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
        intent: direction.intent,
        showState: applyShowMemory(state.showState, plan.memoryUpdates, direction.intent.description, productionFingerprint(directive)),
        queuedDirective: directive,
        transition: state.transition.revision === revision ? emptyTransition() : state.transition,
        dj: { ...state.dj, pending: plannedCue(plan, `cue-${requestId}`, revision) },
        pendingUser: { ...pending, applied: true, resolution: "deferred" }
      },
      commands
    };
  }

  const trackSpec = compileTrackSpec(`${requestId}-track`, revision, directive, direction.intent, requestId);
  const commands: StationCommand[] = [];
  let transitionState = state.transition;
  if (state.nextTrack.trackId && state.nextTrack.trackId !== trackSpec.id) commands.push({ type: "CANCEL_TRACK", trackId: state.nextTrack.trackId });
  if (state.transition.revision !== revision || state.transition.status === "failed" || state.transition.status === "none") {
    const transition = compileTransitionSpec(`${requestId}-transition`, revision, state, urgency.immediateTransition, direction.intent, "immediate", requestId);
    if (state.transition.transitionId && state.transition.transitionId !== transition.id) commands.push({ type: "CANCEL_TRANSITION", transitionId: state.transition.transitionId });
    transitionState = { status: "generating", transitionId: transition.id, revision, spec: transition, bufferedMs: 0, generatedMs: 0 };
    commands.push({ type: "GENERATE_TRANSITION", spec: transition });
  }
  commands.push({ type: "GENERATE_TRACK", spec: trackSpec });
  return {
    state: {
      ...state,
      phase: "generating_next",
      intent: direction.intent,
      showState: applyShowMemory(state.showState, plan.memoryUpdates, direction.intent.description, productionFingerprint(directive)),
      nextTrack: { status: "generating", trackId: trackSpec.id, revision, spec: trackSpec, bufferedMs: 0, generatedMs: 0 },
      transition: transitionState,
      dj: { ...state.dj, pending: plannedCue(plan, `cue-${requestId}`, revision, trackSpec.id) },
      pendingUser: { ...pending, applied: true, resolution: urgency.timing === "immediate" ? "immediate" : "next" }
    },
    commands
  };
}

function beginTransitionFromUrgency(state: StationState, assessment: UrgencyAssessment): Reduction {
  const pending = state.pendingUser;
  if (!pending || assessment.timing !== "immediate") return { state, commands: [] };
  if (state.transition.revision === pending.revision && state.transition.status !== "none") return { state, commands: [] };
  const sketch = assessment.immediateTransition;
  const provisionalIntent: MusicalIntent = {
    ...state.intent,
    description: sketch?.destinationSketch ?? state.intent.description,
    energy: sketch?.energyDirection === "up" ? Math.min(1, (state.intent.energy ?? 0.55) + 0.15) :
      sketch?.energyDirection === "down" ? Math.max(0, (state.intent.energy ?? 0.55) - 0.15) : state.intent.energy
  };
  const spec = compileTransitionSpec(`${pending.requestId}-transition`, pending.revision, state, sketch, provisionalIntent, "immediate", pending.requestId);
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

function isRepairableTrackRejection(error: string): boolean {
  return /bad_prompt|bad_composition_plan|prompt_suggestion|composition_plan_suggestion/i.test(error);
}

function userCommittedTransition(state: StationState): boolean {
  const pending = state.pendingUser;
  return Boolean(
    pending?.applied &&
    pending.revision === state.transition.revision &&
    pending.requestId === state.transition.spec?.programmeId &&
    (pending.resolution === "immediate" || pending.resolution === "next")
  );
}

function scheduleDueHorizon(state: StationState): Reduction {
  const requestId = state.horizonRequestId;
  if (!requestId || state.horizonFiredForTrackId !== state.playback.trackId) return { state, commands: [] };
  if (state.pendingUser && !state.pendingUser.applied) return { state, commands: [] };
  const pipelineExists = state.nextTrack.status !== "none" || state.transition.status !== "none" || Boolean(state.continuityPlanRequestId);
  if (pipelineExists) return { state: { ...state, horizonRequestId: undefined }, commands: [] };

  if (state.queuedDirective) {
    const spec = compileTrackSpec(`${requestId}-queued`, state.intentRevision, state.queuedDirective, state.intent, requestId);
    return {
      state: {
        ...state,
        horizonRequestId: undefined,
        queuedDirective: undefined,
        phase: "generating_next",
        nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
      },
      commands: [{ type: "GENERATE_TRACK", spec }]
    };
  }

  return {
    state: {
      ...state,
      horizonRequestId: undefined,
      continuityPlanRequestId: requestId,
      phase: "generating_next",
      nextTrack: { status: "planning", revision: state.intentRevision, bufferedMs: 0, generatedMs: 0 }
    },
    commands: [{ type: "PLAN_CONTINUITY", input: continuityInput(state, requestId) }]
  };
}

type CueDecision = "wait" | "drop" | "speak";

function cueTalkativenessThreshold(purpose: OnAirCuePurpose): number {
  if (purpose === "opening" || purpose === "listener_acknowledgement") return 0.15;
  if (purpose === "back_announce") return 0.35;
  if (purpose === "tease") return 0.45;
  return 0.7;
}

function evaluateCueWindow(state: StationState): CueDecision {
  const cue = state.dj.pending;
  if (!cue) return "wait";
  const remainingMs = state.playback.remainingMs ?? Infinity;
  const playbackBuffered = state.playback.trackId !== null && state.playback.bufferedMs >= SPEECH_BUFFER_GUARD_MS;
  const transitionBuffered = state.transition.status === "audible" && state.transition.bufferedMs >= SPEECH_BUFFER_GUARD_MS;

  if (cue.purpose === "opening") {
    if (!state.playback.trackId) return "wait";
    if (state.playback.playheadMs > 30_000) return "drop";
    return playbackBuffered ? "speak" : "wait";
  }

  if (cue.purpose === "listener_acknowledgement") {
    const resolution = state.pendingUser?.resolution;
    if (!resolution) return "drop";
    if (resolution === "immediate" || resolution === "next") {
      if (state.transition.status === "failed" || remainingMs <= 0) return "drop";
      return transitionBuffered ? "speak" : "wait";
    }
    return state.transition.status === "none" && playbackBuffered ? "speak" : "wait";
  }

  if (cue.purpose === "back_announce" || cue.purpose === "tease") {
    if (state.nextTrack.status === "none" || state.nextTrack.status === "failed") return "drop";
    if (state.nextTrack.status !== "ready") return "wait";
    if (transitionBuffered || remainingMs <= HANDOFF_CUE_WINDOW_MS) return playbackBuffered || transitionBuffered ? "speak" : "wait";
    return "wait";
  }

  if (state.phase !== "playing" || state.transition.status !== "none") return "drop";
  if (state.playback.playheadMs < MID_TRACK_CUE_EDGE_MS) return "wait";
  if (remainingMs <= MID_TRACK_CUE_EDGE_MS) return "drop";
  return playbackBuffered ? "speak" : "wait";
}

function advanceCue(state: StationState, at: number): Reduction | null {
  const cue = state.dj.pending;
  if (!cue || state.dj.speaking) return null;
  const subjectIsCurrent = !cue.trackId || cue.trackId === state.nextTrack.trackId || cue.trackId === state.playback.trackId;
  if (cue.revision !== state.intentRevision || !subjectIsCurrent) {
    return { state: { ...state, dj: { ...state.dj, pending: undefined } }, commands: [] };
  }

  const cadence = state.showState.speechCadence;
  const cooldownActive = cadence.lastCueAt !== null && at - cadence.lastCueAt < cadence.cooldownMs;
  const tooQuiet = cadence.sessionTalkativeness < cueTalkativenessThreshold(cue.purpose);
  const repeatedObservation = cue.purpose === "mid_track_observation" && cadence.lastCuePurpose === "mid_track_observation";
  if (cooldownActive || tooQuiet || repeatedObservation) {
    return { state: { ...state, dj: { ...state.dj, pending: undefined } }, commands: [] };
  }

  const window = evaluateCueWindow(state);
  if (window === "wait") return null;
  if (window === "drop") return { state: { ...state, dj: { ...state.dj, pending: undefined } }, commands: [] };
  return {
    state: {
      ...state,
      showState: {
        ...state.showState,
        speechCadence: {
          ...cadence,
          lastCueAt: at,
          lastCuePurpose: cue.purpose,
          cuesSpoken: cadence.cuesSpoken + 1
        }
      },
      dj: { speaking: true, speechId: cue.speechId }
    },
    commands: [{ type: "SPEAK", speechId: cue.speechId, text: cue.text }]
  };
}

/**
 * The deterministic programme director. Events only update facts; this step decides
 * whether those facts now authorize speech, generation, or an audible handoff.
 */
function advanceProgramme(state: StationState, at: number): Reduction {
  if (!state.running) return { state, commands: [] };
  if (state.phase === "handoff") return { state, commands: [] };
  const remainingMs = state.playback.remainingMs ?? Infinity;

  if (!state.playback.trackId && state.nextTrack.status === "ready" && state.nextTrack.trackId) {
    return { state: { ...state, phase: "handoff" }, commands: [{ type: "PLAY_TRACK", trackId: state.nextTrack.trackId, durationMs: 500 }] };
  }

  if (state.transition.status === "ready" && state.transition.transitionId) {
    if (userCommittedTransition(state)) {
      return {
        state: { ...state, transition: { ...state.transition, status: "starting" } },
        commands: [{ type: "PLAY_TRANSITION", transitionId: state.transition.transitionId, durationMs: IMMEDIATE_CROSSFADE_MS, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }]
      };
    }
    if (remainingMs <= UNDERRUN_THREAT_MS) {
      return {
        state: { ...state, transition: { ...state.transition, status: "starting" } },
        commands: [{ type: "PLAY_TRANSITION", transitionId: state.transition.transitionId, durationMs: remainingMs <= 0 ? 250 : NORMAL_CROSSFADE_MS, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }]
      };
    }
  }

  if (remainingMs <= 0 && state.transition.status !== "audible" && state.transition.status !== "starting") {
    if (state.nextTrack.status === "ready" && state.nextTrack.trackId) {
      return { state: { ...state, phase: "handoff" }, commands: [{ type: "PLAY_TRACK", trackId: state.nextTrack.trackId, durationMs: 250 }] };
    }
    return { state: { ...state, phase: "error", error: "Playback ended before another playable stream was ready." }, commands: [] };
  }

  const cue = advanceCue(state, at);
  if (cue) return cue;

  if (canHandoff(state)) return handoff(state);

  if (state.nextTrack.status === "ready" && state.transition.status === "failed" && state.pendingUser?.resolution === "immediate" && pipelineMatches(state)) {
    return handoff(state);
  }

  if (state.nextTrack.status === "ready" && state.transition.status === "none" && remainingMs <= NORMAL_CROSSFADE_MS + 1_000) {
    return handoff(state);
  }

  if (["planning", "generating", "buffering"].includes(state.nextTrack.status) && remainingMs <= UNDERRUN_THREAT_MS && state.transition.status === "none") {
    const destination = state.nextTrack.spec ? {
      ...state.intent,
      description: state.nextTrack.spec.description,
      styles: state.nextTrack.spec.styles,
      mood: state.nextTrack.spec.mood,
      energy: state.nextTrack.spec.energy,
      bpmRange: [state.nextTrack.spec.bpm, state.nextTrack.spec.bpm] as [number, number]
    } : state.intent;
    const revision = state.nextTrack.revision ?? state.intentRevision;
    const programmeId = state.nextTrack.spec?.programmeId ?? `underrun-${state.playback.trackId}-${revision}`;
    const spec = compileTransitionSpec(`underrun-${state.playback.trackId}-${revision}`, revision, state, undefined, destination, "underrun", programmeId);
    return {
      state: { ...state, transition: { status: "generating", transitionId: spec.id, revision, spec, bufferedMs: 0, generatedMs: 0 } },
      commands: [{ type: "GENERATE_TRANSITION", spec }]
    };
  }

  return scheduleDueHorizon(state);
}

export function reduce(state: StationState, event: StationEvent): Reduction {
  let next = state;
  let commands: StationCommand[] = [];

  switch (event.type) {
    case "START_STATION": {
      const fresh = createInitialState();
      next = {
        ...fresh,
        running: true,
        intentRevision: 1,
        startup: { requestId: event.sessionId, message: event.message, status: "planning" },
        recentUserMessages: [event.message],
        conversation: [{ role: "listener", text: event.message, at: event.at }]
      };
      commands = [{ type: "PLAN_INITIAL_INTENT", input: { requestId: event.sessionId, message: event.message, showState: fresh.showState } }];
      break;
    }
    case "STOP_STATION":
      next = createInitialState();
      commands = [{ type: "STOP_ALL" }];
      break;
    case "INITIAL_INTENT_RECEIVED": {
      if (state.startup?.requestId !== event.requestId) break;
      const direction = event.plan.musicalDirection;
      const spec = compileTrackSpec(`${event.requestId}-opening`, state.intentRevision, planDirective(event.plan), direction.intent, event.requestId);
      next = {
        ...state,
        phase: "generating_next",
        intent: direction.intent,
        showState: applyShowMemory(
          state.showState,
          event.plan.memoryUpdates,
          direction.intent.description,
          productionFingerprint(planDirective(event.plan))
        ),
        dj: { ...state.dj, pending: plannedCue(event.plan, `cue-${event.requestId}`, state.intentRevision, spec.id) },
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
      const interruptedHorizonPlan = state.nextTrack.status === "planning" && Boolean(state.continuityPlanRequestId);
      next = {
        ...state,
        intentRevision: revision,
        nextTrack: interruptedHorizonPlan ? emptyNext() : state.nextTrack,
        continuityPlanRequestId: interruptedHorizonPlan ? undefined : state.continuityPlanRequestId,
        horizonRequestId: interruptedHorizonPlan ? state.continuityPlanRequestId : state.horizonRequestId,
        dj: { ...state.dj, pending: undefined },
        pendingUser: { requestId: event.requestId, revision, message: event.message, applied: false },
        recentUserMessages: append(state.recentUserMessages, event.message, 12),
        conversation: append(state.conversation, { role: "listener", text: event.message, at: event.at }, 24)
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
      const resolved = resolveUser(next);
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
      const resolved = resolveUser(next);
      next = resolved.state;
      commands = resolved.commands;
      break;
    }
    case "USER_PLAN_FAILED":
      if (state.pendingUser?.requestId === event.requestId) next = { ...state, pendingUser: undefined, error: event.error };
      break;
    case "NEXT_TRACK_HORIZON": {
      if (event.trackId !== state.playback.trackId || state.horizonFiredForTrackId === event.trackId) break;
      next = { ...state, horizonFiredForTrackId: event.trackId, horizonRequestId: event.requestId };
      break;
    }
    case "CONTINUITY_PLAN_RECEIVED": {
      if (state.continuityPlanRequestId !== event.requestId) break;
      const spec = compileHorizonTrackSpec(`${event.requestId}-track`, state.intentRevision, planDirective(event.plan), state.intent, event.requestId);
      next = {
        ...state, continuityPlanRequestId: undefined,
        showState: applyShowMemory(
          state.showState,
          event.plan.memoryUpdates,
          state.showState.musicalThesis.current,
          productionFingerprint(planDirective(event.plan))
        ),
        dj: { ...state.dj, pending: plannedCue(event.plan, `cue-${event.requestId}`, state.intentRevision, spec.id) },
        nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
      };
      commands = [{ type: "GENERATE_TRACK", spec }];
      break;
    }
    case "CONTINUITY_PLAN_FAILED":
      if (state.continuityPlanRequestId === event.requestId) next = { ...state, phase: "error", error: event.error };
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
    case "TRACK_LYRIC_TIMESTAMPS_RECEIVED":
      if (state.playback.trackId === event.trackId) next = { ...state, playback: { ...state.playback, wordTimestamps: event.wordTimestamps } };
      break;
    case "TRACK_READY": {
      if (!eventMatchesNext(state, event.trackId, event.revision)) break;
      next = { ...state, nextTrack: { ...state.nextTrack, status: "ready" } };
      break;
    }
    case "TRACK_GENERATION_FAILED": {
      if (!eventMatchesNext(state, event.trackId, event.revision) || !state.nextTrack.spec) break;
      if (!isRepairableTrackRejection(event.error)) {
        next = { ...state, nextTrack: { ...state.nextTrack, status: "failed", error: event.error }, error: event.error };
        break;
      }
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
      const spec = compileTrackSpec(`${event.failedTrackId}-r${event.attempt}`, state.nextTrack.spec.revision, event.plan.track, state.intent, state.nextTrack.spec.programmeId);
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
        const status = state.transition.status === "audible" ? "audible" : state.transition.status === "starting" ? "starting" : state.transition.status === "ready" ? "ready" : "buffering";
        next = { ...state, transition: { ...state.transition, status, bufferedMs: event.bufferedMs, generatedMs: event.generatedMs, generationRate: event.generationRate } };
      }
      break;
    case "TRANSITION_READY":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        const status = state.transition.status === "starting" || state.transition.status === "audible" ? state.transition.status : "ready";
        next = { ...state, transition: { ...state.transition, status } };
      }
      break;
    case "TRANSITION_GENERATION_FAILED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) next = { ...state, transition: { ...state.transition, status: "failed", error: event.error }, error: event.error };
      break;
    case "TRANSITION_STARTED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        next = { ...state, phase: "transition", transition: { ...state.transition, status: "audible", startedAt: event.at, minimumPlayed: false } };
      }
      break;
    case "TRANSITION_MINIMUM_PLAYED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        next = { ...state, transition: { ...state.transition, minimumPlayed: true } };
      }
      break;
    case "TRANSITION_ENDED":
      if (eventMatchesTransition(state, event.transitionId, event.revision)) {
        if (state.nextTrack.status === "ready" && pipelineMatches(state)) {
          const ready = handoff({ ...state, transition: { ...state.transition, minimumPlayed: true } });
          next = ready.state;
          commands = ready.commands;
        } else next = { ...state, phase: "error", error: "The transition ended before replacement music was ready." };
      }
      break;
    case "TTS_STARTED":
      if (state.dj.speechId && state.dj.speechId !== event.speechId) break;
      next = { ...state, dj: { ...state.dj, speaking: true, speechId: event.speechId } };
      break;
    case "TTS_FINISHED":
      if (state.dj.speechId !== event.speechId) break;
      next = { ...state, dj: { ...state.dj, speaking: false, speechId: undefined } };
      break;
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
          bpm: event.spec.bpm, key: event.spec.key, styleSummary: event.spec.description, energy: event.spec.energy,
          styles: event.spec.styles, mood: event.spec.mood, vocals: event.spec.vocals, sections: event.spec.sections,
          bufferedMs: state.nextTrack.bufferedMs
        },
        nextTrack: emptyNext(),
        transition: emptyTransition(),
        horizonFiredForTrackId: null,
        horizonRequestId: undefined,
        continuityPlanRequestId: undefined,
        startup: undefined,
        pendingUser: state.pendingUser?.applied ? undefined : state.pendingUser,
        error: undefined
      };
      break;
    }
    case "TRACK_PROGRESS": {
      if (event.trackId !== state.playback.trackId) break;
      next = { ...state, playback: { ...state.playback, playheadMs: event.playheadMs, remainingMs: event.remainingMs, bufferedMs: event.bufferedMs } };
      break;
    }
    case "TRACK_ENDED":
      if (event.trackId !== state.playback.trackId) break;
      next = { ...state, playback: { ...state.playback, remainingMs: 0, bufferedMs: 0 } };
      break;
  }

  const advanced = advanceProgramme(next, event.at);
  return finish(advanced.state, event, [...commands, ...advanced.commands]);
}
