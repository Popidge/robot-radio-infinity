import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRUISE_SILENCE_MS,
  CRUISE_TRACK_THRESHOLD,
  EXPLORATORY_SILENCE_MS,
  EXPLORATORY_TRACK_THRESHOLD,
  selectAutonomyMode,
  shouldAuthorizeAutonomousCue,
  type AutonomyMode,
  type LLMProvider,
  type MusicalIntent,
  type MusicalSnapshot,
  type ProducerPlan,
  type ShowMemoryUpdates,
  type ShowState,
  type TrackDirective,
  type UrgencyAssessment
} from "@robot-radio/eleven-shared";
import { OpenAILLMProvider } from "../providers/openai/llm";

type StepKind = "opening" | "continuity" | "listener" | "mode_contrast";

export interface PlanProfileMetrics {
  novelty: number;
  intentCoverage: number;
  sectionCount: number;
  durationDeltaMs: number | null;
  hasInstrumentalOpening: boolean;
  hasDefinedEnding: boolean;
  repeatsRecentTitle: boolean;
  repeatsProductionFingerprint: boolean;
}

export interface ProfileStep {
  scenario: string;
  label: string;
  kind: StepKind;
  atMs: number;
  mode: AutonomyMode;
  tracksSinceListener: number;
  silenceMs: number;
  latencyMs: number;
  listenerMessage?: string;
  urgency?: UrgencyAssessment;
  cueAuthorized: boolean;
  plan: ProducerPlan;
  metrics: PlanProfileMetrics;
}

export interface ScenarioProfile {
  id: string;
  description: string;
  steps: ProfileStep[];
}

export interface AutonomyProfile {
  generatedAt: string;
  model: string;
  calls: number;
  thresholds: {
    cruiseTracks: number;
    cruiseSilenceMs: number;
    exploratoryTracks: number;
    exploratorySilenceMs: number;
  };
  scenarios: ScenarioProfile[];
  reviewFlags: string[];
}

interface SimulationState {
  currentIntent: MusicalIntent;
  currentTrack: MusicalSnapshot | null;
  showState: ShowState;
  lastListenerAtMs: number;
  tracksSinceListener: number;
  recentTitles: string[];
}

let chargeableCalls = 0;

const BASE_SHOW_STATE: ShowState = {
  presenter: {
    name: "Robot Radio Infinity",
    identity: "A warm, curious, slightly odd late-night producer-presenter who listens closely and treats the session as one continuous authored show.",
    voiceRules: [
      "Use one or two concise sentences with a natural spoken rhythm.",
      "Be specific to this listener and this musical moment; avoid generic radio hype.",
      "Use callbacks and the listener's own phrasing sparingly, only when they feel earned.",
      "Do not mention software, models, prompts, APIs, generation, or orchestration.",
      "Never claim that unheard music has already played."
    ]
  },
  listener: { preferences: [], dislikes: [], callbacks: [], notablePhrases: [] },
  musicalThesis: {
    current: "Warm, nocturnal electronic music with a steady pulse",
    intendedTrajectory: ["Establish the requested world clearly, then develop it without repeating the same production move."]
  },
  recentProductionFingerprints: [],
  recentLinkFingerprints: [],
  speechCadence: { lastCueAt: null, cooldownMs: 45_000, sessionTalkativeness: 0.55, cuesSpoken: 0 }
};

const BASE_INTENT: MusicalIntent = {
  description: "Warm, nocturnal electronic music with a steady pulse",
  styles: ["ambient techno", "downtempo"],
  mood: ["focused", "nocturnal"],
  energy: 0.56,
  bpmRange: [108, 120],
  keyPreference: "E minor",
  vocals: "instrumental"
};

