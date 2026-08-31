import { z } from "zod";

export const musicalIntentSchema = z.object({
  description: z.string().min(1).max(500),
  styles: z.array(z.string().min(1).max(100)).min(1).max(8),
  mood: z.array(z.string().min(1).max(100)).min(1).max(8),
  energy: z.number().min(0).max(1).optional(),
  bpmRange: z.tuple([z.number().positive(), z.number().positive()]).optional(),
  keyPreference: z.string().max(60).optional(),
  vocals: z.string().max(500).optional(),
  language: z.string().max(60).optional(),
  djTalkativeness: z.number().min(0).max(1).optional()
});

export const musicalSnapshotSchema = z.object({
  title: z.string().optional(), styleSummary: z.string(), bpm: z.number().optional(), key: z.string().optional(), energy: z.number().min(0).max(1).optional()
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
  sections: z.array(trackSectionSchema).min(1).max(12).optional()
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
export const userIntentPlanSchema = z.object({ destinationIntent: musicalIntentSchema, nextTrack: trackDirectiveSchema });
export const initialIntentInputSchema = z.object({ requestId: z.string(), message: z.string().min(1).max(600) });
export const initialIntentPlanSchema = z.object({ intent: musicalIntentSchema, firstTrack: trackDirectiveSchema });

export const recentTrackSchema = z.object({
  trackId: z.string(), title: z.string().min(1), description: z.string().min(1), bpm: z.number().positive().optional(),
  key: z.string().optional(), energy: z.number().min(0).max(1).optional()
});
export const continuityPlanSchema = z.object({
  intentPatch: musicalIntentSchema.partial().optional(), nextTrack: trackDirectiveSchema,
  transition: z.object({ type: z.enum(["simple_fade", "dj_link"]) })
});
export const urgencyInputSchema = z.object({
  requestId: z.string(), message: z.string(), currentIntent: musicalIntentSchema, currentTrack: musicalSnapshotSchema.nullable()
});
export const userIntentInputSchema = urgencyInputSchema.extend({
  remainingMs: z.number().nullable(), recentTracks: z.array(recentTrackSchema).max(8),
  recentUserMessages: z.array(z.string()).max(8), recentDjLines: z.array(z.string()).max(8)
});
export const continuityInputSchema = z.object({
  requestId: z.string(), currentIntent: musicalIntentSchema, currentTrack: musicalSnapshotSchema.nullable(),
  recentTracks: z.array(recentTrackSchema).max(8), recentUserMessages: z.array(z.string()).max(8), recentDjLines: z.array(z.string()).max(8)
});

export const djLineInputSchema = z.object({
  requestId: z.string(), userMessage: z.string().max(600).optional(),
  reason: z.enum(["startup", "user_change", "track_change", "conversation"]), currentIntent: musicalIntentSchema,
  currentTrack: musicalSnapshotSchema.nullable(), nextTrack: trackDirectiveSchema.optional(), recentTracks: z.array(recentTrackSchema).max(8),
  recentUserMessages: z.array(z.string()).max(8), recentDjLines: z.array(z.string()).max(8)
});
export const djLinePlanSchema = z.object({ speak: z.boolean(), text: z.string().min(1).max(400).optional() });
export const trackRepairInputSchema = z.object({
  requestId: z.string(), attempt: z.number().int().min(1).max(3), rejectedSpec: trackSpecSchema,
  providerError: z.string().min(1).max(4_000), currentIntent: musicalIntentSchema
});
export const trackRepairPlanSchema = z.object({ track: trackDirectiveSchema });
export const ttsRequestSchema = z.object({ id: z.string(), text: z.string().min(1).max(600) });
