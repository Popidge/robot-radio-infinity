export type StationPhase =
  | "idle"
  | "playing"
  | "generating_next"
  | "lyria_bridge"
  | "handoff"
  | "error";

export interface MusicalIntent {
  description: string;
  styles: string[];
  mood: string[];
  energy?: number;
  bpmRange?: [number, number];
  keyPreference?: string;
  vocals?: string;
  language?: string;
  djTalkativeness?: number;
}

export interface MusicalSnapshot {
  title?: string;
  styleSummary: string;
  bpm?: number;
  key?: string;
  energy?: number;
}

export interface TrackDirective {
  title: string;
  description: string;
  styles?: string[];
  mood?: string[];
  energy?: number;
  bpm?: number;
  key?: string;
  vocals?: string;
  language?: string;
  durationMs?: number;
}

export interface TrackSpec extends TrackDirective {
  id: string;
  styles: string[];
  mood: string[];
  energy: number;
  bpm: number;
  key: string;
  durationMs: number;
}

export interface RecentTrack {
  trackId: string;
  title: string;
  description: string;
  bpm?: number;
  key?: string;
  energy?: number;
}

export interface LyriaKeyframe {
  at: number;
  description: string;
  energy?: number;
  bpm?: number;
  key?: string;
}

export interface LyriaTransitionPlan {
  sourceSummary: string;
  destinationSummary: string;
  durationMs: number;
  keyframes?: LyriaKeyframe[];
}

export interface UrgencyAssessment {
  timing: "conversation_only" | "future" | "next_track" | "immediate";
  interruptCurrentTrack: boolean;
  confidence: number;
}

export interface UserIntentPlan {
  destinationIntent: MusicalIntent;
  nextTrack: TrackDirective;
  transition: {
    sourceSummary: string;
    destinationSummary: string;
    suggestedDurationMs: number;
    lyriaKeyframes?: LyriaKeyframe[];
  };
  dj: {
    speak: boolean;
    text?: string;
  };
}

export interface InitialIntentInput {
  requestId: string;
  message: string;
}

export interface InitialIntentPlan {
  intent: MusicalIntent;
  firstTrackTitle: string;
}

export interface ContinuityPlan {
  intentPatch?: Partial<MusicalIntent>;
  nextTrack: TrackDirective;
  transition: {
    type: "simple_fade" | "dj_link" | "lyria_bridge";
  };
  dj?: {
    speak: boolean;
    text?: string;
  };
}

export interface TrackRepairInput {
  requestId: string;
  attempt: number;
  rejectedSpec: TrackSpec;
  providerError: string;
  currentIntent: MusicalIntent;
}

export interface TrackRepairPlan {
  track: TrackDirective;
}

export interface UrgencyInput {
  requestId: string;
  message: string;
  currentIntent: MusicalIntent;
  currentTrack: MusicalSnapshot | null;
}

export interface UserIntentInput extends UrgencyInput {
  remainingMs: number | null;
  recentTracks: RecentTrack[];
  recentUserMessages: string[];
  recentDjLines: string[];
}

export interface ContinuityInput {
  requestId: string;
  currentIntent: MusicalIntent;
  currentTrack: MusicalSnapshot | null;
  recentTracks: RecentTrack[];
  recentUserMessages: string[];
  recentDjLines: string[];
}

export interface PlaybackState {
  trackId: string | null;
  title: string | null;
  playheadMs: number;
  durationMs: number | null;
  remainingMs: number | null;
  bpm?: number;
  key?: string;
  styleSummary?: string;
  energy?: number;
  bufferedMs: number;
}

export interface NextTrackState {
  status: "none" | "planning" | "generating" | "buffering" | "ready" | "failed";
  trackId?: string;
  spec?: TrackSpec;
  bufferedMs: number;
  generatedMs: number;
  generationRate?: number;
  firstAudioMs?: number;
  repairAttempts?: number;
  error?: string;
}