function cloneState(state: SimulationState): SimulationState {
  return structuredClone(state);
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

function directiveFingerprint(directive: TrackDirective): string {
  return [
    directive.title,
    directive.description,
    ...(directive.styles ?? []),
    ...(directive.mood ?? []),
    directive.bpm ? `${Math.round(directive.bpm)} BPM` : "",
    directive.key ?? ""
  ].filter(Boolean).join("; ").slice(0, 300);
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

function applyCueMemory(showState: ShowState, cue: ProducerPlan["onAirCue"], atMs: number): ShowState {
  if (!cue) return showState;
  return {
    ...showState,
    recentLinkFingerprints: appendUnique(showState.recentLinkFingerprints, cue.linkFingerprint ? [cue.linkFingerprint] : undefined, 8),
    speechCadence: {
      ...showState.speechCadence,
      lastCueAt: atMs,
      lastCuePurpose: cue.purpose,
      cuesSpoken: showState.speechCadence.cuesSpoken + 1
    }
  };
}

function applyMemory(
  showState: ShowState,
  updates: ShowMemoryUpdates,
  fallbackThesis: string,
  fallbackFingerprint: string,
  cue: ProducerPlan["onAirCue"],
  atMs: number
): ShowState {
  const fingerprint = fallbackFingerprint.trim() || updates.productionFingerprint?.trim();
  const withListenerMemory = applyListenerMemory(showState, updates);
  const withCueMemory = applyCueMemory(withListenerMemory, cue, atMs);
  return {
    ...withCueMemory,
    musicalThesis: {
      current: updates.musicalThesis?.trim() || fallbackThesis,
      intendedTrajectory: updates.intendedTrajectory
        ? appendUnique([], updates.intendedTrajectory, 6)
        : showState.musicalThesis.intendedTrajectory
    },
    recentProductionFingerprints: appendUnique(showState.recentProductionFingerprints, fingerprint ? [fingerprint] : undefined, 8)
  };
}

function snapshot(directive: TrackDirective): MusicalSnapshot {
  const sectionFacts = (directive.sections ?? []).slice(0, 5).map((section) => {
    const firstLyric = section.lyrics?.split("\n").map((line) => line.trim()).find(Boolean);
    return `${section.name}: ${section.description}${firstLyric ? `; lyric “${firstLyric}”` : ""}`.slice(0, 300);
  });
  return {
    title: directive.title,
    styleSummary: directive.description,
    bpm: directive.bpm,
    key: directive.key,
    energy: directive.energy,
    presentationFacts: sectionFacts
  };
}

function tokens(values: Array<string | undefined>): Set<string> {
  return new Set(values.join(" ").toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2) ?? []);
}

function intersectionRatio(source: Set<string>, target: Set<string>): number {
  if (!source.size) return 1;
  let overlap = 0;
  for (const value of source) if (target.has(value)) overlap += 1;
  return overlap / source.size;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  const union = new Set([...left, ...right]);
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return union.size ? overlap / union.size : 0;
}

export function profilePlan(plan: ProducerPlan, state: Pick<SimulationState, "currentIntent" | "showState" | "recentTitles">): PlanProfileMetrics {
  const track = plan.musicalDirection.nextTrack;
  const trackTokens = tokens([track.title, track.description, ...(track.styles ?? []), ...(track.mood ?? [])]);
  const intentTokens = tokens([
    state.currentIntent.description,
    ...state.currentIntent.styles,
    ...state.currentIntent.mood,
    state.currentIntent.vocals
  ]);
  const recentSimilarities = state.showState.recentProductionFingerprints.map((item) => jaccard(trackTokens, tokens([item])));
  const fingerprint = plan.memoryUpdates.productionFingerprint?.trim() || directiveFingerprint(track);
  const durationTotal = track.sections?.reduce((sum, section) => sum + section.durationMs, 0) ?? null;
  const firstSection = track.sections?.[0];
  const lastSection = track.sections?.at(-1);
  return {
    novelty: Number((1 - Math.max(0, ...recentSimilarities)).toFixed(3)),
    intentCoverage: Number(intersectionRatio(intentTokens, trackTokens).toFixed(3)),
    sectionCount: track.sections?.length ?? 0,
    durationDeltaMs: durationTotal === null ? null : durationTotal - (track.durationMs ?? 180_000),
    hasInstrumentalOpening: Boolean(firstSection && !firstSection.lyrics?.trim()),
    hasDefinedEnding: Boolean(lastSection && /(cold|clean|resolv|fade|final|ending|stop|handoff|outro)/i.test(`${lastSection.name} ${lastSection.description}`)),
    repeatsRecentTitle: state.recentTitles.some((title) => title.toLowerCase() === track.title.toLowerCase()),
    repeatsProductionFingerprint: state.showState.recentProductionFingerprints.some((item) => item.toLowerCase() === fingerprint.toLowerCase())
  };
}

function updateFromPlan(
  state: SimulationState,
  plan: ProducerPlan,
  atMs: number,
  options: {
    updateIntent: boolean;
    replaceTrack: boolean;
    resetListener: boolean;
    incrementTrack: boolean;
    cueAuthorized?: boolean;
    listenerMemoryOnly?: boolean;
  }
): SimulationState {
  const directive = plan.musicalDirection.nextTrack;
  const fallbackThesis = options.updateIntent ? plan.musicalDirection.intent.description : state.showState.musicalThesis.current;
  return {
    currentIntent: options.updateIntent ? plan.musicalDirection.intent : state.currentIntent,
    currentTrack: options.replaceTrack ? snapshot(directive) : state.currentTrack,
    showState: options.listenerMemoryOnly
      ? applyCueMemory(
        applyListenerMemory(state.showState, plan.memoryUpdates),
        options.cueAuthorized === false ? undefined : plan.onAirCue,
        atMs
      )
      : applyMemory(
        state.showState,
        plan.memoryUpdates,
        fallbackThesis,
        directiveFingerprint(directive),
        options.cueAuthorized === false ? undefined : plan.onAirCue,
        atMs
      ),
    lastListenerAtMs: options.resetListener ? atMs : state.lastListenerAtMs,
    tracksSinceListener: options.resetListener ? 0 : state.tracksSinceListener + (options.incrementTrack ? 1 : 0),
    recentTitles: options.replaceTrack ? appendUnique(state.recentTitles, [directive.title], 12) : state.recentTitles
  };
}

async function measured<T>(scenario: string, label: string, call: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  chargeableCalls += 1;
  process.stdout.write(`[${scenario}] ${label}… `);
  const startedAt = performance.now();
  try {
    const value = await call();
    const latencyMs = Math.round(performance.now() - startedAt);
    process.stdout.write(`${latencyMs}ms\n`);
    return { value, latencyMs };
  } catch (error) {
    process.stdout.write("failed\n");
    throw error;
  }
}

function stepFromPlan(
  scenario: string,
  label: string,
  kind: StepKind,
  atMs: number,
  mode: AutonomyMode,
  state: SimulationState,
  plan: ProducerPlan,
  latencyMs: number,
  listenerMessage?: string,
  urgency?: UrgencyAssessment,
  cueAuthorized = Boolean(plan.onAirCue)
): ProfileStep {
  return {
    scenario,
    label,
    kind,
    atMs,
    mode,
    tracksSinceListener: state.tracksSinceListener,
    silenceMs: Math.max(0, atMs - state.lastListenerAtMs),
    latencyMs,
    listenerMessage,
    urgency,
    cueAuthorized,
    plan,
    metrics: profilePlan(plan, state)
  };
}

async function openStation(provider: LLMProvider, scenario: string, message: string): Promise<{ state: SimulationState; step: ProfileStep }> {
  const state: SimulationState = {
    currentIntent: structuredClone(BASE_INTENT),
    currentTrack: null,
    showState: structuredClone(BASE_SHOW_STATE),
    lastListenerAtMs: 0,
    tracksSinceListener: 0,
    recentTitles: []
  };
  const result = await measured(scenario, "opening producer plan", () => provider.planInitialIntent({ requestId: `${scenario}-opening`, message, showState: state.showState }));
  const step = stepFromPlan(scenario, "Listener opens the station", "opening", 0, "interactive", state, result.value, result.latencyMs, message);
  return {
    step,
    state: updateFromPlan(state, result.value, 0, { updateIntent: true, replaceTrack: true, resetListener: true, incrementTrack: false })
  };
}

async function continueStation(provider: LLMProvider, scenario: string, label: string, state: SimulationState, atMs: number): Promise<{ state: SimulationState; step: ProfileStep }> {
  const silenceMs = Math.max(0, atMs - state.lastListenerAtMs);
  const speechSilenceMs = state.showState.speechCadence.lastCueAt === null
    ? null
    : Math.max(0, atMs - state.showState.speechCadence.lastCueAt);
  const mode = selectAutonomyMode({ tracksSinceListener: state.tracksSinceListener, silenceMs });
  const result = await measured(scenario, `${label} (${mode})`, () => provider.planContinuity({
    requestId: `${scenario}-continuity-${atMs}`,
    currentIntent: state.currentIntent,
    currentTrack: state.currentTrack,
    showState: state.showState,
    autonomy: {
      mode,
      tracksSinceListener: state.tracksSinceListener,
      silenceMs,
      speechSilenceMs
    }
  }));
  const cueAuthorized = Boolean(result.value.onAirCue && shouldAuthorizeAutonomousCue({
    mode,
    listenerSilenceMs: silenceMs,
    speechSilenceMs
  }));
  return {
    step: stepFromPlan(scenario, label, "continuity", atMs, mode, state, result.value, result.latencyMs, undefined, undefined, cueAuthorized),
    state: updateFromPlan(state, result.value, atMs, {
      updateIntent: false,
      replaceTrack: true,
      resetListener: false,
      incrementTrack: true,
      cueAuthorized
    })
  };
}

async function listenerTurn(provider: LLMProvider, scenario: string, label: string, state: SimulationState, atMs: number, message: string): Promise<{ state: SimulationState; step: ProfileStep }> {
  chargeableCalls += 2;
  process.stdout.write(`[${scenario}] ${label} urgency + producer plan… `);
  const startedAt = performance.now();
  const input = {
    requestId: `${scenario}-listener-${atMs}`,
    message,
    currentIntent: state.currentIntent,
    currentTrack: state.currentTrack
  };
  const [urgency, plan] = await Promise.all([
    provider.assessUrgency(input),
    provider.planUserIntent({ ...input, remainingMs: 120_000, showState: state.showState })
  ]);
  const latencyMs = Math.round(performance.now() - startedAt);
  process.stdout.write(`${latencyMs}ms · ${urgency.timing}\n`);
  const step = stepFromPlan(scenario, label, "listener", atMs, "interactive", state, plan, latencyMs, message, urgency);
  const conversationOnly = urgency.timing === "conversation_only";
  return {
    step,
    state: updateFromPlan(state, plan, atMs, {
      updateIntent: !conversationOnly,
      replaceTrack: !conversationOnly,
      resetListener: true,
      incrementTrack: false,
      listenerMemoryOnly: conversationOnly
    })
  };
}

async function handsOffScenario(provider: LLMProvider, opening: { state: SimulationState; step: ProfileStep }): Promise<ScenarioProfile> {
  const scenario = "long_hands_off";
  let state = cloneState(opening.state);
  const steps = [{ ...opening.step, scenario }];
  const horizons = [130_000, 310_000, 490_000, 670_000, 850_000];
  for (const [index, atMs] of horizons.entries()) {
    const result = await continueStation(provider, scenario, `Autonomous horizon ${index + 1}`, state, atMs);
    state = result.state;
    steps.push(result.step);
  }
  return {
    id: scenario,
    description: "A listener establishes one rich musical world, then leaves the DJ alone through interactive, cruise, and exploratory horizons.",
    steps
  };
}

async function resetScenario(provider: LLMProvider, opening: { state: SimulationState; step: ProfileStep }): Promise<ScenarioProfile> {
  const scenario = "listener_reclaims_control";
  let state = cloneState(opening.state);
  const steps = [{ ...opening.step, scenario }];
  for (const [index, atMs] of [130_000, 310_000, 490_000].entries()) {
    const result = await continueStation(provider, scenario, `Pre-intervention horizon ${index + 1}`, state, atMs);
    state = result.state;
    steps.push(result.step);
  }
  const listener = await listenerTurn(
    provider,
    scenario,
    "Listener redirects after cruise begins",
    state,
    600_000,
    "I'm done with sung vocals for now. For the next track keep the dub weight, but pull it into clipped broken-beat jazz with dry drums and nervous electric piano."
  );
  state = listener.state;
  steps.push(listener.step);
  for (const [index, atMs] of [750_000, 930_000, 1_110_000].entries()) {
    const result = await continueStation(provider, scenario, `Post-intervention horizon ${index + 1}`, state, atMs);
    state = result.state;
    steps.push(result.step);
  }
  return {
    id: scenario,
    description: "The DJ reaches cruise, receives a precise next-track redirect and vocal dislike, then must reset to listener-led development before cruising again.",
    steps
  };
}

async function socialMemoryScenario(provider: LLMProvider): Promise<ScenarioProfile> {
  const scenario = "social_memory_then_silence";
  const opening = await openStation(
    provider,
    scenario,
    "Sparkly turn-of-the-millennium UK garage with playful synth hooks, warm sub bass, clipped soulful vocals and a slightly surreal late-night glow."
  );
  let state = opening.state;
  const steps = [opening.step];
  const listener = await listenerTurn(
    provider,
    scenario,
    "Listener asks for a personal shoutout",
    state,
    45_000,
    "Can I get a shoutout? My name is Jamie—I'm building this station live and this is absolutely brilliant."
  );
  state = listener.state;
  steps.push(listener.step);
  for (const [index, atMs] of [175_000, 355_000, 535_000, 715_000].entries()) {
    const result = await continueStation(provider, scenario, `After-shoutout horizon ${index + 1}`, state, atMs);
    state = result.state;
    steps.push(result.step);
  }
  return {
    id: scenario,
    description: "A non-musical personal interaction should enter bounded memory, leave the musical thesis intact, and be used only when an earned later callback improves the link.",
    steps
  };
}

async function modeContrastScenario(provider: LLMProvider): Promise<ScenarioProfile> {
  const scenario = "controlled_mode_contrast";
  const state: SimulationState = {
    currentIntent: {
      description: "Nocturnal dub-soul built around negative space, hand percussion, warm sub bass and ghostly brass",
      styles: ["dub soul", "future roots", "minimal broken beat"],
      mood: ["nocturnal", "warm", "mysterious"],
      energy: 0.58,
      bpmRange: [104, 116],
      keyPreference: "D minor",
      vocals: "occasional intimate English lead"
    },
    currentTrack: {
      title: "Lanterns in the Delay",
      styleSummary: "Sparse future-roots pulse with hand drums, soft brass answers, tape delay and an intimate two-line refrain.",
      bpm: 108,
      key: "D minor",
      energy: 0.55,
      presentationFacts: ["12-second instrumental hand-drum ramp", "clean final dub chord with no vocal tail"]
    },
    showState: {
      ...structuredClone(BASE_SHOW_STATE),
      listener: {
        preferences: ["dub weight", "hand-played rhythmic detail", "surprising but coherent genre turns"],
        dislikes: ["generic festival drops"],
        callbacks: ["the signal after midnight"],
        notablePhrases: ["make the silence part of the tune"]
      },
      musicalThesis: {
        current: "Let dub negative space gradually reveal a stranger soul and broken-beat language without losing warmth.",
        intendedTrajectory: ["Deepen the pocket", "Change the dominant acoustic texture", "Leave room for one bolder adjacent move"]
      },
      recentProductionFingerprints: [
        "104 BPM D-minor dub soul with hand drums, warm sub, melodica fragments and a whispered refrain",
        "110 BPM future roots with brushed breakbeats, muted trumpet, tape echo and a clean minor ending",
        "108 BPM sparse dub ballad with rim clicks, low brass swells, organ bubbles and intimate vocals",
        "112 BPM broken dub groove with wood percussion, clipped guitar harmonics and a two-note horn hook"
      ],
      speechCadence: { lastCueAt: 0, lastCuePurpose: "opening", cooldownMs: 45_000, sessionTalkativeness: 0.55, cuesSpoken: 1 }
    },
    lastListenerAtMs: 0,
    tracksSinceListener: 4,
    recentTitles: ["Lanterns in the Delay", "Soft Static", "Woodsmoke Receiver", "Rooms Between Beats"]
  };
  const contexts: Array<{ mode: AutonomyMode; tracks: number; silenceMs: number }> = [
    { mode: "interactive", tracks: 0, silenceMs: 130_000 },
    { mode: "cruise", tracks: 2, silenceMs: 540_000 },
    { mode: "exploratory", tracks: 4, silenceMs: 900_000 }
  ];
  const results = await Promise.all(contexts.map(async (context) => {
    const cueAuthorized = shouldAuthorizeAutonomousCue({
      mode: context.mode,
      listenerSilenceMs: context.silenceMs,
      speechSilenceMs: context.silenceMs
    });
    const result = await measured(scenario, `${context.mode} comparison`, () => provider.planContinuity({
      requestId: `${scenario}-${context.mode}`,
      currentIntent: state.currentIntent,
      currentTrack: state.currentTrack,
      showState: state.showState,
      autonomy: {
        mode: context.mode,
        tracksSinceListener: context.tracks,
        silenceMs: context.silenceMs,
        speechSilenceMs: context.silenceMs
      }
    }));
    return stepFromPlan(
      scenario,
      `Same state in ${context.mode}`,
      "mode_contrast",
      context.silenceMs,
      context.mode,
      { ...state, tracksSinceListener: context.tracks },
      result.value,
      result.latencyMs,
      undefined,
      undefined,
      Boolean(result.value.onAirCue && cueAuthorized)
    );
  }));
  return {
    id: scenario,
    description: "The identical musical state is presented as interactive, cruise, and exploratory to expose what the mode instruction itself changes.",
    steps: results
  };
}

function minutes(milliseconds: number): string {
  return `${(milliseconds / 60_000).toFixed(1)}m`;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function profileFlags(scenarios: ScenarioProfile[]): string[] {
  const flags: string[] = [];
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      if (step.urgency?.timing === "conversation_only") {
        const memory = step.plan.memoryUpdates;
        if (memory.musicalThesis || memory.intendedTrajectory?.length || memory.productionFingerprint) {
          flags.push(`${scenario.id}/${step.label}: conversation-only plan returned musical programme memory that the reducer will ignore.`);
        }
      }
      if (step.metrics.repeatsRecentTitle) flags.push(`${scenario.id}/${step.label}: repeated a recent title (${step.plan.musicalDirection.nextTrack.title}).`);
      if (step.metrics.repeatsProductionFingerprint) flags.push(`${scenario.id}/${step.label}: repeated an exact production fingerprint.`);
      if (step.kind === "continuity" || step.kind === "mode_contrast") {
        if (step.plan.suggestedTiming !== "continuity") flags.push(`${scenario.id}/${step.label}: autonomous plan suggested ${step.plan.suggestedTiming} timing.`);
        if (step.plan.onAirCue?.purpose === "listener_acknowledgement" || step.plan.onAirCue?.purpose === "opening") {
          flags.push(`${scenario.id}/${step.label}: autonomous cue used ${step.plan.onAirCue.purpose} grammar.`);
        }
        if (step.plan.onAirCue && /you (asked|wanted|requested)/i.test(step.plan.onAirCue.text)) {
          flags.push(`${scenario.id}/${step.label}: autonomous link may falsely imply a fresh listener request.`);
        }
      }
      if (!step.metrics.hasInstrumentalOpening) flags.push(`${scenario.id}/${step.label}: composition has no authored instrumental opening ramp.`);
      if (!step.metrics.hasDefinedEnding) flags.push(`${scenario.id}/${step.label}: composition ending is not explicit enough for deterministic presentation.`);
      if (step.metrics.durationDeltaMs !== null && Math.abs(step.metrics.durationDeltaMs) > 5_000) {
        flags.push(`${scenario.id}/${step.label}: section durations differ from track duration by ${step.metrics.durationDeltaMs}ms.`);
      }
    }
  }
  const contrast = scenarios.find((scenario) => scenario.id === "controlled_mode_contrast");
  const cruise = contrast?.steps.find((step) => step.mode === "cruise");
  const exploratory = contrast?.steps.find((step) => step.mode === "exploratory");
  if (cruise && exploratory && exploratory.metrics.novelty + 0.05 < cruise.metrics.novelty) {
    flags.push("controlled_mode_contrast: exploratory output measured materially less novel than cruise output.");
  }
  return [...new Set(flags)];
}

