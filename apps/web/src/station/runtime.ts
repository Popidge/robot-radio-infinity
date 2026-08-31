import type { StationCommand, StationEvent, StationState, TrackSpec, TransitionSpec } from "@robot-radio/shared";
import { AudioEngine } from "../audio/audio-engine";
import { ServerClient, type RemoteStream, type StationDebugState } from "../services/server-client";
import { NEXT_TRACK_HORIZON_MS, SAFE_START_BUFFER_MS, TRANSITION_SAFE_BUFFER_MS, reduce } from "./reducer";
import { createInitialState } from "./state";

type Listener = (state: StationState) => void;

interface GeneratedRuntime<TSpec extends { id: string; revision: number; durationMs: number }> {
  spec: TSpec;
  stream: RemoteStream;
  startedAt: number;
  generatedMs: number;
  firstAudio: boolean;
  ready: boolean;
  lastUpdateAt: number;
}

function nowEvent<T extends Omit<StationEvent, "at">>(event: T): StationEvent {
  return { ...event, at: Date.now() } as StationEvent;
}

export class StationRuntime {
  private state: StationState = createInitialState();
  private readonly listeners = new Set<Listener>();
  private readonly audio = new AudioEngine();
  private readonly client = new ServerClient();
  private readonly tracks = new Map<string, GeneratedRuntime<TrackSpec>>();
  private readonly transitions = new Map<string, GeneratedRuntime<TransitionSpec>>();
  private readonly specs = new Map<string, TrackSpec>();
  private readonly ttsStreams = new Map<string, RemoteStream>();
  private readonly transitionMinimumTimers = new Map<string, number>();
  private progressTimer: number | null = null;
  private endedTrackId: string | null = null;
  private idCounter = 0;
  private debugSequence = 0;
  private slowGeneration = false;

