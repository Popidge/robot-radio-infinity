import type { MusicalIntent, StationState } from "@robot-radio/eleven-shared";

export const DEFAULT_INTENT: MusicalIntent = {
  description: "Warm, nocturnal electronic music with a steady pulse",
  styles: ["ambient techno", "downtempo"],
  mood: ["focused", "nocturnal"],
  energy: 0.56,
  bpmRange: [108, 120],
  keyPreference: "E minor",
  vocals: "instrumental",
  djTalkativeness: 0.25
};

export function createInitialState(): StationState {
  return {
    phase: "idle",
    running: false,
    playback: { trackId: null, title: null, playheadMs: 0, durationMs: null, remainingMs: null, bufferedMs: 0 },
    intent: DEFAULT_INTENT,
    intentRevision: 0,
    nextTrack: { status: "none", bufferedMs: 0, generatedMs: 0 },
    transition: { status: "none", bufferedMs: 0, generatedMs: 0 },
    dj: { speaking: false },
    recentEvents: [],
    recentCommands: [],
    recentTracks: [],
    recentUserMessages: [],
    recentDjLines: [],
    horizonFiredForTrackId: null
  };
}
