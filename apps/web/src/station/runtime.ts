import type {
  LyriaTransitionPlan,
  MusicalSnapshot,
  StationCommand,
  StationEvent,
  StationState,
  TrackSpec
} from "@robot-radio/shared";
import { AudioEngine } from "../audio/audio-engine";
import { ServerClient, type RemoteStream, type StationDebugState } from "../services/server-client";
import {
  CONTINUITY_HEALTHY_BUFFER_MS,
  NEXT_TRACK_HORIZON_MS,
  SAFE_START_BUFFER_MS,
  reduce
} from "./reducer";
import { createInitialState } from "./state";

type Listener = (state: StationState) => void;

interface TrackRuntime {
  spec: TrackSpec;
  stream: RemoteStream;
  startedAt: number;
  generatedMs: number;
  firstAudio: boolean;
  ready: boolean;
  configuredRate: number;
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
  private readonly tracks = new Map<string, TrackRuntime>();
  private readonly specs = new Map<string, TrackSpec>();
  private lyriaStream: RemoteStream | null = null;
  private lyriaId: string | null = null;
  private lyriaGeneratedMs = 0;
  private lyriaHealthy = false;
  private lyriaStarted = false;
  private pendingLyriaPlan: LyriaTransitionPlan | null = null;
  private lyriaLastUpdateAt = 0;
  private ttsStreams = new Map<string, RemoteStream>();
  private progressTimer: number | null = null;
  private endedTrackId: string | null = null;
  private idCounter = 0;
  private debugSequence = 0;
  private readonly fragmentTimers = new Map<string, number>();
  private slowGeneration = false;