  getSnapshot = (): StationState => this.state;
  subscribe = (listener: Listener): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) };

  async start(message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return;
    await this.audio.initialize();
    if (this.state.running) return;
    this.progressTimer = window.setInterval(() => this.emitProgress(), 250);
    this.dispatch(nowEvent({ type: "START_STATION", sessionId: this.nextId("session"), message: trimmed }));
  }

  stop(): void { this.dispatch(nowEvent({ type: "STOP_STATION" })); this.client.flushDebugTransitions() }
  sendUserMessage(message: string): void {
    const trimmed = message.trim();
    if (trimmed && this.state.running) this.dispatch(nowEvent({ type: "USER_MESSAGE", requestId: this.nextId("user"), message: trimmed }));
  }
  setSlowGeneration(enabled: boolean): void { this.slowGeneration = enabled }
  isSlowGeneration(): boolean { return this.slowGeneration }
  readSpectrum = (target: Uint8Array<ArrayBuffer>): boolean => this.audio.readSpectrum(target);
  spectrumBinCount = (): number => this.audio.spectrumBinCount();

  dispose(): void {
    if (this.progressTimer !== null) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
    void this.execute({ type: "STOP_ALL" });
    this.listeners.clear();
  }

  private dispatch(event: StationEvent): void {
    const result = reduce(this.state, event);
    this.state = result.state;
    this.debugSequence += 1;
    this.client.logStationTransition({ sequence: this.debugSequence, clientAt: Date.now(), event, commands: result.commands, state: this.debugState() });
    for (const listener of this.listeners) listener(this.state);
    for (const command of result.commands) void this.execute(command);
  }

  private debugState(): StationDebugState {
    return {
      phase: this.state.phase,
      running: this.state.running,
      error: this.state.error,
      playback: this.state.playback,
      intent: this.state.intent,
      nextTrack: this.state.nextTrack,
      transition: this.state.transition,
      dj: this.state.dj,
      pendingUser: this.state.pendingUser,
      startup: this.state.startup,
      horizonFiredForTrackId: this.state.horizonFiredForTrackId,
      eventCount: this.state.recentEvents.length,
      commandCount: this.state.recentCommands.length
    };
  }

  private async execute(command: StationCommand): Promise<void> {
    try {
      switch (command.type) {
        case "GENERATE_TRACK": this.generateTrack(command.spec); return;
        case "CANCEL_TRACK": this.cancelTrack(command.trackId, command.afterMs ?? 0); return;
        case "GENERATE_TRANSITION": this.generateTransition(command.spec); return;
        case "CANCEL_TRANSITION": this.cancelTransition(command.transitionId, command.afterMs ?? 0); return;
        case "PLAN_INITIAL_INTENT": {
          const plan = await this.client.planInitialIntent(command.input);
          this.dispatch(nowEvent({ type: "INITIAL_INTENT_RECEIVED", requestId: command.input.requestId, plan }));
          return;
        }
        case "ASSESS_USER_MESSAGE": {
          const assessment = await this.client.assessUrgency(command.input);
          this.dispatch(nowEvent({ type: "URGENCY_ASSESSMENT_RECEIVED", requestId: command.input.requestId, assessment }));
          return;
        }
        case "PLAN_USER_INTENT": {
          const plan = await this.client.planUserIntent(command.input);
          this.dispatch(nowEvent({ type: "USER_PLAN_RECEIVED", requestId: command.input.requestId, plan }));
          return;
        }
        case "PLAN_CONTINUITY": {
          const plan = await this.client.planContinuity(command.input);
          this.dispatch(nowEvent({ type: "CONTINUITY_PLAN_RECEIVED", requestId: command.input.requestId, plan }));
          return;
        }
        case "PLAN_DJ_LINE": {
          const plan = await this.client.planDjLine(command.input);
          this.dispatch(nowEvent({ type: "DJ_LINE_RECEIVED", requestId: command.input.requestId, revision: command.revision, plan }));
          return;
        }
        case "REPAIR_TRACK_SPEC": {
          const plan = await this.client.repairTrackSpec(command.input);
          this.dispatch(nowEvent({ type: "TRACK_REPAIR_RECEIVED", failedTrackId: command.failedTrackId, requestId: command.input.requestId, attempt: command.input.attempt, plan }));
          return;
        }
        case "SPEAK": this.speak(command.speechId, command.text); return;
        case "PLAY_TRACK": this.audio.playTrack(command.trackId, command.durationMs); this.trackStarted(command.trackId); return;
        case "PLAY_TRANSITION": this.playTransition(command.transitionId, command.durationMs, command.minimumPlayMs); return;
        case "FADE":
          if (command.to === "track" && command.trackId) {
            if (command.from === "transition") this.audio.fadeTransitionToTrack(command.trackId, command.durationMs);
            else this.audio.crossfadeToTrack(command.trackId, command.durationMs);
            this.trackStarted(command.trackId);
          } else if (command.to === "transition") {
            if (command.from === "track") this.audio.fadeTrackToTransition(command.durationMs);
            else this.audio.fadeInTransition(command.durationMs);
          }
          return;
        case "STOP_ALL": await this.stopAll(); return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      switch (command.type) {
        case "PLAN_INITIAL_INTENT": this.dispatch(nowEvent({ type: "INITIAL_INTENT_FAILED", requestId: command.input.requestId, error: message })); break;
        case "ASSESS_USER_MESSAGE": this.dispatch(nowEvent({ type: "URGENCY_ASSESSMENT_FAILED", requestId: command.input.requestId, error: message })); break;
        case "PLAN_USER_INTENT": this.dispatch(nowEvent({ type: "USER_PLAN_FAILED", requestId: command.input.requestId, error: message })); break;
        case "PLAN_CONTINUITY": this.dispatch(nowEvent({ type: "CONTINUITY_PLAN_FAILED", requestId: command.input.requestId, error: message })); break;
        case "PLAN_DJ_LINE": this.dispatch(nowEvent({ type: "DJ_LINE_FAILED", requestId: command.input.requestId, revision: command.revision, error: message })); break;
        case "REPAIR_TRACK_SPEC": this.dispatch(nowEvent({ type: "TRACK_REPAIR_FAILED", failedTrackId: command.failedTrackId, requestId: command.input.requestId, error: message })); break;
        case "GENERATE_TRACK": this.dispatch(nowEvent({ type: "TRACK_GENERATION_FAILED", trackId: command.spec.id, revision: command.spec.revision, error: message })); break;
        case "GENERATE_TRANSITION": this.dispatch(nowEvent({ type: "TRANSITION_GENERATION_FAILED", transitionId: command.spec.id, revision: command.spec.revision, error: message })); break;
      }
    }
  }

  private generateTrack(spec: TrackSpec): void {
    if (this.tracks.has(spec.id)) return;
    const rate = this.slowGeneration ? 0.65 : 5;
    this.specs.set(spec.id, spec);
    this.audio.createTrack(spec.id, spec.durationMs, () => this.trackInputEnded(spec.id));
    const runtime = {} as GeneratedRuntime<TrackSpec>;
    const stream = this.client.streamMusic(spec, rate, {
      onStart: () => this.dispatch(nowEvent({ type: "TRACK_GENERATION_STARTED", trackId: spec.id, revision: spec.revision, spec })),
      onChunk: (pcm) => {
        const chunkMs = (pcm.length / 2 / 48_000) * 1_000;
        runtime.generatedMs += chunkMs;
        this.audio.enqueue(spec.id, pcm);
        const elapsedMs = Math.max(1, performance.now() - runtime.startedAt);
        const measuredRate = runtime.generatedMs / elapsedMs;
        const bufferedMs = this.audio.getBufferedMs(spec.id) || runtime.generatedMs;
        if (!runtime.firstAudio) {
          runtime.firstAudio = true;
          this.dispatch(nowEvent({ type: "TRACK_FIRST_AUDIO", trackId: spec.id, revision: spec.revision, latencyMs: elapsedMs }));
        }
        if (performance.now() - runtime.lastUpdateAt >= 220) {
          runtime.lastUpdateAt = performance.now();
          this.dispatch(nowEvent({ type: "TRACK_BUFFER_UPDATED", trackId: spec.id, revision: spec.revision, bufferedMs, generatedMs: runtime.generatedMs, generationRate: measuredRate }));
        }
        if (!runtime.ready && bufferedMs >= this.requiredBufferMs(measuredRate, spec.durationMs, SAFE_START_BUFFER_MS)) {
          runtime.ready = true;
          this.dispatch(nowEvent({ type: "TRACK_READY", trackId: spec.id, revision: spec.revision }));
        }
      },
      onEnd: () => {
        const durationMs = Math.max(1, Math.round(runtime.generatedMs));
        runtime.spec = { ...runtime.spec, durationMs };
        this.specs.set(spec.id, runtime.spec);
        this.audio.setDuration(spec.id, durationMs);
        this.dispatch(nowEvent({ type: "TRACK_DURATION_RESOLVED", trackId: spec.id, revision: spec.revision, durationMs }));
        this.audio.markInputEnded(spec.id);
        if (!runtime.ready) { runtime.ready = true; this.dispatch(nowEvent({ type: "TRACK_READY", trackId: spec.id, revision: spec.revision })) }
      },
      onError: (error) => this.dispatch(nowEvent({ type: "TRACK_GENERATION_FAILED", trackId: spec.id, revision: spec.revision, error: error.message }))
    });
    Object.assign(runtime, { spec, stream, startedAt: performance.now(), generatedMs: 0, firstAudio: false, ready: false, lastUpdateAt: 0 });
    this.tracks.set(spec.id, runtime);
  }

  private generateTransition(spec: TransitionSpec): void {
    if (this.transitions.has(spec.id)) return;
    const rate = this.slowGeneration ? 0.65 : 5;
    this.audio.createTransition(spec.id, spec.durationMs, () => this.transitionEnded(spec));
    const runtime = {} as GeneratedRuntime<TransitionSpec>;
    const stream = this.client.streamTransition(spec, rate, {
      onStart: () => this.dispatch(nowEvent({ type: "TRANSITION_GENERATION_STARTED", transitionId: spec.id, revision: spec.revision, spec })),
      onChunk: (pcm) => {
        const chunkMs = (pcm.length / 2 / 48_000) * 1_000;
        runtime.generatedMs += chunkMs;
        this.audio.enqueue(spec.id, pcm);
        const elapsedMs = Math.max(1, performance.now() - runtime.startedAt);
        const measuredRate = runtime.generatedMs / elapsedMs;
        const bufferedMs = this.audio.getBufferedMs(spec.id) || runtime.generatedMs;
        if (!runtime.firstAudio) {
          runtime.firstAudio = true;
          this.dispatch(nowEvent({ type: "TRANSITION_FIRST_AUDIO", transitionId: spec.id, revision: spec.revision, latencyMs: elapsedMs }));
        }
        if (performance.now() - runtime.lastUpdateAt >= 220) {
          runtime.lastUpdateAt = performance.now();
          this.dispatch(nowEvent({ type: "TRANSITION_BUFFER_UPDATED", transitionId: spec.id, revision: spec.revision, bufferedMs, generatedMs: runtime.generatedMs, generationRate: measuredRate }));
        }
        if (!runtime.ready && bufferedMs >= this.requiredBufferMs(measuredRate, spec.durationMs, TRANSITION_SAFE_BUFFER_MS)) {
          runtime.ready = true;
          this.dispatch(nowEvent({ type: "TRANSITION_READY", transitionId: spec.id, revision: spec.revision }));
        }
      },
      onEnd: () => {
        this.audio.markInputEnded(spec.id);
        if (!runtime.ready) { runtime.ready = true; this.dispatch(nowEvent({ type: "TRANSITION_READY", transitionId: spec.id, revision: spec.revision })) }
      },
      onError: (error) => this.dispatch(nowEvent({ type: "TRANSITION_GENERATION_FAILED", transitionId: spec.id, revision: spec.revision, error: error.message }))
    });
    Object.assign(runtime, { spec, stream, startedAt: performance.now(), generatedMs: 0, firstAudio: false, ready: false, lastUpdateAt: 0 });
    this.transitions.set(spec.id, runtime);
  }

  private requiredBufferMs(rate: number, durationMs: number, minimumMs: number): number {
    return rate >= 1 ? minimumMs : Math.min(durationMs, Math.max(minimumMs, (1 - rate) * durationMs + 1_000));
  }

  private playTransition(id: string, fadeMs: number, minimumPlayMs: number): void {
    const runtime = this.transitions.get(id);
    if (!runtime || this.state.transition.status === "audible") return;
    if (this.state.playback.trackId) this.audio.fadeTrackToTransition(fadeMs);
    else this.audio.fadeInTransition(fadeMs);
    this.dispatch(nowEvent({ type: "TRANSITION_STARTED", transitionId: id, revision: runtime.spec.revision }));
    const timer = window.setTimeout(() => {
      this.transitionMinimumTimers.delete(id);
      this.dispatch(nowEvent({ type: "TRANSITION_MINIMUM_PLAYED", transitionId: id, revision: runtime.spec.revision }));
    }, minimumPlayMs);
    this.transitionMinimumTimers.set(id, timer);
  }

  private cancelTrack(id: string, afterMs = 0): void {
    if (afterMs > 0) { window.setTimeout(() => this.cancelTrack(id), afterMs); return }
    const runtime = this.tracks.get(id);
    runtime?.stream.close();
    this.tracks.delete(id);
    this.audio.discardTrack(id);
    void this.client.cancelMusic(id);
  }

  private cancelTransition(id: string, afterMs = 0): void {
    if (afterMs > 0) { window.setTimeout(() => this.cancelTransition(id), afterMs); return }
    const timer = this.transitionMinimumTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.transitionMinimumTimers.delete(id);
    const runtime = this.transitions.get(id);
    runtime?.stream.close();
    this.transitions.delete(id);
    this.audio.discardTransition();
  }

  private speak(id: string, text: string): void {
    let started = false;
    let generatedMs = 0;
    const requestedAt = performance.now();
    const startPlayback = (): void => {
      if (started || generatedMs <= 0) return;
      started = true;
      this.audio.duckForSpeech();
      this.audio.playTTS(id);
      this.dispatch(nowEvent({ type: "TTS_STARTED", speechId: id }));
    };
    this.audio.createTTS(id, null, () => {
      this.audio.restoreAfterSpeech();
      this.audio.finishTTS(id);
      this.dispatch(nowEvent({ type: "TTS_FINISHED", speechId: id }));
      this.ttsStreams.get(id)?.close();
      this.ttsStreams.delete(id);
    });
    const stream = this.client.streamTTS(id, text, {
      onStart: () => undefined,
      onChunk: (pcm) => {
        generatedMs += (pcm.length / 2 / 48_000) * 1_000;
        this.audio.enqueue(id, pcm);
        const rate = generatedMs / Math.max(1, performance.now() - requestedAt);
        if (generatedMs >= 1_200 && rate >= 1.15) startPlayback();
      },
      onEnd: () => {
        this.audio.markInputEnded(id);
        if (generatedMs > 0) startPlayback();
        else { this.audio.finishTTS(id); this.dispatch(nowEvent({ type: "TTS_FINISHED", speechId: id })) }
      },
      onError: () => {
        this.audio.restoreAfterSpeech();
        this.audio.finishTTS(id);
        this.dispatch(nowEvent({ type: "TTS_FINISHED", speechId: id }));
        this.ttsStreams.get(id)?.close();
        this.ttsStreams.delete(id);
      }
    });
    this.ttsStreams.set(id, stream);
  }

  private trackStarted(trackId: string): void {
    const spec = this.specs.get(trackId);
    if (!spec) return;
    this.endedTrackId = null;
    this.dispatch(nowEvent({ type: "TRACK_STARTED", trackId, revision: spec.revision, spec }));
  }

  private transitionEnded(spec: TransitionSpec): void {
    if (this.state.running && this.state.transition.transitionId === spec.id && this.state.transition.status === "audible") {
      this.dispatch(nowEvent({ type: "TRANSITION_ENDED", transitionId: spec.id, revision: spec.revision }));
    }
  }

  private trackInputEnded(trackId: string): void {
    if (!this.state.running || this.state.playback.trackId !== trackId || this.endedTrackId === trackId) return;
    this.endedTrackId = trackId;
    this.dispatch(nowEvent({ type: "TRACK_ENDED", trackId }));
  }

  private emitProgress(): void {
    const progress = this.audio.getProgress();
    if (!progress || !this.state.running) return;
    this.dispatch(nowEvent({ type: "TRACK_PROGRESS", trackId: progress.trackId, playheadMs: progress.playheadMs, remainingMs: progress.remainingMs, bufferedMs: progress.bufferedMs }));
    const state = this.state;
    if (state.playback.trackId === progress.trackId && state.phase !== "handoff" && progress.remainingMs <= NEXT_TRACK_HORIZON_MS && state.horizonFiredForTrackId !== progress.trackId) {
      this.dispatch(nowEvent({ type: "NEXT_TRACK_HORIZON", requestId: this.nextId("horizon"), trackId: progress.trackId }));
    }
    if (progress.remainingMs <= 0 && this.endedTrackId !== progress.trackId) {
      this.endedTrackId = progress.trackId;
      this.dispatch(nowEvent({ type: "TRACK_ENDED", trackId: progress.trackId }));
    }
  }

  private async stopAll(): Promise<void> {
    if (this.progressTimer !== null) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
    for (const [id, runtime] of this.tracks) { runtime.stream.close(); void this.client.cancelMusic(id) }
    for (const runtime of this.transitions.values()) runtime.stream.close();
    for (const stream of this.ttsStreams.values()) stream.close();
    for (const timer of this.transitionMinimumTimers.values()) window.clearTimeout(timer);
    this.tracks.clear(); this.transitions.clear(); this.ttsStreams.clear(); this.transitionMinimumTimers.clear();
    await this.audio.stopAll();
  }

  private nextId(prefix: string): string { this.idCounter += 1; return `${prefix}-${Date.now().toString(36)}-${this.idCounter}` }
}
