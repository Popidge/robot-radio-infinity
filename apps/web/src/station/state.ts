import type { MusicalIntent, StationState } from "@robot-radio/shared";

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
    playback: {
      trackId: null,
      title: null,
      playheadMs: 0,
      durationMs: null,
      remainingMs: null,
      bufferedMs: 0
    },
    intent: DEFAULT_INTENT,
    nextTrack: {
      status: "none",
      bufferedMs: 0,
      generatedMs: 0
    },
    continuity: {
      status: "none",
      bufferedMs: 0,
      audible: false
    },
    dj: { speaking: false },
    recentEvents: [],
    recentCommands: [],
    recentTrackSummaries: [],
    recentUserMessages: [],
    horizonFiredForTrackId: null
  };
}
