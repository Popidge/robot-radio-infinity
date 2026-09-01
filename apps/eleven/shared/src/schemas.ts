import { z } from "zod";

export const musicalIntentSchema = z.object({
  description: z.string().min(1).max(500),
  styles: z.array(z.string().min(1).max(100)).min(1).max(8),
  mood: z.array(z.string().min(1).max(100)).min(1).max(8),
  energy: z.number().min(0).max(1).optional(),
  bpmRange: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  keyPreference: z.string().max(60).optional(),
  vocals: z.string().max(500).optional(),
  language: z.string().max(60).optional()
});

export const musicalSnapshotSchema = z.object({
  title: z.string().optional(), styleSummary: z.string(), bpm: z.number().optional(), key: z.string().optional(), energy: z.number().min(0).max(1).optional(),
  presentationFacts: z.array(z.string().min(1).max(300)).max(8).optional()
});

export const trackSectionSchema = z.object({
  name: z.string().min(1).max(80), durationMs: z.number().int().positive(), description: z.string().min(1).max(800),
  lyrics: z.string().max(2_000).optional(), transitionFriendly: z.boolean().optional()
});

export const trackDirectiveSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(800),
  styles: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
  mood: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
  energy: z.number().min(0).max(1).optional(),
  bpm: z.number().positive().optional(),
  key: z.string().max(60).optional(),
  vocals: z.string().max(500).optional(),
  language: z.string().max(60).optional(),
  durationMs: z.number().int().positive().optional(),
  sections: z.array(trackSectionSchema).min(1).max(12).optional(),
  editorialNotes: z.array(z.string().min(1).max(300)).max(8).optional()
});

export const trackSpecSchema = trackDirectiveSchema.extend({
  id: z.string(), programmeId: z.string(), revision: z.number().int().nonnegative(), styles: z.array(z.string()), mood: z.array(z.string()),
  energy: z.number().min(0).max(1), bpm: z.number().positive(), key: z.string(), durationMs: z.number().int().positive()
});

export const transitionSketchSchema = z.object({
  description: z.string().min(1).max(500), sourceSummary: z.string().min(1).max(300),
  destinationSketch: z.string().min(1).max(300), energyDirection: z.enum(["down", "steady", "up"])
});

export const transitionSpecSchema = z.object({
  id: z.string(), programmeId: z.string(), revision: z.number().int().nonnegative(), description: z.string().min(1).max(800),
  sourceSummary: z.string().min(1).max(500), destinationSummary: z.string().min(1).max(500),
  styles: z.array(z.string()).min(1).max(8), mood: z.array(z.string()).min(1).max(8), energy: z.number().min(0).max(1),
  bpm: z.number().positive(), durationMs: z.number().int().positive(), instrumental: z.literal(true), reason: z.enum(["immediate", "underrun"])
});

export const urgencyAssessmentSchema = z.object({
  timing: z.enum(["conversation_only", "future", "next_track", "immediate"]), interruptCurrentTrack: z.boolean(),
  confidence: z.number().min(0).max(1), immediateTransition: transitionSketchSchema.optional()
});
export const recentTrackSchema = z.object({
  trackId: z.string(), title: z.string().min(1), description: z.string().min(1), bpm: z.number().positive().optional(),
  key: z.string().optional(), energy: z.number().min(0).max(1).optional()
});
export const onAirCuePurposeSchema = z.enum(["opening", "listener_acknowledgement", "back_announce", "handoff_setup", "mid_track_observation"]);
export const showStateSchema = z.object({
  presenter: z.object({
    name: z.string().min(1).max(80),
    identity: z.string().min(1).max(500),
    voiceRules: z.array(z.string().min(1).max(300)).min(1).max(8)
  }),
  listener: z.object({
    preferences: z.array(z.string().min(1).max(200)).max(8),
    dislikes: z.array(z.string().min(1).max(200)).max(8),
    callbacks: z.array(z.string().min(1).max(240)).max(6),
    notablePhrases: z.array(z.string().min(1).max(200)).max(6)
  }),
  musicalThesis: z.object({
    current: z.string().min(1).max(500),
    intendedTrajectory: z.array(z.string().min(1).max(240)).max(6)
  }),
  recentProductionFingerprints: z.array(z.string().min(1).max(300)).max(8),
  recentLinkFingerprints: z.array(z.string().min(1).max(180)).max(8),
  speechCadence: z.object({
    lastCueAt: z.number().nullable(),
    lastCuePurpose: onAirCuePurposeSchema.optional(),
    cooldownMs: z.number().int().min(10_000).max(180_000),
    sessionTalkativeness: z.number().min(0).max(1),
    cuesSpoken: z.number().int().nonnegative()
  })
});
export const showMemoryUpdatesSchema = z.object({
  listener: z.object({
    preferences: z.array(z.string().min(1).max(200)).max(4).optional(),
    dislikes: z.array(z.string().min(1).max(200)).max(4).optional(),
    callbacks: z.array(z.string().min(1).max(240)).max(3).optional(),
    notablePhrases: z.array(z.string().min(1).max(200)).max(3).optional()
  }).optional(),
  musicalThesis: z.string().min(1).max(500).optional(),
  intendedTrajectory: z.array(z.string().min(1).max(240)).max(6).optional(),
  productionFingerprint: z.string().min(1).max(300).optional(),
  sessionTalkativeness: z.number().min(0).max(1).optional()
});
export const producerPlanSchema = z.object({
  musicalDirection: z.object({ intent: musicalIntentSchema, nextTrack: trackDirectiveSchema.omit({ editorialNotes: true }) }),
  onAirCue: z.object({
    text: z.string().min(1).max(400),
    purpose: onAirCuePurposeSchema,
    linkFingerprint: z.string().min(1).max(180)
  }).optional(),
  memoryUpdates: showMemoryUpdatesSchema,
  editorialNotes: z.array(z.string().min(1).max(300)).max(8),
  suggestedTiming: z.enum(["opening", "conversation_only", "future", "next_track", "immediate", "continuity"])
});
export const initialIntentInputSchema = z.object({ requestId: z.string(), message: z.string().min(1).max(600), showState: showStateSchema });
export const urgencyInputSchema = z.object({
  requestId: z.string(), message: z.string(), currentIntent: musicalIntentSchema, currentTrack: musicalSnapshotSchema.nullable()
});
export const userIntentInputSchema = urgencyInputSchema.extend({
  remainingMs: z.number().nullable(), showState: showStateSchema
});
export const continuityInputSchema = z.object({
  requestId: z.string(), currentIntent: musicalIntentSchema, currentTrack: musicalSnapshotSchema.nullable(),
  showState: showStateSchema,
  autonomy: z.object({
    mode: z.enum(["interactive", "cruise", "exploratory"]),
    tracksSinceListener: z.number().int().nonnegative(),
    silenceMs: z.number().nonnegative()
  })
});
export const trackRepairInputSchema = z.object({
  requestId: z.string(), attempt: z.number().int().min(1).max(3), rejectedSpec: trackSpecSchema,
  providerError: z.string().min(1).max(4_000), currentIntent: musicalIntentSchema
});
export const trackRepairPlanSchema = z.object({ track: trackDirectiveSchema });
export const ttsRequestSchema = z.object({ id: z.string(), text: z.string().min(1).max(600) });
