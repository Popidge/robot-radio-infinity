export type StationPhase =
  | "idle"
  | "playing"
  | "generating_next"
  | "transition"
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

export interface TrackSection {
  name: string;
  durationMs: number;
  description: string;
  lyrics?: string;
  transitionFriendly?: boolean;
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
  sections?: TrackSection[];
}

export interface TrackSpec extends TrackDirective {
  id: string;
  programmeId: string;
  revision: number;
  styles: string[];
  mood: string[];
  energy: number;
  bpm: number;
  key: string;
  durationMs: number;
}

export interface TransitionSketch {
  description: string;
  sourceSummary: string;
  destinationSketch: string;
  energyDirection: "down" | "steady" | "up";
}

export interface TransitionSpec {
  id: string;
  programmeId: string;
  revision: number;
  description: string;
  sourceSummary: string;
  destinationSummary: string;
  styles: string[];
  mood: string[];
  energy: number;
  bpm: number;
  durationMs: number;
  instrumental: true;
  reason: "immediate" | "underrun";
}

export interface RecentTrack {
  trackId: string;
  title: string;
  description: string;
  bpm?: number;
  key?: string;
  energy?: number;
}

export interface UrgencyAssessment {
  timing: "conversation_only" | "future" | "next_track" | "immediate";
  interruptCurrentTrack: boolean;
  confidence: number;
  immediateTransition?: TransitionSketch;
}

export interface UserIntentPlan {
  destinationIntent: MusicalIntent;
  nextTrack: TrackDirective;
}

export interface InitialIntentInput { requestId: string; message: string }
export interface InitialIntentPlan { intent: MusicalIntent; firstTrack: TrackDirective }

export interface ContinuityPlan {
  intentPatch?: Partial<MusicalIntent>;
  nextTrack: TrackDirective;
  transition: { type: "simple_fade" | "dj_link" };
}

export interface DJLineInput {
  requestId: string;
  userMessage?: string;
  reason: "startup" | "user_change" | "track_change" | "conversation";
  currentIntent: MusicalIntent;
  currentTrack: MusicalSnapshot | null;
  nextTrack?: TrackDirective;
  recentTracks: RecentTrack[];
  recentUserMessages: string[];
  recentDjLines: string[];
}

export interface DJLinePlan { speak: boolean; text?: string }

export interface TrackRepairInput {
  requestId: string;
  attempt: number;
  rejectedSpec: TrackSpec;
  providerError: string;
  currentIntent: MusicalIntent;
}
export interface TrackRepairPlan { track: TrackDirective }

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
  revision?: number;
  spec?: TrackSpec;
  bufferedMs: number;
  generatedMs: number;
  generationRate?: number;
  firstAudioMs?: number;
  repairAttempts?: number;
  error?: string;
}

export interface TransitionState {
  status: "none" | "generating" | "buffering" | "ready" | "starting" | "audible" | "failed";
  transitionId?: string;
  revision?: number;
  spec?: TransitionSpec;
  bufferedMs: number;
  generatedMs: number;
  generationRate?: number;
  firstAudioMs?: number;
  startedAt?: number;
  minimumPlayed?: boolean;
  error?: string;
}

export interface PendingUserRequest {
  requestId: string;
  revision: number;
  message: string;
  urgency?: UrgencyAssessment;
  plan?: UserIntentPlan;
  applied: boolean;
  resolution?: "conversation" | "deferred" | "next" | "immediate";
}
export interface StartupState { requestId: string; message: string; status: "planning" | "generating" }

export interface StationState {
  phase: StationPhase;
  running: boolean;
  playback: PlaybackState;
  intent: MusicalIntent;
  intentRevision: number;
  nextTrack: NextTrackState;
  transition: TransitionState;
  dj: { speaking: boolean; speechId?: string; pending?: { speechId: string; text: string; revision: number; trackId?: string } };
  recentEvents: StationEvent[];
  recentCommands: StationCommand[];
  recentTracks: RecentTrack[];
  recentUserMessages: string[];
  recentDjLines: string[];
  horizonFiredForTrackId: string | null;
  horizonRequestId?: string;
  continuityPlanRequestId?: string;
  pendingUser?: PendingUserRequest;
  queuedDirective?: TrackDirective;
  startup?: StartupState;
  error?: string;
}

