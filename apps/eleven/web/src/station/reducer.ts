import type {
  ContinuityInput,
  MusicalIntent,
  MusicalSnapshot,
  OnAirCuePurpose,
  ProducerPlan,
  ShowMemoryUpdates,
  ShowState,
  SpeechPlacement,
  StationCommand,
  StationElementSpec,
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
import { selectAutonomyMode, shouldAuthorizeAutonomousCue } from "@robot-radio/eleven-shared";
import { createInitialState } from "./state";
import { buildTrackPresentationMap } from "./presentation-map";

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
export const MID_TRACK_CUE_EDGE_MS = 45_000;
export const SPEECH_WINDOW_TAIL_MS = 420;
export const SPEECH_WINDOW_LEAD_MS = 180;
export const MAX_PREPARED_SPEECH_WAIT_MS = 30_000;
export const CART_REPEAT_COOLDOWN_MS = 12 * 60_000;
export const OPENING_IMAGING_DURATION_MS = 30_000;

export interface Reduction { state: StationState; commands: StationCommand[] }

function midpoint(range?: [number, number]): number | undefined {
  return range ? Math.round((range[0] + range[1]) / 2) : undefined;
}

function snapshot(state: StationState): MusicalSnapshot {
  const sectionFacts = (state.playback.sections ?? []).slice(0, 5).map((section) => {
    const lyric = section.lyrics?.split("\n").map((line) => line.trim()).find(Boolean);
    return `${section.name}: ${section.description}${lyric ? `; lyric “${lyric}”` : ""}`.slice(0, 300);
  });
  return {
    title: state.playback.title ?? undefined,
    styleSummary: state.playback.styleSummary ?? state.intent.description,
    bpm: state.playback.bpm ?? midpoint(state.intent.bpmRange),
    key: state.playback.key ?? state.intent.keyPreference,
    energy: state.playback.energy ?? state.intent.energy,
    presentationFacts: [...(state.playback.editorialNotes ?? []), ...sectionFacts].slice(0, 8)
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

function compileOpeningImagingSpec(sessionId: string, revision: number, presenterName: string): TrackSpec {
  return {
    id: `${sessionId}-opening-imaging`,
    programmeId: sessionId,
    revision,
    role: "opening_imaging",
    title: presenterName,
    description: "A freshly generated thirty-second radio cold open: one bold station ident, then vivid future-facing instrumental continuity with a clean broadcast handoff.",
    styles: ["future radio opening imaging", "electro-punk broadcast ident", "bold synthetic continuity", "tight modern station sound"],
    mood: ["immediate", "electric", "welcoming", "confident"],
    energy: 0.78,
    bpm: 124,
    key: "C major",
    vocals: "One stylised sung or spoken station ident in the opening section; no further words after it.",
    language: "English",
    durationMs: OPENING_IMAGING_DURATION_MS,
    sections: [
      {
        name: "Fresh station ident",
        durationMs: 5_000,
        description: `Open immediately over the music with exactly the station name “${presenterName}”. The delivery may be sung, spoken, harmonised, chopped or stylised, but add no other words.`,
        lyrics: presenterName,
        transitionFriendly: false
      },
      {
        name: "Instrumental opening continuity",
        durationMs: 19_000,
        description: "Continue as a concise, fully instrumental piece of bold modern radio imaging. Develop one memorable synthetic motif with tight drums and clear movement; do not imply any particular listener-requested genre.",
        transitionFriendly: true
      },
      {
        name: "Instrumental handoff",
        durationMs: 6_000,
        description: "Remove vocal material completely, simplify to a stable rhythmic and harmonic bed, then resolve with a precise clean broadcast handoff. No fade, spoken tag or long reverb tail.",
        transitionFriendly: true
      }
    ],
    editorialNotes: [
      `Use exactly the words “${presenterName}” once during the first five seconds and no other words anywhere in the composition.`,
      "Make the ident and music feel like one authored piece rather than a voice pasted over a backing track.",
      "Keep the continuity format-neutral: this is station imaging, not an interpretation of the listener request.",
      "Reserve the final six seconds as an exposed, vocal-free handoff with a clean ending and no fade."
    ]
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

function compileStationElements(sessionId: string, revision: number, presenterName: string): StationElementSpec[] {
  const dryId = `cart-${sessionId}-dry-id`;
  const wetSting = `cart-${sessionId}-wet-sting`;
  return [
    {
      id: dryId,
      kind: "id",
      mixType: "dry",
      title: `${presenterName} dry ID`,
      durationMs: 3_000,
      allowedPlacements: ["over_music", "clean_bed", "cold_open"],
      track: compileTrackSpec(dryId, revision, {
        title: `${presenterName} dry ID`,
        description: `A reusable, completely dry spoken station ident saying only “${presenterName}”. No music or effects.`,
        styles: ["dry station ID", "professional radio ident", "transparent background", "tight broadcast compression"],
        mood: ["confident", "concise"],
        energy: 0.58,
        bpm: 100,
        key: "C major",
        vocals: "dry professional spoken radio voice, saying only the supplied station name",
        language: "English",
        durationMs: 3_000,
        sections: [{
          name: "Dry station ID",
          durationMs: 3_000,
          description: "Isolated voice, exact clean start and stop, no music, melody, ambience, reverb, or effects.",
          lyrics: presenterName,
          transitionFriendly: true
        }]
      }, {
        description: "dry station ID",
        styles: ["dry station ID"],
        mood: ["confident"],
        energy: 0.58,
        bpmRange: [100, 100],
        keyPreference: "C major",
        vocals: "dry spoken voice"
      }, sessionId)
    },
    {
      id: wetSting,
      kind: "sting",
      mixType: "wet",
      title: `${presenterName} wet sting`,
      durationMs: 5_000,
      allowedPlacements: ["transition_gap", "exposed_handoff", "cold_open"],
      track: compileTrackSpec(wetSting, revision, {
        title: `${presenterName} wet sting`,
        description: "A reusable five-second instrumental sonic logo: three rising synthetic notes and one bold drum punctuation with an exact clean stop.",
        styles: ["instrumental station sting", "modern radio imaging", "bright synthetic print-colour energy", "wide polished mix"],
        mood: ["bold", "electric"],
        energy: 0.8,
        bpm: 120,
        key: "C major",
        vocals: "instrumental, no vocals",
        durationMs: 5_000,
        sections: [{
          name: "Station sting",
          durationMs: 5_000,
          description: "Three-note original sonic logo, one drum punctuation, no voice, no fade or reverb tail.",
          transitionFriendly: true
        }]
      }, {
        description: "instrumental station sting",
        styles: ["modern radio imaging"],
        mood: ["bold"],
        energy: 0.8,
        bpmRange: [120, 120],
        keyPreference: "C major",
        vocals: "instrumental"
      }, sessionId)
    }
  ];
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

function boundedTransitionText(value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length <= maximum) return normalized;
  const clipped = normalized.slice(0, maximum - 1);
  const boundary = clipped.lastIndexOf(" ");
  const end = boundary >= maximum * 0.65 ? boundary : clipped.length;
  return `${clipped.slice(0, end).trimEnd()}…`;
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
  const sourceSummary = sketch?.sourceSummary ?? snapshot(state).styleSummary;
  const destinationSummary = sketch?.destinationSketch ?? destination.description;
  return {
    id,
    programmeId,
    revision,
    description: boundedTransitionText(sketch?.description ?? `An instrumental radio bridge that naturally moves from ${sourceSummary} toward ${destinationSummary}.`, 800),
    sourceSummary: boundedTransitionText(sourceSummary, 500),
    destinationSummary: boundedTransitionText(destinationSummary, 500),
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

function continuityInput(state: StationState, requestId: string, at: number): ContinuityInput {
  const silenceMs = state.autonomy.lastListenerAt === null ? 0 : Math.max(0, at - state.autonomy.lastListenerAt);
  const speechSilenceMs = state.showState.speechCadence.lastCueAt === null
    ? null
    : Math.max(0, at - state.showState.speechCadence.lastCueAt);
  return {
    requestId,
    currentIntent: state.intent,
    currentTrack: state.playback.trackId ? snapshot(state) : null,
    showState: state.showState,
    autonomy: { mode: state.autonomy.mode, tracksSinceListener: state.autonomy.tracksSinceListener, silenceMs, speechSilenceMs }
  };
}

function autonomyAt(state: StationState, at: number): StationState["autonomy"] {
  const silenceMs = state.autonomy.lastListenerAt === null ? 0 : Math.max(0, at - state.autonomy.lastListenerAt);
  const mode = selectAutonomyMode({ tracksSinceListener: state.autonomy.tracksSinceListener, silenceMs });
  return { ...state.autonomy, mode };
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
  // The deterministic fingerprint contains the title as well as the production
  // shape. Prefer it when a concrete directive exists so the model cannot lose
  // title-separation memory by returning a title-free semantic fingerprint.
  const fingerprint = fallbackFingerprint?.trim() || updates.productionFingerprint?.trim();
  const withListenerMemory = applyListenerMemory(showState, updates);
  return {
    ...withListenerMemory,
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
    )
  };
}

function applyListenerMemory(showState: ShowState, updates: ShowMemoryUpdates): ShowState {
  return {
    ...showState,
    listener: {
      preferences: appendUnique(showState.listener.preferences, updates.listener?.preferences, 8),
      dislikes: appendUnique(showState.listener.dislikes, updates.listener?.dislikes, 8),
      callbacks: appendUnique(showState.listener.callbacks, updates.listener?.callbacks, 6),
      notablePhrases: appendUnique(showState.listener.notablePhrases, updates.listener?.notablePhrases, 6)
    },
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
  trackId?: string,
  timing: ProducerPlan["suggestedTiming"] = plan.suggestedTiming
): StationState["dj"]["pending"] {
  if (!plan.onAirCue) return undefined;
  const purpose = plan.onAirCue.purpose;
  const placement: SpeechPlacement = purpose === "opening" ? "opening_intro"
    : purpose === "back_announce" || purpose === "handoff_setup" ? "handoff"
    : purpose === "mid_track_observation" ? "mid_track"
    : timing === "immediate" ? "immediate_transition"
    : timing === "next_track" ? "handoff"
    : "clean_bed";
  return {
    speechId,
    text: plan.onAirCue.text,
    purpose,
    placement,
    revision,
    trackId,
    linkFingerprint: plan.onAirCue.linkFingerprint ?? `${plan.onAirCue.purpose}: direct concise link`
  };
}

function append<T>(items: T[], item: T, limit: number): T[] { return [...items, item].slice(-limit) }

function finish(state: StationState, event: StationEvent, commands: StationCommand[]): Reduction {
  return {
    state: {
      ...state,
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
  return state.nextTrack.status === "ready" && Boolean(state.nextTrack.trackId) && !state.dj.speaking && !state.dj.pending && !state.dj.prepared && !state.carts.playingId &&
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
        showState: applyListenerMemory(state.showState, plan.memoryUpdates),
        dj: { ...state.dj, pending: plannedCue(plan, `cue-${requestId}`, revision, undefined, urgency.timing) },
        pendingUser: { ...pending, applied: true, resolution: "conversation" }
      },
      commands: []
    };
  }

  const nearHorizon = pending.nearHorizonAtRequest ?? (
    (state.playback.remainingMs ?? Infinity) <= NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS || state.nextTrack.status !== "none"
  );
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
        dj: { ...state.dj, pending: plannedCue(plan, `cue-${requestId}`, revision, undefined, urgency.timing) },
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
      dj: { ...state.dj, pending: plannedCue(plan, `cue-${requestId}`, revision, trackSpec.id, urgency.timing) },
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
function eventMatchesOpeningImaging(state: StationState, trackId: string, revision: number): boolean {
  return state.openingImaging.trackId === trackId && state.openingImaging.revision === revision;
}
function eventMatchesTransition(state: StationState, transitionId: string, revision: number): boolean {
  return state.transition.transitionId === transitionId && state.transition.revision === revision;
}

function isRepairableTrackRejection(error: string): boolean {
  return /bad_prompt|bad_composition_plan|prompt_suggestion|composition_plan_suggestion/i.test(error);
}

function isProviderAllowanceExhausted(error: string): boolean {
  return /used its current ElevenLabs allowance|insufficient_credits|quota_exceeded/i.test(error);
}

function userCommittedTransition(state: StationState): boolean {
  const pending = state.pendingUser;
  return Boolean(
    pending?.applied &&
    pending.revision === state.transition.revision &&
    pending.requestId === state.transition.spec?.programmeId &&
    pending.resolution === "immediate"
  );
}

function userCommittedNextTransition(state: StationState): boolean {
  const pending = state.pendingUser;
  return Boolean(
    pending?.applied &&
    pending.revision === state.transition.revision &&
    pending.requestId === state.transition.spec?.programmeId &&
    pending.resolution === "next"
  );
}

function naturalTransitionDue(state: StationState, remainingMs: number): boolean {
  const ending = state.playback.presentationMap?.endStyle ?? "unknown";
  return ending === "cold" || ending === "resolved"
    ? remainingMs <= 0
    : remainingMs <= NORMAL_CROSSFADE_MS + 1_000;
}

function attachHandoffCueToTrack(dj: StationState["dj"], trackId: string): StationState["dj"] {
  const attach = <T extends StationState["dj"]["pending"] | StationState["dj"]["prepared"]>(cue: T): T => {
    if (!cue || cue.trackId || cue.placement !== "handoff") return cue;
    return { ...cue, trackId } as T;
  };
  return { ...dj, pending: attach(dj.pending), prepared: attach(dj.prepared) };
}

function scheduleDueHorizon(state: StationState, at: number): Reduction {
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
        dj: attachHandoffCueToTrack(state.dj, spec.id),
        nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
      },
      commands: [{ type: "GENERATE_TRACK", spec }]
    };
  }

  const autonomy = autonomyAt(state, at);
  const planningState = { ...state, autonomy };
  return {
    state: {
      ...planningState,
      horizonRequestId: undefined,
      continuityPlanRequestId: requestId,
      phase: "generating_next",
      nextTrack: { status: "planning", revision: state.intentRevision, bufferedMs: 0, generatedMs: 0 }
    },
    commands: [{ type: "PLAN_CONTINUITY", input: continuityInput(planningState, requestId, at) }]
  };
}

type CueDecision = "wait" | "drop" | "play";

function cueTalkativenessThreshold(purpose: OnAirCuePurpose): number {
  if (purpose === "opening" || purpose === "listener_acknowledgement") return 0.15;
  if (purpose === "back_announce") return 0.35;
  if (purpose === "handoff_setup") return 0.45;
  return 0.7;
}

function rememberLink(showState: ShowState, fingerprint: string): ShowState {
  return { ...showState, recentLinkFingerprints: appendUnique(showState.recentLinkFingerprints, [fingerprint], 8) };
}

function publishCueText(state: StationState, at: number): StationState {
  const cue = state.dj.pending;
  if (!cue || cue.textPublished) return state;
  const fingerprint = cue.linkFingerprint ?? `${cue.purpose}: direct concise link`;
  return {
    ...state,
    showState: rememberLink(state.showState, fingerprint),
    recentDjLines: append(state.recentDjLines, cue.text, 12),
    conversation: append(state.conversation, { role: "dj", text: cue.text, at }, 24),
    dj: { ...state.dj, pending: { ...cue, linkFingerprint: fingerprint, textPublished: true } }
  };
}

function preparedSpeechDecision(state: StationState, at: number): CueDecision {
  const cue = state.dj.prepared;
  if (!cue || cue.status !== "ready" || cue.durationMs === undefined) return "wait";
  const remainingMs = state.playback.remainingMs ?? Infinity;
  const neededMs = cue.durationMs + SPEECH_BUFFER_GUARD_MS;
  const playbackBuffered = state.playback.trackId !== null && state.playback.bufferedMs >= neededMs;
  const transitionBuffered = state.transition.status === "audible" && state.transition.bufferedMs >= neededMs;
  const waitedMs = Math.max(0, at - (cue.readyAt ?? at));

  if (cue.revision !== state.intentRevision) return "drop";
  const subjectIsCurrent = !cue.trackId || cue.trackId === state.nextTrack.trackId || cue.trackId === state.playback.trackId;
  if (!subjectIsCurrent) return "drop";
  const placement = cue.placement ?? (cue.purpose === "opening" ? "opening_intro"
    : cue.purpose === "back_announce" || cue.purpose === "handoff_setup" ? "handoff"
    : cue.purpose === "mid_track_observation" ? "mid_track"
    : "clean_bed");
  const cueTargetsPlayback = Boolean(cue.trackId && state.playback.trackId === cue.trackId);

  if (placement === "immediate_transition") {
    if (state.transition.status === "failed" || remainingMs <= 0) return "drop";
    return transitionBuffered ? "play" : waitedMs >= MAX_PREPARED_SPEECH_WAIT_MS ? "drop" : "wait";
  }

  if (placement === "opening_intro" && cue.trackId && state.playback.trackId !== cue.trackId) return "wait";

  if (placement === "handoff") {
    if (transitionBuffered) return "play";
    if (!cueTargetsPlayback && state.nextTrack.status !== "ready") return state.nextTrack.status === "failed" ? "drop" : "wait";
  }

  const allowedKinds = placement === "opening_intro" ? ["intro"]
    : placement === "handoff" && cue.trackId === state.playback.trackId ? ["intro"]
    : placement === "handoff" ? ["outro"]
    : placement === "mid_track" ? ["instrumental"]
    : ["intro", "instrumental", "outro"];
  const window = state.playback.presentationMap?.safeMicWindows.find((candidate) => {
    if (!allowedKinds.includes(candidate.kind)) return false;
    const effectiveStart = placement === "mid_track" ? Math.max(candidate.startMs, MID_TRACK_CUE_EDGE_MS) : candidate.startMs;
    const effectiveEnd = placement === "mid_track"
      ? Math.min(candidate.endMs, (state.playback.durationMs ?? candidate.endMs) - MID_TRACK_CUE_EDGE_MS)
      : candidate.endMs;
    const latestStart = effectiveEnd - cue.durationMs! - SPEECH_WINDOW_TAIL_MS;
    if (latestStart < effectiveStart) return false;
    return state.playback.playheadMs <= latestStart + SPEECH_WINDOW_LEAD_MS;
  });
  if (!window) {
    if ((placement === "opening_intro" || (placement === "handoff" && cueTargetsPlayback)) && state.playback.playheadMs > 30_000) return "drop";
    if (placement === "handoff" || placement === "opening_intro") return "wait";
    return waitedMs >= MAX_PREPARED_SPEECH_WAIT_MS || remainingMs <= cue.durationMs + SPEECH_WINDOW_TAIL_MS ? "drop" : "wait";
  }
  const effectiveStart = placement === "mid_track" ? Math.max(window.startMs, MID_TRACK_CUE_EDGE_MS) : window.startMs;
  const effectiveEnd = placement === "mid_track"
    ? Math.min(window.endMs, (state.playback.durationMs ?? window.endMs) - MID_TRACK_CUE_EDGE_MS)
    : window.endMs;
  const target = placement === "handoff" || placement === "opening_intro"
    ? Math.max(effectiveStart, effectiveEnd - cue.durationMs - SPEECH_WINDOW_TAIL_MS)
    : effectiveStart;
  return playbackBuffered && state.playback.playheadMs + SPEECH_WINDOW_LEAD_MS >= target ? "play" : "wait";
}

function prepareCue(state: StationState, at: number): Reduction | null {
  const published = publishCueText(state, at);
  const cue = published.dj.pending;
  if (!cue) return null;
  if (published.dj.speaking || published.dj.prepared) {
    return published === state ? null : { state: published, commands: [] };
  }
  const subjectIsCurrent = !cue.trackId || cue.trackId === state.nextTrack.trackId || cue.trackId === state.playback.trackId;
  if (cue.revision !== state.intentRevision || !subjectIsCurrent) {
    return { state: { ...published, dj: { ...published.dj, pending: undefined } }, commands: [] };
  }
  if (published.dj.muted) {
    return {
      state: { ...published, dj: { ...published.dj, pending: undefined } },
      commands: []
    };
  }

  const cadence = published.showState.speechCadence;
  const cooldownActive = cadence.lastCueAt !== null && at - cadence.lastCueAt < cadence.cooldownMs;
  const tooQuiet = cadence.sessionTalkativeness < cueTalkativenessThreshold(cue.purpose);
  const repeatedObservation = cue.purpose === "mid_track_observation" && cadence.lastCuePurpose === "mid_track_observation";
  if (cooldownActive || tooQuiet || repeatedObservation) {
    return { state: { ...published, dj: { ...published.dj, pending: undefined } }, commands: [] };
  }

  return {
    state: {
      ...published,
      dj: {
        ...published.dj,
        pending: undefined,
        prepared: { ...cue, linkFingerprint: cue.linkFingerprint ?? `${cue.purpose}: direct concise link`, status: "preparing" }
      }
    },
    commands: [{ type: "PREPARE_SPEECH", speechId: cue.speechId, text: cue.text }]
  };
}

function advancePreparedSpeech(state: StationState, at: number): Reduction | null {
  const prepared = state.dj.prepared;
  if (!prepared || prepared.status !== "ready" || state.dj.speaking) return null;
  const decision = preparedSpeechDecision(state, at);
  if (decision === "wait") return null;
  if (decision === "drop") {
    return { state: { ...state, dj: { ...state.dj, prepared: undefined } }, commands: [{ type: "CANCEL_SPEECH", speechId: prepared.speechId }] };
  }
  const cadence = state.showState.speechCadence;
  return {
    state: {
      ...state,
      showState: {
        ...state.showState,
        speechCadence: {
          ...cadence,
          lastCueAt: at,
          lastCuePurpose: prepared.purpose,
          cuesSpoken: cadence.cuesSpoken + 1
        }
      },
      dj: {
        ...state.dj,
        speaking: true,
        speechId: prepared.speechId,
        prepared: { ...prepared, status: "playing" }
      }
    },
    commands: [{ type: "PLAY_SPEECH", speechId: prepared.speechId }]
  };
}

function advanceCart(state: StationState, at: number): Reduction | null {
  if (state.dj.muted || state.autonomy.mode === "interactive" || state.carts.playingId || state.dj.pending || state.dj.prepared || state.dj.speaking) return null;
  const cart = state.carts.entries.find((entry) =>
    entry.status === "ready" &&
    entry.kind === "id" &&
    entry.mixType === "dry" &&
    (entry.lastUsedAt === undefined || at - entry.lastUsedAt >= CART_REPEAT_COOLDOWN_MS)
  );
  if (!cart || state.playback.trackId === null || state.playback.bufferedMs < cart.durationMs + SPEECH_BUFFER_GUARD_MS) return null;
  const playheadMs = state.playback.playheadMs;
  const window = state.playback.presentationMap?.safeMicWindows.find((candidate) => {
    if (!cart.allowedPlacements.includes("over_music") || !["intro", "instrumental", "vocal_gap"].includes(candidate.kind)) return false;
    return playheadMs >= candidate.startMs && playheadMs + cart.durationMs + SPEECH_WINDOW_TAIL_MS <= candidate.endMs;
  });
  if (!window) return null;
  return {
    state: {
      ...state,
      carts: {
        entries: state.carts.entries.map((entry) => entry.id === cart.id
          ? { ...entry, useCount: entry.useCount + 1, lastUsedAt: at }
          : entry),
        playingId: cart.id
      }
    },
    commands: [{ type: "PLAY_CART", cartId: cart.id }]
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

  if (!state.playback.trackId && state.openingImaging.status === "ready" && state.openingImaging.trackId) {
    return { state: { ...state, phase: "handoff" }, commands: [{ type: "PLAY_TRACK", trackId: state.openingImaging.trackId, durationMs: 250 }] };
  }

  if (!state.playback.trackId && state.openingImaging.status === "failed" && state.nextTrack.status === "ready" && state.nextTrack.trackId) {
    return { state: { ...state, phase: "handoff" }, commands: [{ type: "PLAY_TRACK", trackId: state.nextTrack.trackId, durationMs: 500 }] };
  }

  if (state.playback.role === "opening_imaging" && state.nextTrack.status === "ready" && state.nextTrack.trackId && !state.dj.speaking) {
    const outro = state.playback.presentationMap?.safeMicWindows.find((window) => window.kind === "outro");
    const atHandoff = outro
      ? state.playback.playheadMs + SPEECH_WINDOW_LEAD_MS >= Math.max(outro.startMs, outro.endMs - NORMAL_CROSSFADE_MS)
      : remainingMs <= NORMAL_CROSSFADE_MS + 1_000;
    if (atHandoff) return handoff(state);
  }

  if (state.transition.status === "ready" && state.transition.transitionId) {
    if (userCommittedTransition(state)) {
      return {
        state: { ...state, transition: { ...state.transition, status: "starting" } },
        commands: [{ type: "PLAY_TRANSITION", transitionId: state.transition.transitionId, durationMs: IMMEDIATE_CROSSFADE_MS, minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS }]
      };
    }
    const committedNext = userCommittedNextTransition(state);
    if (committedNext && naturalTransitionDue(state, remainingMs)) {
      const ending = state.playback.presentationMap?.endStyle;
      return {
        state: { ...state, transition: { ...state.transition, status: "starting" } },
        commands: [{
          type: "PLAY_TRANSITION",
          transitionId: state.transition.transitionId,
          durationMs: ending === "cold" || ending === "resolved" ? 250 : NORMAL_CROSSFADE_MS,
          minimumPlayMs: TRANSITION_MINIMUM_PLAY_MS
        }]
      };
    }
    if (!committedNext && remainingMs <= UNDERRUN_THREAT_MS) {
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

  const preparedSpeech = advancePreparedSpeech(state, at);
  if (preparedSpeech) return preparedSpeech;

  const cue = prepareCue(state, at);
  if (cue) return cue;

  const cart = advanceCart(state, at);
  if (cart) return cart;

  if (canHandoff(state)) return handoff(state);

  if (state.nextTrack.status === "ready" && state.transition.status === "failed" && state.pendingUser?.resolution === "immediate" && pipelineMatches(state)) {
    return handoff(state);
  }

  if (state.playback.role !== "opening_imaging" && state.nextTrack.status === "ready" && state.transition.status === "none" && remainingMs <= NORMAL_CROSSFADE_MS + 1_000) {
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

  return scheduleDueHorizon(state, at);
}

export function reduce(state: StationState, event: StationEvent): Reduction {
  let next = state;
  let commands: StationCommand[] = [];

  switch (event.type) {
    case "START_STATION": {
      const fresh = createInitialState(state.dj.muted);
      const imaging = compileOpeningImagingSpec(event.sessionId, 1, fresh.showState.presenter.name);
      next = {
        ...fresh,
        phase: "generating_next",
        running: true,
        intentRevision: 1,
        startup: { requestId: event.sessionId, message: event.message, status: "planning" },
        openingImaging: { status: "generating", trackId: imaging.id, revision: imaging.revision, spec: imaging, bufferedMs: 0, generatedMs: 0 },
        autonomy: { lastListenerAt: event.at, tracksSinceListener: 0, mode: "interactive" },
        recentUserMessages: [event.message],
        conversation: [{ role: "listener", text: event.message, at: event.at }]
      };
      commands = [
        { type: "GENERATE_TRACK", spec: imaging },
        { type: "PLAN_INITIAL_INTENT", input: { requestId: event.sessionId, message: event.message, showState: fresh.showState } }
      ];
      break;
    }
    case "STOP_STATION":
      next = createInitialState(state.dj.muted);
      commands = [{ type: "STOP_ALL" }];
      break;
    case "SET_DJ_MUTED": {
      const speechId = state.dj.speechId ?? state.dj.prepared?.speechId;
      const deferredIds = !event.muted && state.running
        ? new Set(state.carts.entries.filter((entry) => entry.status === "registered" && entry.kind === "id").map((entry) => entry.id))
        : new Set<string>();
      next = {
        ...state,
        dj: {
          ...state.dj,
          muted: event.muted,
          speaking: event.muted ? false : state.dj.speaking,
          speechId: event.muted ? undefined : state.dj.speechId,
          prepared: event.muted ? undefined : state.dj.prepared
        },
        carts: deferredIds.size ? {
          ...state.carts,
          entries: state.carts.entries.map((entry) => deferredIds.has(entry.id) ? { ...entry, status: "generating" } : entry)
        } : state.carts
      };
      if (event.muted && speechId) commands = [{ type: "CANCEL_SPEECH", speechId }];
      if (!event.muted && deferredIds.size) {
        commands = state.carts.entries.filter((entry) => deferredIds.has(entry.id)).map((entry) => ({
          type: "GENERATE_CART" as const,
          spec: {
            id: entry.id,
            kind: entry.kind,
            mixType: entry.mixType,
            title: entry.title,
            durationMs: entry.durationMs,
            allowedPlacements: entry.allowedPlacements,
            track: entry.track
          }
        }));
      }
      break;
    }
    case "INITIAL_INTENT_RECEIVED": {
      if (state.startup?.requestId !== event.requestId) break;
      const direction = event.plan.musicalDirection;
      const spec = compileTrackSpec(`${event.requestId}-first-track`, state.intentRevision, planDirective(event.plan), direction.intent, event.requestId);
      const stationElements = compileStationElements(event.requestId, state.intentRevision, state.showState.presenter.name);
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
        carts: {
          entries: stationElements.map((element) => ({ ...element, status: "registered", useCount: 0 }))
        },
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
        autonomy: { lastListenerAt: event.at, tracksSinceListener: 0, mode: "interactive" },
        pendingUser: {
          requestId: event.requestId,
          revision,
          message: event.message,
          applied: false,
          nearHorizonAtRequest: (state.playback.remainingMs ?? Infinity) <= NEXT_TRACK_HORIZON_MS + NEXT_TRACK_REQUEST_GUARD_MS || state.nextTrack.status !== "none"
        },
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
      const listenerSilenceMs = state.autonomy.lastListenerAt === null
        ? 0
        : Math.max(0, event.at - state.autonomy.lastListenerAt);
      const speechSilenceMs = state.showState.speechCadence.lastCueAt === null
        ? null
        : Math.max(0, event.at - state.showState.speechCadence.lastCueAt);
      const cueAuthorized = shouldAuthorizeAutonomousCue({
        mode: state.autonomy.mode,
        listenerSilenceMs,
        speechSilenceMs
      });
      next = {
        ...state, continuityPlanRequestId: undefined,
        showState: applyShowMemory(
          state.showState,
          event.plan.memoryUpdates,
          state.showState.musicalThesis.current,
          productionFingerprint(planDirective(event.plan))
        ),
        dj: {
          ...state.dj,
          pending: cueAuthorized ? plannedCue(event.plan, `cue-${event.requestId}`, state.intentRevision, spec.id) : undefined
        },
        nextTrack: { status: "generating", trackId: spec.id, revision: spec.revision, spec, bufferedMs: 0, generatedMs: 0 }
      };
      commands = [{ type: "GENERATE_TRACK", spec }];
      break;
    }
    case "CONTINUITY_PLAN_FAILED":
      if (state.continuityPlanRequestId === event.requestId) next = { ...state, phase: "error", error: event.error };
      break;
    case "TRACK_GENERATION_STARTED":
      if (eventMatchesOpeningImaging(state, event.trackId, event.revision)) next = { ...state, openingImaging: { ...state.openingImaging, status: "generating", spec: event.spec } };
      else if (eventMatchesNext(state, event.trackId, event.revision)) next = { ...state, nextTrack: { ...state.nextTrack, status: "generating", spec: event.spec } };
      break;
    case "TRACK_FIRST_AUDIO":
      if (eventMatchesOpeningImaging(state, event.trackId, event.revision)) next = { ...state, openingImaging: { ...state.openingImaging, status: "buffering", firstAudioMs: event.latencyMs } };
      else if (eventMatchesNext(state, event.trackId, event.revision)) next = { ...state, nextTrack: { ...state.nextTrack, status: "buffering", firstAudioMs: event.latencyMs } };
      break;
    case "TRACK_BUFFER_UPDATED":
      if (eventMatchesOpeningImaging(state, event.trackId, event.revision)) {
        next = { ...state, openingImaging: { ...state.openingImaging, status: state.openingImaging.status === "ready" ? "ready" : "buffering", bufferedMs: event.bufferedMs, generatedMs: event.generatedMs, generationRate: event.generationRate } };
      } else if (eventMatchesNext(state, event.trackId, event.revision)) {
        next = { ...state, nextTrack: { ...state.nextTrack, status: state.nextTrack.status === "ready" ? "ready" : "buffering", bufferedMs: event.bufferedMs, generatedMs: event.generatedMs, generationRate: event.generationRate } };
      }
      break;
    case "TRACK_DURATION_RESOLVED":
      if (eventMatchesOpeningImaging(state, event.trackId, event.revision) && state.openingImaging.spec) {
        next = { ...state, openingImaging: { ...state.openingImaging, spec: { ...state.openingImaging.spec, durationMs: event.durationMs } } };
      } else if (eventMatchesNext(state, event.trackId, event.revision) && state.nextTrack.spec) {
        next = { ...state, nextTrack: { ...state.nextTrack, spec: { ...state.nextTrack.spec, durationMs: event.durationMs } } };
      }
      break;
    case "TRACK_LYRIC_TIMESTAMPS_RECEIVED":
      if (state.playback.trackId === event.trackId && state.playback.durationMs !== null) {
        next = {
          ...state,
          playback: {
            ...state.playback,
            wordTimestamps: event.wordTimestamps,
            presentationMap: buildTrackPresentationMap(event.trackId, state.playback.durationMs, state.playback.sections, event.wordTimestamps)
          }
        };
      }
      break;
    case "TRACK_READY": {
      if (eventMatchesOpeningImaging(state, event.trackId, event.revision)) {
        next = { ...state, openingImaging: { ...state.openingImaging, status: "ready" } };
      } else if (eventMatchesNext(state, event.trackId, event.revision)) {
        next = { ...state, nextTrack: { ...state.nextTrack, status: "ready" } };
      }
      break;
    }
    case "TRACK_GENERATION_FAILED": {
      if (eventMatchesOpeningImaging(state, event.trackId, event.revision)) {
        next = {
          ...state,
          openingImaging: { ...state.openingImaging, status: "failed", error: event.error },
          ...(isProviderAllowanceExhausted(event.error) ? { error: event.error } : {})
        };
        break;
      }
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
    case "TTS_PREPARED":
      if (state.dj.muted || state.dj.prepared?.speechId !== event.speechId || state.dj.prepared.status !== "preparing") break;
      next = { ...state, dj: { ...state.dj, prepared: { ...state.dj.prepared, status: "ready", durationMs: event.durationMs, readyAt: event.at } } };
      break;
    case "TTS_PREPARATION_FAILED":
      if (state.dj.prepared?.speechId !== event.speechId) break;
      next = {
        ...state,
        dj: { ...state.dj, prepared: undefined, speaking: false, speechId: undefined },
        ...(isProviderAllowanceExhausted(event.error) ? { error: event.error } : {})
      };
      break;
    case "TTS_STARTED":
      if (state.dj.muted || state.dj.speechId !== event.speechId) break;
      next = { ...state, dj: { ...state.dj, speaking: true, speechId: event.speechId } };
      break;
    case "TTS_FINISHED":
      if (state.dj.speechId !== event.speechId) break;
      next = { ...state, dj: { ...state.dj, speaking: false, speechId: undefined, prepared: undefined } };
      break;
    case "CART_READY":
      next = {
        ...state,
        carts: {
          ...state.carts,
          entries: state.carts.entries.map((entry) => entry.id === event.cartId ? { ...entry, status: "ready", error: undefined } : entry)
        }
      };
      break;
    case "CART_GENERATION_FAILED":
      next = {
        ...state,
        ...(isProviderAllowanceExhausted(event.error) ? { error: event.error } : {}),
        carts: {
          ...state.carts,
          entries: state.carts.entries.map((entry) => entry.id === event.cartId ? { ...entry, status: "failed", error: event.error } : entry)
        }
      };
      break;
    case "CART_STARTED":
      if (state.carts.playingId !== event.cartId) break;
      next = state;
      break;
    case "CART_FINISHED":
      if (state.carts.playingId !== event.cartId) break;
      next = { ...state, carts: { ...state.carts, playingId: undefined } };
      break;
    case "TRACK_STARTED": {
      const openingImagingStarted = state.openingImaging.trackId === event.trackId && event.spec.role === "opening_imaging";
      if (!openingImagingStarted && state.nextTrack.trackId !== event.trackId) break;
      if (openingImagingStarted) {
        next = {
          ...state,
          phase: "playing",
          playback: {
            trackId: event.trackId, role: "opening_imaging", title: event.spec.title, playheadMs: 0,
            durationMs: event.spec.durationMs, remainingMs: event.spec.durationMs,
            bpm: event.spec.bpm, key: event.spec.key, styleSummary: event.spec.description, energy: event.spec.energy,
            styles: event.spec.styles, mood: event.spec.mood, vocals: event.spec.vocals, sections: event.spec.sections,
            editorialNotes: event.spec.editorialNotes,
            presentationMap: buildTrackPresentationMap(event.trackId, event.spec.durationMs, event.spec.sections),
            bufferedMs: state.openingImaging.bufferedMs
          },
          openingImaging: emptyNext(),
          horizonFiredForTrackId: null,
          error: undefined
        };
        break;
      }
      const cartsToGenerate = state.carts.entries.filter((entry) => entry.status === "registered" && !(state.dj.muted && entry.kind === "id"));
      const cartIdsToGenerate = new Set(cartsToGenerate.map((entry) => entry.id));
      if (cartsToGenerate.length) {
        commands = cartsToGenerate.map((entry) => ({
          type: "GENERATE_CART" as const,
          spec: {
            id: entry.id,
            kind: entry.kind,
            mixType: entry.mixType,
            title: entry.title,
            durationMs: entry.durationMs,
            allowedPlacements: entry.allowedPlacements,
            track: entry.track
          }
        }));
      }
      if (state.playback.trackId && state.playback.title && state.playback.role !== "opening_imaging") {
        next = { ...state, recentTracks: append(state.recentTracks, { trackId: state.playback.trackId, title: state.playback.title, description: state.playback.styleSummary ?? "", bpm: state.playback.bpm, key: state.playback.key, energy: state.playback.energy }, 12) };
      }
      next = {
        ...next,
        phase: "playing",
        playback: {
          trackId: event.trackId, role: "programme", title: event.spec.title, playheadMs: 0, durationMs: event.spec.durationMs, remainingMs: event.spec.durationMs,
          bpm: event.spec.bpm, key: event.spec.key, styleSummary: event.spec.description, energy: event.spec.energy,
          styles: event.spec.styles, mood: event.spec.mood, vocals: event.spec.vocals, sections: event.spec.sections,
          editorialNotes: event.spec.editorialNotes,
          presentationMap: buildTrackPresentationMap(event.trackId, event.spec.durationMs, event.spec.sections),
          bufferedMs: state.nextTrack.bufferedMs
        },
        nextTrack: emptyNext(),
        openingImaging: emptyNext(),
        transition: emptyTransition(),
        horizonFiredForTrackId: null,
        horizonRequestId: undefined,
        continuityPlanRequestId: undefined,
        startup: undefined,
        pendingUser: state.pendingUser?.applied ? undefined : state.pendingUser,
        autonomy: {
          ...state.autonomy,
          tracksSinceListener: state.startup || state.pendingUser?.applied ? 0 : state.autonomy.tracksSinceListener + (state.playback.trackId ? 1 : 0)
        },
        carts: {
          ...state.carts,
          entries: state.carts.entries.map((entry) => cartIdsToGenerate.has(entry.id) ? { ...entry, status: "generating" } : entry)
        },
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

  next = publishCueText(next, event.at);
  const advanced = advanceProgramme(next, event.at);
  return finish(advanced.state, event, [...commands, ...advanced.commands]);
}