export interface ContinuityState {
  status: "none" | "starting" | "buffering" | "healthy" | "committed" | "failed";
  streamId?: string;
  bufferedMs: number;
  audible: boolean;
  seed?: MusicalSnapshot;
  target?: MusicalIntent;
  leases?: Array<"startup" | "user" | "horizon">;
  bridgeStartedAt?: number;
  bridgeDurationMs?: number;
  error?: string;
}

export interface PendingUserRequest {
  requestId: string;
  message: string;
  urgency?: UrgencyAssessment;
  plan?: UserIntentPlan;
  applied: boolean;
  resolution?: "conversation" | "deferred" | "promoted" | "immediate";
}

export interface StartupState {
  requestId: string;
  message: string;
  status: "planning" | "generating" | "bridging";
}

export interface StationState {
  phase: StationPhase;
  running: boolean;
  playback: PlaybackState;
  intent: MusicalIntent;
  nextTrack: NextTrackState;
  continuity: ContinuityState;
  dj: { speaking: boolean };
  recentEvents: StationEvent[];
  recentCommands: StationCommand[];
  recentTracks: RecentTrack[];
  recentUserMessages: string[];
  recentDjLines: string[];
  horizonFiredForTrackId: string | null;
  continuityPlanRequestId?: string;
  pendingUser?: PendingUserRequest;
  queuedDirective?: TrackDirective;
  startup?: StartupState;
  transitionFragment?: NextTrackState;
  transitionFragmentDue?: boolean;
  pendingBridgeSpeech?: { speechId: string; text: string };
  error?: string;
}

interface EventBase {
  at: number;
}

export type StationEvent =
  | (EventBase & { type: "START_STATION"; sessionId: string; message: string })
  | (EventBase & { type: "STOP_STATION" })
  | (EventBase & { type: "INITIAL_INTENT_RECEIVED"; requestId: string; plan: InitialIntentPlan })
  | (EventBase & { type: "INITIAL_INTENT_FAILED"; requestId: string; error: string })
  | (EventBase & { type: "USER_MESSAGE"; requestId: string; message: string })
  | (EventBase & { type: "NEXT_TRACK_HORIZON"; requestId: string; trackId: string })
  | (EventBase & { type: "URGENCY_ASSESSMENT_RECEIVED"; requestId: string; assessment: UrgencyAssessment })
  | (EventBase & { type: "URGENCY_ASSESSMENT_FAILED"; requestId: string; error: string })
  | (EventBase & { type: "USER_PLAN_RECEIVED"; requestId: string; plan: UserIntentPlan })
  | (EventBase & { type: "USER_PLAN_FAILED"; requestId: string; error: string })
  | (EventBase & { type: "CONTINUITY_PLAN_RECEIVED"; requestId: string; plan: ContinuityPlan })
  | (EventBase & { type: "CONTINUITY_PLAN_FAILED"; requestId: string; error: string })
  | (EventBase & { type: "TRACK_REPAIR_RECEIVED"; failedTrackId: string; requestId: string; attempt: number; plan: TrackRepairPlan })
  | (EventBase & { type: "TRACK_REPAIR_FAILED"; failedTrackId: string; requestId: string; error: string })
  | (EventBase & { type: "TRACK_GENERATION_STARTED"; trackId: string; spec: TrackSpec })
  | (EventBase & { type: "TRACK_FIRST_AUDIO"; trackId: string; latencyMs: number })
  | (EventBase & {
      type: "TRACK_BUFFER_UPDATED";
      trackId: string;
      bufferedMs: number;
      generatedMs: number;
      generationRate: number;
    })
  | (EventBase & { type: "TRACK_DURATION_RESOLVED"; trackId: string; durationMs: number })
  | (EventBase & { type: "TRACK_READY"; trackId: string })
  | (EventBase & { type: "TRACK_GENERATION_FAILED"; trackId: string; error: string })
  | (EventBase & { type: "LYRIA_STARTED"; streamId: string; seed: MusicalSnapshot })
  | (EventBase & { type: "LYRIA_BUFFER_UPDATED"; streamId: string; bufferedMs: number })
  | (EventBase & { type: "LYRIA_HEALTHY"; streamId: string })
  | (EventBase & { type: "LYRIA_FAILED"; streamId?: string; error: string })
  | (EventBase & { type: "TTS_STARTED"; speechId: string })
  | (EventBase & { type: "TTS_FINISHED"; speechId: string })
  | (EventBase & { type: "TRACK_STARTED"; trackId: string; spec: TrackSpec })
  | (EventBase & { type: "TRACK_FRAGMENT_STARTED"; trackId: string; fragmentMs: number })
  | (EventBase & { type: "TRACK_FRAGMENT_ENDED"; trackId: string })
  | (EventBase & {
      type: "TRACK_PROGRESS";
      trackId: string;
      playheadMs: number;
      remainingMs: number;
      bufferedMs: number;
    })
  | (EventBase & { type: "TRACK_ENDED"; trackId: string });

