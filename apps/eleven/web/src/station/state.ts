import type { MusicalIntent, ShowState, StationState } from "@robot-radio/eleven-shared";

export const DEFAULT_INTENT: MusicalIntent = {
  description: "Warm, nocturnal electronic music with a steady pulse",
  styles: ["ambient techno", "downtempo"],
  mood: ["focused", "nocturnal"],
  energy: 0.56,
  bpmRange: [108, 120],
  keyPreference: "E minor",
  vocals: "instrumental"
};

export const DEFAULT_SHOW_STATE: ShowState = {
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
    current: DEFAULT_INTENT.description,
    intendedTrajectory: ["Establish the requested world clearly, then develop it without repeating the same production move."]
  },
  recentProductionFingerprints: [],
  speechCadence: {
    lastCueAt: null,
    cooldownMs: 45_000,
    sessionTalkativeness: 0.55,
    cuesSpoken: 0
  }
};

export function createInitialState(djMuted = false): StationState {
  return {
    phase: "idle",
    running: false,
    playback: { trackId: null, title: null, playheadMs: 0, durationMs: null, remainingMs: null, bufferedMs: 0 },
    intent: DEFAULT_INTENT,
    showState: DEFAULT_SHOW_STATE,
    intentRevision: 0,
    nextTrack: { status: "none", bufferedMs: 0, generatedMs: 0 },
    transition: { status: "none", bufferedMs: 0, generatedMs: 0 },
    dj: { muted: djMuted, speaking: false },
    recentEvents: [],
    recentCommands: [],
    recentTracks: [],
    recentUserMessages: [],
    recentDjLines: [],
    conversation: [],
    horizonFiredForTrackId: null
  };
}