  getSnapshot = (): StationState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return;
    await this.audio.initialize();
    if (this.state.running) return;
    this.progressTimer = window.setInterval(() => this.emitProgress(), 250);
    this.dispatch(nowEvent({ type: "START_STATION", sessionId: this.nextId("session"), message: trimmed }));
  }

  stop(): void {
    this.dispatch(nowEvent({ type: "STOP_STATION" }));
    this.client.flushDebugTransitions();
  }

  sendUserMessage(message: string): void {
    const trimmed = message.trim();
    if (!trimmed || !this.state.running) return;
    this.dispatch(nowEvent({ type: "USER_MESSAGE", requestId: this.nextId("user"), message: trimmed }));
  }

  setSlowGeneration(enabled: boolean): void {
    this.slowGeneration = enabled;
  }

  isSlowGeneration(): boolean {
    return this.slowGeneration;
  }

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
    this.client.logStationTransition({
      sequence: this.debugSequence,
      clientAt: Date.now(),
      event,
      commands: result.commands,
      state: this.debugState()
    });
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
      continuity: this.state.continuity,
      dj: this.state.dj,
      pendingUser: this.state.pendingUser,
      startup: this.state.startup,
      transitionFragment: this.state.transitionFragment,
      pendingBridgeSpeech: this.state.pendingBridgeSpeech,
      horizonFiredForTrackId: this.state.horizonFiredForTrackId,
      eventCount: this.state.recentEvents.length,
      commandCount: this.state.recentCommands.length
    };
  }

  private async execute(command: StationCommand): Promise<void> {
    try {
      switch (command.type) {
        case "PREWARM_CONTINUITY":
          this.ensureContinuityPrewarm(command.seed);
          return;
        case "RELEASE_CONTINUITY":
          this.releaseContinuity(command.afterMs ?? 0);
          return;
        case "COMMIT_CONTINUITY":
          this.audio.commitContinuity();
          return;
        case "STEER_CONTINUITY":
          await this.steerContinuity(command.plan);
          return;
        case "GENERATE_TRACK":
          this.generateTrack(command.spec);
          return;
        case "CANCEL_TRACK":
          this.cancelTrack(command.trackId, command.afterMs ?? 0);
          return;
        case "PLAN_INITIAL_INTENT": {
          const plan = await this.client.planInitialIntent(command.input);
          this.dispatch(nowEvent({ type: "INITIAL_INTENT_RECEIVED", requestId: command.input.requestId, plan }));
          return;
        }
        case "ASSESS_USER_MESSAGE": {
          const assessment = await this.client.assessUrgency(command.input);
          this.dispatch(nowEvent({
            type: "URGENCY_ASSESSMENT_RECEIVED",
            requestId: command.input.requestId,
            assessment
          }));
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
        case "SPEAK":
          this.speak(command.speechId, command.text);
          return;
        case "PLAY_TRACK":
          this.audio.playTrack(command.trackId, command.fadeMs);
          this.trackStarted(command.trackId);
          return;
        case "PLAY_TRACK_FRAGMENT": {
          const spec = this.specs.get(command.trackId);
          if (!spec) throw new Error(`Transition fragment is missing its track specification: ${command.trackId}`);
          this.audio.setDuration(command.trackId, command.fragmentMs);
          this.audio.crossfadeToTrack(command.trackId, command.fadeMs);
          this.dispatch(nowEvent({ type: "TRACK_FRAGMENT_STARTED", trackId: command.trackId, fragmentMs: command.fragmentMs }));
          const oldTimer = this.fragmentTimers.get(command.trackId);
          if (oldTimer !== undefined) window.clearTimeout(oldTimer);
          const timer = window.setTimeout(() => {
            this.fragmentTimers.delete(command.trackId);
            this.dispatch(nowEvent({ type: "TRACK_FRAGMENT_ENDED", trackId: command.trackId }));
          }, command.fragmentMs);
          this.fragmentTimers.set(command.trackId, timer);
          return;
        }
        case "FADE":
          if (command.from === "silence" && command.to === "lyria") {
            this.audio.fadeInLyria(command.durationMs);
          } else if (command.from === "track" && command.to === "lyria") {
            this.audio.fadeTrackToLyria(command.durationMs);
          } else if (command.from === "lyria" && command.to === "track" && command.trackId) {
            this.audio.fadeLyriaToTrack(command.trackId, command.durationMs);
            this.trackStarted(command.trackId);
          } else if (command.from === "track" && command.to === "track" && command.trackId) {
            this.audio.crossfadeToTrack(command.trackId, command.durationMs);
            this.trackStarted(command.trackId);
          }
          return;
        case "STOP_ALL":
          await this.stopAll();
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      switch (command.type) {
        case "PLAN_INITIAL_INTENT":
          this.dispatch(nowEvent({ type: "INITIAL_INTENT_FAILED", requestId: command.input.requestId, error: message }));
          break;
        case "ASSESS_USER_MESSAGE":
          this.dispatch(nowEvent({ type: "URGENCY_ASSESSMENT_FAILED", requestId: command.input.requestId, error: message }));
          break;
        case "PLAN_USER_INTENT":
          this.dispatch(nowEvent({ type: "USER_PLAN_FAILED", requestId: command.input.requestId, error: message }));
          break;
        case "PLAN_CONTINUITY":
          this.dispatch(nowEvent({ type: "CONTINUITY_PLAN_FAILED", requestId: command.input.requestId, error: message }));
          break;
        case "GENERATE_TRACK":
          this.dispatch(nowEvent({ type: "TRACK_GENERATION_FAILED", trackId: command.spec.id, error: message }));
          break;
        case "PREWARM_CONTINUITY":
        case "STEER_CONTINUITY":
          this.dispatch(nowEvent({ type: "LYRIA_FAILED", streamId: this.lyriaId ?? undefined, error: message }));
          break;
      }
    }
  }

  private ensureContinuityPrewarm(seed: MusicalSnapshot): void {
    if (this.lyriaStream) return;
    const id = this.nextId("lyria");
    this.lyriaId = id;
    this.lyriaGeneratedMs = 0;
    this.lyriaHealthy = false;
    this.lyriaStarted = false;
    this.lyriaLastUpdateAt = 0;
    this.audio.createLyria(id);
    this.lyriaStream = this.client.streamLyria(id, seed, {
      onStart: () => {
        if (this.lyriaId !== id) return;
        this.lyriaStarted = true;
        this.dispatch(nowEvent({ type: "LYRIA_STARTED", streamId: id, seed }));
        const pendingPlan = this.pendingLyriaPlan;
        this.pendingLyriaPlan = null;
        if (pendingPlan) void this.applyContinuitySteer(id, pendingPlan);
      },
      onChunk: (pcm) => {
        if (this.lyriaId !== id) return;
        const chunkMs = (pcm.length / 2 / 48_000) * 1_000;
        this.lyriaGeneratedMs += chunkMs;
        this.audio.enqueue(id, pcm);
        const bufferedMs = this.audio.getBufferedMs(id) || this.lyriaGeneratedMs;
        const updateNow = performance.now();
        if (updateNow - this.lyriaLastUpdateAt >= 240) {
          this.lyriaLastUpdateAt = updateNow;
          this.dispatch(nowEvent({ type: "LYRIA_BUFFER_UPDATED", streamId: id, bufferedMs }));
        }
        if (!this.lyriaHealthy && bufferedMs >= CONTINUITY_HEALTHY_BUFFER_MS) {
          this.lyriaHealthy = true;
          this.dispatch(nowEvent({ type: "LYRIA_HEALTHY", streamId: id }));
        }
      },
      onEnd: () => {
        if (this.lyriaId === id) this.audio.markInputEnded(id);
      },
      onError: (error) => {
        if (this.lyriaId === id) this.dispatch(nowEvent({ type: "LYRIA_FAILED", streamId: id, error: error.message }));
      }
    });
  }

  private releaseContinuity(afterMs: number): void {
    const stream = this.lyriaStream;
    const id = this.lyriaId;
    this.lyriaStream = null;
    this.lyriaId = null;
    this.lyriaHealthy = false;
    this.lyriaStarted = false;
    this.pendingLyriaPlan = null;
    window.setTimeout(() => {
      stream?.close();
      if (id) void this.client.stopLyria(id);
    }, afterMs);
    this.audio.releaseLyria(afterMs);
  }

  private async steerContinuity(plan: LyriaTransitionPlan): Promise<void> {
    if (!this.lyriaId || !this.lyriaStarted) {
      this.pendingLyriaPlan = plan;
      return;
    }
    await this.applyContinuitySteer(this.lyriaId, plan);
  }

  private async applyContinuitySteer(streamId: string, plan: LyriaTransitionPlan): Promise<void> {
    try {
      await this.client.steerLyria(streamId, plan);
    } catch (error) {
      if (this.lyriaId !== streamId) return;
      const message = error instanceof Error ? error.message : "Continuity steering failed";
      this.dispatch(nowEvent({ type: "LYRIA_FAILED", streamId, error: message }));
    }
  }

  private generateTrack(spec: TrackSpec): void {
    if (this.tracks.has(spec.id)) return;
    const configuredRate = this.slowGeneration ? 0.65 : 2.5;
    this.specs.set(spec.id, spec);
    this.audio.createTrack(spec.id, spec.durationMs, () => this.trackInputEnded(spec.id));
    const startedAt = performance.now();
    const runtime = {} as TrackRuntime;
    const stream = this.client.streamMusic(spec, configuredRate, {
      onStart: () => this.dispatch(nowEvent({ type: "TRACK_GENERATION_STARTED", trackId: spec.id, spec })),
      onChunk: (pcm) => {
        const chunkMs = (pcm.length / 2 / 48_000) * 1_000;
        runtime.generatedMs += chunkMs;
        this.audio.enqueue(spec.id, pcm);
        const elapsedMs = Math.max(1, performance.now() - runtime.startedAt);
        const measuredRate = runtime.generatedMs / elapsedMs;
        const bufferedMs = this.audio.getBufferedMs(spec.id) || runtime.generatedMs;
        if (!runtime.firstAudio) {
          runtime.firstAudio = true;
          this.dispatch(nowEvent({ type: "TRACK_FIRST_AUDIO", trackId: spec.id, latencyMs: elapsedMs }));
        }
        const updateNow = performance.now();
        if (updateNow - runtime.lastUpdateAt >= 220) {
          runtime.lastUpdateAt = updateNow;
          this.dispatch(nowEvent({
            type: "TRACK_BUFFER_UPDATED",
            trackId: spec.id,
            bufferedMs,
            generatedMs: runtime.generatedMs,
            generationRate: measuredRate
          }));
        }
        const requiredBuffer = this.requiredBufferMs(measuredRate, spec.durationMs);
        if (!runtime.ready && bufferedMs >= requiredBuffer) {
          runtime.ready = true;
          this.dispatch(nowEvent({ type: "TRACK_READY", trackId: spec.id }));
        }
      },
      onEnd: () => {
        const durationMs = Math.max(1, Math.round(runtime.generatedMs));
        runtime.spec = { ...runtime.spec, durationMs };
        this.specs.set(spec.id, runtime.spec);
        this.audio.setDuration(spec.id, durationMs);
        this.dispatch(nowEvent({ type: "TRACK_DURATION_RESOLVED", trackId: spec.id, durationMs }));
        this.audio.markInputEnded(spec.id);
        if (!runtime.ready) {
          runtime.ready = true;
          this.dispatch(nowEvent({ type: "TRACK_READY", trackId: spec.id }));
        }
      },
      onError: (error) =>
        this.dispatch(nowEvent({ type: "TRACK_GENERATION_FAILED", trackId: spec.id, error: error.message }))
    });
    Object.assign(runtime, {
      spec,
      stream,
      startedAt,
      generatedMs: 0,
      firstAudio: false,
      ready: false,
      configuredRate,
      lastUpdateAt: 0
    });
    this.tracks.set(spec.id, runtime);
  }

  private requiredBufferMs(rate: number, durationMs: number): number {
    if (rate >= 1) return SAFE_START_BUFFER_MS;
    return Math.min(durationMs, Math.max(SAFE_START_BUFFER_MS, (1 - rate) * durationMs + 1_000));
  }

  private cancelTrack(trackId: string, afterMs = 0): void {
    if (afterMs > 0) {
      window.setTimeout(() => this.cancelTrack(trackId), afterMs);
      return;
    }
    const fragmentTimer = this.fragmentTimers.get(trackId);
    if (fragmentTimer !== undefined) window.clearTimeout(fragmentTimer);
    this.fragmentTimers.delete(trackId);
    const runtime = this.tracks.get(trackId);
    runtime?.stream.close();
    this.tracks.delete(trackId);
    this.audio.discardTrack(trackId);
    void this.client.cancelMusic(trackId);
  }

  private speak(id: string, text: string): void {
    let started = false;
    let generatedMs = 0;
    let firstAudioAt: number | null = null;
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
        firstAudioAt ??= performance.now();
        generatedMs += (pcm.length / 2 / 48_000) * 1_000;
        this.audio.enqueue(id, pcm);
        const generationRate = generatedMs / Math.max(1, performance.now() - firstAudioAt);
        if (generatedMs >= 600 && generationRate >= 1.2) startPlayback();
      },
      onEnd: () => {
        this.audio.markInputEnded(id);
        if (generatedMs > 0) {
          startPlayback();
        } else {
          this.audio.finishTTS(id);
          this.dispatch(nowEvent({ type: "TTS_FINISHED", speechId: id }));
          this.ttsStreams.get(id)?.close();
          this.ttsStreams.delete(id);
        }
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
    this.dispatch(nowEvent({ type: "TRACK_STARTED", trackId, spec }));
  }

  private trackInputEnded(trackId: string): void {
    if (!this.state.running || this.state.playback.trackId !== trackId || this.endedTrackId === trackId) return;
    this.endedTrackId = trackId;
    this.dispatch(nowEvent({ type: "TRACK_ENDED", trackId }));
  }

  private emitProgress(): void {
    const progress = this.audio.getProgress();
    if (!progress || !this.state.running) return;
    this.dispatch(nowEvent({
      type: "TRACK_PROGRESS",
      trackId: progress.trackId,
      playheadMs: progress.playheadMs,
      remainingMs: progress.remainingMs,
      bufferedMs: progress.bufferedMs
    }));
    const state = this.state;
    if (
      state.playback.trackId === progress.trackId &&
      state.phase !== "handoff" &&
      state.pendingUser?.resolution !== "promoted" &&
      progress.remainingMs <= NEXT_TRACK_HORIZON_MS &&
      state.horizonFiredForTrackId !== progress.trackId
    ) {
      this.dispatch(nowEvent({
        type: "NEXT_TRACK_HORIZON",
        requestId: this.nextId("horizon"),
        trackId: progress.trackId
      }));
    }
    if (progress.remainingMs <= 0 && this.endedTrackId !== progress.trackId) {
      this.endedTrackId = progress.trackId;
      this.dispatch(nowEvent({ type: "TRACK_ENDED", trackId: progress.trackId }));
    }
  }

  private async stopAll(): Promise<void> {
    if (this.progressTimer !== null) window.clearInterval(this.progressTimer);
    this.progressTimer = null;
    for (const [id, runtime] of this.tracks) {
      runtime.stream.close();
      void this.client.cancelMusic(id);
    }
    for (const stream of this.ttsStreams.values()) stream.close();
    for (const timer of this.fragmentTimers.values()) window.clearTimeout(timer);
    this.fragmentTimers.clear();
    this.lyriaStream?.close();
    this.tracks.clear();
    this.ttsStreams.clear();
    this.lyriaStream = null;
    this.lyriaId = null;
    await this.audio.stopAll();
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter}`;
  }
}
