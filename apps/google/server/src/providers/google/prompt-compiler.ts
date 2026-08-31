import type { LyriaTransitionPlan, MusicalSnapshot, TrackSpec } from "@robot-radio/google-shared";

function durationText(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${seconds} seconds`;
  if (remainder === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minutes and ${remainder} seconds`;
}

export function compileLyria3Prompt(spec: TrackSpec): string {
  return [
    `Create a ${durationText(spec.durationMs)} complete music track.`,
    `Working title: "${spec.title}". Use this as creative context for the composition, imagery, and any original lyrics.`,
    `Musical direction: ${spec.description}.`,
    `Styles: ${spec.styles.join(", ")}.`,
    `Mood: ${spec.mood.join(", ")}.`,
    `Tempo: ${spec.bpm} BPM. Key: ${spec.key}. Energy: ${spec.energy.toFixed(2)} on a 0 to 1 scale.`,
    spec.vocals ? `Vocals: ${spec.vocals}.` : "Instrumental only, with no vocals.",
    spec.language ? `Language: ${spec.language}.` : "",
    "Give the track a clear opening, musical development, and a clean ending. Do not imitate a named artist."
  ]
    .filter(Boolean)
    .join("\n");
}

export function compileRealtimeSeed(seed: MusicalSnapshot): string {
  return [
    seed.styleSummary,
    seed.bpm ? `${Math.round(seed.bpm)} BPM` : "",
    seed.key ?? "",
    seed.energy !== undefined ? `energy ${seed.energy.toFixed(2)}` : "",
    "instrumental continuity bed"
  ]
    .filter(Boolean)
    .join(", ");
}

export function compileRealtimeTransition(plan: LyriaTransitionPlan): string {
  const keyframes = plan.keyframes?.map((keyframe) => keyframe.description).filter(Boolean) ?? [];
  return [plan.destinationSummary, ...keyframes, "instrumental transition bed"].join(", ");
}