export type FadeSource = "silence" | "track" | "lyria";
export type FadeTarget = "track" | "lyria";

export type StationCommand =
  | { type: "PREWARM_CONTINUITY"; seed: MusicalSnapshot }
  | { type: "RELEASE_CONTINUITY"; afterMs?: number }
  | { type: "COMMIT_CONTINUITY" }
  | { type: "STEER_CONTINUITY"; plan: LyriaTransitionPlan }
  | { type: "GENERATE_TRACK"; spec: TrackSpec }
  | { type: "CANCEL_TRACK"; trackId: string; afterMs?: number }
  | { type: "PLAN_INITIAL_INTENT"; input: InitialIntentInput }
  | { type: "ASSESS_USER_MESSAGE"; input: UrgencyInput }
  | { type: "PLAN_USER_INTENT"; input: UserIntentInput }
  | { type: "PLAN_CONTINUITY"; input: ContinuityInput }
  | { type: "REPAIR_TRACK_SPEC"; failedTrackId: string; input: TrackRepairInput }
  | { type: "SPEAK"; speechId: string; text: string }
  | { type: "FADE"; from: FadeSource; to: FadeTarget; trackId?: string; durationMs: number }
  | { type: "PLAY_TRACK"; trackId: string; fadeMs: number }
  | { type: "PLAY_TRACK_FRAGMENT"; trackId: string; fadeMs: number; fragmentMs: number }
  | { type: "STOP_ALL" };

export interface StreamDescription {
  id: string;
  sampleRate: number;
  channels: number;
  durationMs: number | null;
}

export interface MusicProvider {
  generate(spec: TrackSpec, generationRate: number): Promise<MusicStream>;
  cancel(id: string): Promise<void>;
}

export interface MusicStream extends StreamDescription {
  chunks: AsyncIterable<Float32Array>;
}

export interface ContinuityProvider {
  start(id: string, seed: MusicalSnapshot): Promise<ContinuityStream>;
  steer(id: string, plan: LyriaTransitionPlan): Promise<void>;
  stop(id: string): Promise<void>;
}

export interface ContinuityStream extends StreamDescription {
  chunks: AsyncIterable<Float32Array>;
}

export interface TTSProvider {
  speak(id: string, text: string): Promise<AudioStream>;
}

export interface AudioStream extends StreamDescription {
  chunks: AsyncIterable<Float32Array>;
}

export interface LLMProvider {
  planInitialIntent(input: InitialIntentInput): Promise<InitialIntentPlan>;
  assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment>;
  planUserIntent(input: UserIntentInput): Promise<UserIntentPlan>;
  planContinuity(input: ContinuityInput): Promise<ContinuityPlan>;
  repairTrackSpec(input: TrackRepairInput): Promise<TrackRepairPlan>;
}