export function renderProfileMarkdown(profile: AutonomyProfile): string {
  const lines = [
    "# Robot Radio Infinity — DJ autonomy profile",
    "",
    `Generated: ${profile.generatedAt}`,
    `Model: ${profile.model}`,
    `Chargeable OpenAI calls: ${profile.calls}`,
    `Mode policy: cruise after ${profile.thresholds.cruiseTracks} tracks or ${minutes(profile.thresholds.cruiseSilenceMs)}; exploratory after ${profile.thresholds.exploratoryTracks} tracks or ${minutes(profile.thresholds.exploratorySilenceMs)}.`,
    "",
    "The profiler applies the reducer's autonomous speech-cadence gate. Suppressed cue proposals do not enter the next mocked ShowState; exact mic-window placement remains reducer-owned.",
    ""
  ];
  for (const scenario of profile.scenarios) {
    lines.push(`## ${scenario.id}`, "", scenario.description, "", "| Time | Mode | Event | Next track | BPM | Energy | Novelty | Cue |", "| ---: | --- | --- | --- | ---: | ---: | ---: | --- |");
    for (const step of scenario.steps) {
      const track = step.plan.musicalDirection.nextTrack;
      const conversationOnly = step.urgency?.timing === "conversation_only";
      const cue = step.plan.onAirCue
        ? `${step.cueAuthorized ? step.plan.onAirCue.purpose : "suppressed proposal"}: “${step.plan.onAirCue.text}”`
        : "silence";
      const direction = conversationOnly ? "unchanged (proposal ignored)" : track.title;
      lines.push(`| ${minutes(step.atMs)} | ${step.mode} | ${markdownCell(step.label)} | ${markdownCell(direction)} | ${conversationOnly ? "—" : track.bpm ?? "—"} | ${conversationOnly ? "—" : track.energy?.toFixed(2) ?? "—"} | ${conversationOnly ? "—" : step.metrics.novelty.toFixed(2)} | ${markdownCell(cue)} |`);
    }
    lines.push("");
    for (const step of scenario.steps) {
      const track = step.plan.musicalDirection.nextTrack;
      const conversationOnly = step.urgency?.timing === "conversation_only";
      lines.push(
        `### ${step.label}`,
        "",
        `- Context: ${step.mode}; ${step.tracksSinceListener} track(s) and ${minutes(step.silenceMs)} since the listener; ${step.latencyMs}ms model latency.`,
        `- Direction: ${conversationOnly ? "**unchanged**; structured musical proposal ignored because this was conversation-only" : `**${track.title}** — ${track.description}`}.`,
        `- Palette: ${(track.styles ?? []).join(", ")} · ${(track.mood ?? []).join(", ")} · ${track.bpm ?? "—"} BPM · energy ${track.energy?.toFixed(2) ?? "—"}.`,
        `- Thesis update: ${conversationOnly ? "ignored; existing programme thesis retained" : step.plan.memoryUpdates.musicalThesis ?? "unchanged"}`,
        `- Trajectory: ${conversationOnly ? "ignored; existing programme trajectory retained" : step.plan.memoryUpdates.intendedTrajectory?.join(" → ") ?? "unchanged"}`,
        `- Presenter: ${step.plan.onAirCue ? `${step.cueAuthorized ? step.plan.onAirCue.purpose : "suppressed proposal"} — “${step.plan.onAirCue.text}” [${step.plan.onAirCue.linkFingerprint ?? "no fingerprint"}]` : "silence"}.`,
        `- Radiocraft: ${step.metrics.sectionCount} sections; ${step.metrics.hasInstrumentalOpening ? "opening ramp" : "no opening ramp"}; ${step.metrics.hasDefinedEnding ? "defined ending" : "unclear ending"}; duration delta ${step.metrics.durationDeltaMs ?? "unknown"}ms.`,
        ""
      );
    }
  }
  lines.push("## Automated review flags", "");
  if (profile.reviewFlags.length) lines.push(...profile.reviewFlags.map((flag) => `- ${flag}`));
  else lines.push("- None.");
  lines.push("");
  return lines.join("\n");
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (!flag("--confirm-cost")) {
    throw new Error("The autonomy profile makes chargeable OpenAI calls. Re-run with --confirm-cost. It never calls ElevenLabs.");
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the autonomy profile.");
  chargeableCalls = 0;
  const provider = new OpenAILLMProvider(apiKey);
  const allScenarios = ["long_hands_off", "listener_reclaims_control", "social_memory_then_silence", "controlled_mode_contrast"];
  const requested = argument("--scenarios")?.split(",").map((value) => value.trim()).filter(Boolean) ?? allScenarios;
  const unknown = requested.filter((value) => !allScenarios.includes(value));
  if (unknown.length) throw new Error(`Unknown autonomy scenario(s): ${unknown.join(", ")}`);
  const scenarios: ScenarioProfile[] = [];
  const needsSeed = requested.includes("long_hands_off") || requested.includes("listener_reclaims_control");
  const seed = needsSeed ? await openStation(
    provider,
    "shared_dub_seed",
    "Smoky late-night dub soul with hand percussion, warm sub bass, ghostly horns, negative space and occasional intimate vocals."
  ) : undefined;
  if (requested.includes("long_hands_off") && seed) scenarios.push(await handsOffScenario(provider, seed));
  if (requested.includes("listener_reclaims_control") && seed) scenarios.push(await resetScenario(provider, seed));
  if (requested.includes("social_memory_then_silence")) scenarios.push(await socialMemoryScenario(provider));
  if (requested.includes("controlled_mode_contrast")) scenarios.push(await modeContrastScenario(provider));
  const profile: AutonomyProfile = {
    generatedAt: new Date().toISOString(),
    model: process.env.OPENAI_LLM_MODEL ?? "gpt-5.6-luna",
    calls: chargeableCalls,
    thresholds: {
      cruiseTracks: CRUISE_TRACK_THRESHOLD,
      cruiseSilenceMs: CRUISE_SILENCE_MS,
      exploratoryTracks: EXPLORATORY_TRACK_THRESHOLD,
      exploratorySilenceMs: EXPLORATORY_SILENCE_MS
    },
    scenarios,
    reviewFlags: profileFlags(scenarios)
  };
  const outputDirectory = resolve(process.cwd(), "../../../logs");
  mkdirSync(outputDirectory, { recursive: true });
  const timestamp = profile.generatedAt.replaceAll(":", "-");
  const basePath = resolve(outputDirectory, `dj-autonomy-profile-${timestamp}`);
  writeFileSync(`${basePath}.json`, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  writeFileSync(`${basePath}.md`, renderProfileMarkdown(profile), "utf8");
  process.stdout.write(`\nProfile JSON: ${basePath}.json\nProfile report: ${basePath}.md\nReview flags: ${profile.reviewFlags.length}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
