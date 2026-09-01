import type { AutonomyMode } from "./contracts";

export const CRUISE_TRACK_THRESHOLD = 2;
export const EXPLORATORY_TRACK_THRESHOLD = 4;
export const CRUISE_SILENCE_MS = 8 * 60_000;
export const EXPLORATORY_SILENCE_MS = 18 * 60_000;
export const AUTONOMOUS_CUE_INTERVAL_MS = 8 * 60_000;

export interface AutonomyThresholdInput {
  tracksSinceListener: number;
  silenceMs: number;
}

export function selectAutonomyMode(input: AutonomyThresholdInput): AutonomyMode {
  if (input.tracksSinceListener >= EXPLORATORY_TRACK_THRESHOLD || input.silenceMs >= EXPLORATORY_SILENCE_MS) {
    return "exploratory";
  }
  if (input.tracksSinceListener >= CRUISE_TRACK_THRESHOLD || input.silenceMs >= CRUISE_SILENCE_MS) {
    return "cruise";
  }
  return "interactive";
}

export interface AutonomousCuePolicyInput {
  mode: AutonomyMode;
  listenerSilenceMs: number;
  speechSilenceMs: number | null;
}

export function shouldAuthorizeAutonomousCue(input: AutonomousCuePolicyInput): boolean {
  if (input.mode === "interactive") return false;
  return (input.speechSilenceMs ?? input.listenerSilenceMs) >= AUTONOMOUS_CUE_INTERVAL_MS;
}
