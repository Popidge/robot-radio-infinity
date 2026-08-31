import { z } from "zod";

export const musicalIntentSchema = z.object({
  description: z.string().min(1).max(300),
  styles: z.array(z.string().min(1).max(80)).min(1).max(8),
  mood: z.array(z.string().min(1).max(80)).min(1).max(8),
  energy: z.number().min(0).max(1).optional(),
  bpmRange: z.tuple([z.number(), z.number()]).optional(),
  keyPreference: z.string().max(60).optional(),
  vocals: z.string().optional(),
  language: z.string().max(60).optional(),
  djTalkativeness: z.number().min(0).max(1).optional()
});

export const musicalSnapshotSchema = z.object({
  title: z.string().optional(),
  styleSummary: z.string(),
  bpm: z.number().optional(),
  key: z.string().optional(),
  energy: z.number().min(0).max(1).optional()
});

export const trackDirectiveSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).max(400),
  styles: z.array(z.string().min(1).max(80)).min(1).max(8).optional(),
  mood: z.array(z.string().min(1).max(80)).min(1).max(8).optional(),
  energy: z.number().min(0).max(1).optional(),
  bpm: z.number().positive().optional(),
  key: z.string().max(60).optional(),
  vocals: z.string().optional(),
  language: z.string().max(60).optional(),
  durationMs: z.number().positive().optional()
});

export const urgencyAssessmentSchema = z.object({
  timing: z.enum(["conversation_only", "future", "next_track", "immediate"]),
  interruptCurrentTrack: z.boolean(),
  confidence: z.number().min(0).max(1)
});

export const lyriaKeyframeSchema = z.object({
  at: z.number().min(0).max(1),
  description: z.string(),
  energy: z.number().min(0).max(1).optional(),
  bpm: z.number().positive().optional(),
  key: z.string().optional()
});

export const userIntentPlanSchema = z.object({
  destinationIntent: musicalIntentSchema,
  nextTrack: trackDirectiveSchema,
  transition: z.object({
    sourceSummary: z.string().min(1).max(300),
    destinationSummary: z.string().min(1).max(300),
    suggestedDurationMs: z.number().positive(),
    lyriaKeyframes: z.array(lyriaKeyframeSchema).optional()
  }),
  dj: z.object({ speak: z.boolean(), text: z.string().max(300).optional() })
});

export const initialIntentInputSchema = z.object({
  requestId: z.string(),
  message: z.string().min(1).max(600)
});

export const initialIntentPlanSchema = z.object({
  intent: musicalIntentSchema,
  firstTrackTitle: z.string().min(1)
});

export const recentTrackSchema = z.object({
  trackId: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  bpm: z.number().positive().optional(),
  key: z.string().optional(),
  energy: z.number().min(0).max(1).optional()
});

export const continuityPlanSchema = z.object({
  intentPatch: musicalIntentSchema.partial().optional(),
  nextTrack: trackDirectiveSchema,
  transition: z.object({ type: z.enum(["simple_fade", "dj_link", "lyria_bridge"]) }),
  dj: z.object({ speak: z.boolean(), text: z.string().optional() }).optional()
});

export const urgencyInputSchema = z.object({
  requestId: z.string(),
  message: z.string(),
  currentIntent: musicalIntentSchema,
  currentTrack: musicalSnapshotSchema.nullable()
});

export const userIntentInputSchema = urgencyInputSchema.extend({
  remainingMs: z.number().nullable(),
  recentTracks: z.array(recentTrackSchema).max(8),
  recentUserMessages: z.array(z.string()).max(8),
  recentDjLines: z.array(z.string()).max(8)
});

export const continuityInputSchema = z.object({
  requestId: z.string(),
  currentIntent: musicalIntentSchema,
  currentTrack: musicalSnapshotSchema.nullable(),
  recentTracks: z.array(recentTrackSchema).max(8),
  recentUserMessages: z.array(z.string()).max(8),
  recentDjLines: z.array(z.string()).max(8)
});

export const trackSpecSchema = trackDirectiveSchema.extend({
  id: z.string(),
  styles: z.array(z.string()),
  mood: z.array(z.string()),
  energy: z.number().min(0).max(1),
  bpm: z.number().positive(),
  key: z.string(),
  durationMs: z.number().positive()
});

export const trackRepairInputSchema = z.object({
  requestId: z.string(),
  attempt: z.number().int().min(1).max(3),
  rejectedSpec: trackSpecSchema,
  providerError: z.string().min(1).max(4_000),
  currentIntent: musicalIntentSchema
});

export const trackRepairPlanSchema = z.object({
  track: trackDirectiveSchema
});

export const lyriaStartSchema = z.object({ id: z.string(), seed: musicalSnapshotSchema });
export const lyriaSteerSchema = z.object({
  sourceSummary: z.string(),
  destinationSummary: z.string(),
  durationMs: z.number().positive(),
  keyframes: z.array(lyriaKeyframeSchema).optional()
});
export const ttsRequestSchema = z.object({ id: z.string(), text: z.string().min(1).max(600) });