interface EventBase { at: number }
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
  | (EventBase & { type: "DJ_LINE_RECEIVED"; requestId: string; revision: number; subjectTrackId?: string; plan: DJLinePlan })
  | (EventBase & { type: "DJ_LINE_FAILED"; requestId: string; revision: number; subjectTrackId?: string; error: string })
  | (EventBase & { type: "TRACK_REPAIR_RECEIVED"; failedTrackId: string; requestId: string; attempt: number; plan: TrackRepairPlan })
  | (EventBase & { type: "TRACK_REPAIR_FAILED"; failedTrackId: string; requestId: string; error: string })
  | (EventBase & { type: "TRACK_GENERATION_STARTED"; trackId: string; revision: number; spec: TrackSpec })
  | (EventBase & { type: "TRACK_FIRST_AUDIO"; trackId: string; revision: number; latencyMs: number })
  | (EventBase & { type: "TRACK_BUFFER_UPDATED"; trackId: string; revision: number; bufferedMs: number; generatedMs: number; generationRate: number })
  | (EventBase & { type: "TRACK_DURATION_RESOLVED"; trackId: string; revision: number; durationMs: number })
  | (EventBase & { type: "TRACK_READY"; trackId: string; revision: number })
  | (EventBase & { type: "TRACK_GENERATION_FAILED"; trackId: string; revision: number; error: string })
  | (EventBase & { type: "TRANSITION_GENERATION_STARTED"; transitionId: string; revision: number; spec: TransitionSpec })
  | (EventBase & { type: "TRANSITION_FIRST_AUDIO"; transitionId: string; revision: number; latencyMs: number })
  | (EventBase & { type: "TRANSITION_BUFFER_UPDATED"; transitionId: string; revision: number; bufferedMs: number; generatedMs: number; generationRate: number })
  | (EventBase & { type: "TRANSITION_READY"; transitionId: string; revision: number })
  | (EventBase & { type: "TRANSITION_GENERATION_FAILED"; transitionId: string; revision: number; error: string })
  | (EventBase & { type: "TRANSITION_STARTED"; transitionId: string; revision: number })
  | (EventBase & { type: "TRANSITION_MINIMUM_PLAYED"; transitionId: string; revision: number })
  | (EventBase & { type: "TRANSITION_ENDED"; transitionId: string; revision: number })
  | (EventBase & { type: "TTS_STARTED"; speechId: string })
  | (EventBase & { type: "TTS_FINISHED"; speechId: string })
  | (EventBase & { type: "TRACK_STARTED"; trackId: string; revision: number; spec: TrackSpec })
  | (EventBase & { type: "TRACK_PROGRESS"; trackId: string; playheadMs: number; remainingMs: number; bufferedMs: number })
  | (EventBase & { type: "TRACK_ENDED"; trackId: string });

export type FadeSource = "silence" | "track" | "transition";
export type FadeTarget = "track" | "transition";
export type StationCommand =
  | { type: "GENERATE_TRACK"; spec: TrackSpec }
  | { type: "CANCEL_TRACK"; trackId: string; afterMs?: number }
  | { type: "GENERATE_TRANSITION"; spec: TransitionSpec }
  | { type: "CANCEL_TRANSITION"; transitionId: string; afterMs?: number }
  | { type: "PLAN_INITIAL_INTENT"; input: InitialIntentInput }
  | { type: "ASSESS_USER_MESSAGE"; input: UrgencyInput }
  | { type: "PLAN_USER_INTENT"; input: UserIntentInput }
  | { type: "PLAN_CONTINUITY"; input: ContinuityInput }
  | { type: "PLAN_DJ_LINE"; revision: number; subjectTrackId?: string; input: DJLineInput }
  | { type: "REPAIR_TRACK_SPEC"; failedTrackId: string; input: TrackRepairInput }
  | { type: "SPEAK"; speechId: string; text: string }
  | { type: "FADE"; from: FadeSource; to: FadeTarget; trackId?: string; transitionId?: string; durationMs: number }
  | { type: "PLAY_TRACK"; trackId: string; durationMs: number }
  | { type: "PLAY_TRANSITION"; transitionId: string; durationMs: number; minimumPlayMs: number }
  | { type: "STOP_ALL" };

export interface StreamDescription { id: string; sampleRate: number; channels: number; durationMs: number | null }
export interface MusicStream extends StreamDescription { chunks: AsyncIterable<Float32Array> }
export interface AudioStream extends StreamDescription { chunks: AsyncIterable<Float32Array> }
export interface MusicProvider { generate(spec: TrackSpec, generationRate: number): Promise<MusicStream>; cancel(id: string): Promise<void> }
export interface TransitionProvider { generate(spec: TransitionSpec, generationRate: number): Promise<MusicStream>; cancel(id: string): Promise<void> }
export interface TTSProvider { speak(id: string, text: string): Promise<AudioStream>; cancel(id: string): Promise<void> }
export interface LLMProvider {
  planInitialIntent(input: InitialIntentInput): Promise<InitialIntentPlan>;
  assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment>;
  planUserIntent(input: UserIntentInput): Promise<UserIntentPlan>;
  planContinuity(input: ContinuityInput): Promise<ContinuityPlan>;
  planDjLine(input: DJLineInput): Promise<DJLinePlan>;
  repairTrackSpec(input: TrackRepairInput): Promise<TrackRepairPlan>;
}

// Inactive Google adapters still compile against these types, but station logic no longer uses them.
export interface LyriaKeyframe { at: number; description: string; energy?: number; bpm?: number; key?: string }
export interface LyriaTransitionPlan { sourceSummary: string; destinationSummary: string; durationMs: number; keyframes?: LyriaKeyframe[] }
export interface ContinuityStream extends StreamDescription { chunks: AsyncIterable<Float32Array> }
export interface ContinuityProvider { start(id: string, seed: MusicalSnapshot): Promise<ContinuityStream>; steer(id: string, plan: LyriaTransitionPlan): Promise<void>; stop(id: string): Promise<void> }
