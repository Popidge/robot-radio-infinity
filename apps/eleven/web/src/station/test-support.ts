import type { MusicalIntent, ProducerPlan, TrackDirective } from "@robot-radio/eleven-shared";

export function makeProducerPlan(
  intent: MusicalIntent,
  nextTrack: TrackDirective,
  overrides: Partial<ProducerPlan> = {}
): ProducerPlan {
  return {
    musicalDirection: { intent, nextTrack },
    memoryUpdates: {},
    editorialNotes: [],
    suggestedTiming: "future",
    ...overrides
  };
}
