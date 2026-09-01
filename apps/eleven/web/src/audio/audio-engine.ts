type SourceKind = "track" | "transition" | "tts" | "cart";

interface SourceMetrics {
  type: "metrics";
  consumedFrames: number;
  availableFrames: number;
  starved: boolean;
}

interface PcmSource {
  id: string;
  kind: SourceKind;
  node: AudioWorkletNode;
  gain: GainNode;
  receivedFrames: number;
  consumedFrames: number;
  availableFrames: number;
  playing: boolean;
  durationMs: number | null;
  onEnded?: () => void;
}

export interface PlaybackClock {
  trackId: string;
  playheadMs: number;
  remainingMs: number;
  bufferedMs: number;
}

const TRACK_FADE_MS = 2_500;
export const PCM_PLAYER_WORKLET_PATH = "/pcm-player.worklet.js";

export class AudioEngine {
  private initialization: Promise<void> | null = null;
  private context: AudioContext | null = null;
  private masterBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private currentTrackBus: GainNode | null = null;
  private incomingTrackBus: GainNode | null = null;
  private transitionBus: GainNode | null = null;
  private ttsBus: GainNode | null = null;
  private cartBus: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private currentTrack: PcmSource | null = null;
  private incomingTracks = new Map<string, PcmSource>();
  private transition: PcmSource | null = null;
  private ttsSources = new Map<string, PcmSource>();
  private cartLibrary = new Map<string, { chunks: Float32Array[]; durationMs: number; mixType: "dry" | "wet" }>();
  private currentCart: PcmSource | null = null;
  private trackStartedAt = 0;

  async initialize(): Promise<void> {
    this.initialization ??= this.initializeContext();
    try {
      await this.initialization;
      await this.context?.resume();
    } catch (error) {
      this.initialization = null;
      throw error;
    }
  }

  private async initializeContext(): Promise<void> {
    const context = new AudioContext({ sampleRate: 48_000, latencyHint: "playback" });
    try {
      await context.audioWorklet.addModule(PCM_PLAYER_WORKLET_PATH);
    } catch (error) {
      await context.close();
      throw error;
    }
    this.context = context;

    this.masterBus = context.createGain();
    this.musicBus = context.createGain();
    this.currentTrackBus = context.createGain();
    this.incomingTrackBus = context.createGain();
    this.transitionBus = context.createGain();
    this.ttsBus = context.createGain();
    this.cartBus = context.createGain();
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.82;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 8;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;

    this.currentTrackBus.connect(this.musicBus);
    this.incomingTrackBus.connect(this.musicBus);
    this.transitionBus.connect(this.musicBus);
    this.musicBus.connect(this.masterBus);
    this.ttsBus.connect(this.masterBus);
    this.cartBus.connect(this.masterBus);
    this.masterBus.connect(this.analyser);
    this.analyser.connect(compressor);
    compressor.connect(context.destination);
    this.masterBus.gain.value = 0.82;
    await context.resume();
  }

  private makeSource(id: string, kind: SourceKind, durationMs: number | null, onEnded?: () => void): PcmSource {
    if (!this.context) throw new Error("AudioEngine is not initialized");
    const node = new AudioWorkletNode(this.context, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    const gain = this.context.createGain();
    gain.gain.value = 0;
    node.connect(gain);
    const bus = kind === "transition" ? this.transitionBus : kind === "tts" ? this.ttsBus : kind === "cart" ? this.cartBus : this.incomingTrackBus;
    if (!bus) throw new Error("Audio bus is not initialized");
    gain.connect(bus);
    const source: PcmSource = {
      id,
      kind,
      node,
      gain,
      receivedFrames: 0,
      consumedFrames: 0,
      availableFrames: 0,
      playing: false,
      durationMs,
      onEnded
    };
    node.port.onmessage = (event: MessageEvent<SourceMetrics | { type: "ended" }>) => {
      if (event.data.type === "metrics") {
        source.consumedFrames = event.data.consumedFrames;
        source.availableFrames = event.data.availableFrames;
      } else if (event.data.type === "ended") {
        source.onEnded?.();
      }
    };
    return source;
  }

  createTrack(id: string, durationMs: number, onEnded?: () => void): void {
    const existing = this.incomingTracks.get(id);
    if (existing) this.dispose(existing);
    this.incomingTracks.set(id, this.makeSource(id, "track", durationMs, onEnded));
  }

  setDuration(id: string, durationMs: number): void {
    const source = this.findSource(id);
    if (source) source.durationMs = durationMs;
  }

  discardTrack(id: string): void {
    const source = this.incomingTracks.get(id);
    if (source) this.dispose(source);
  }

  createTransition(id: string, durationMs: number, onEnded?: () => void): void {
    if (this.transition?.id === id) return;
    if (this.transition) this.dispose(this.transition);
    this.transition = this.makeSource(id, "transition", durationMs, onEnded);
  }

  createTTS(id: string, durationMs: number | null, onEnded: () => void): void {
    const source = this.makeSource(id, "tts", durationMs, onEnded);
    this.ttsSources.set(id, source);
  }

  enqueue(id: string, pcm: Float32Array): void {
    const source = this.findSource(id);
    if (!source) return;
    source.receivedFrames += pcm.length / 2;
    source.node.port.postMessage({ type: "chunk", pcm }, [pcm.buffer]);
  }

  markInputEnded(id: string): void {
    this.findSource(id)?.node.port.postMessage({ type: "end" });
  }

  playTTS(id: string): void {
    const source = this.ttsSources.get(id);
    if (!source || source.playing) return;
    source.playing = true;
    source.gain.gain.setValueAtTime(0.92, this.now());
    source.node.port.postMessage({ type: "play" });
  }

  duckForSpeech(): void {
    if (!this.musicBus) return;
    const now = this.now();
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
    this.musicBus.gain.linearRampToValueAtTime(0.28, now + 0.18);
  }

  restoreAfterSpeech(): void {
    if (!this.musicBus) return;
    const now = this.now();
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, now);
    this.musicBus.gain.linearRampToValueAtTime(1, now + 0.38);
  }

  finishTTS(id: string): void {
    const source = this.ttsSources.get(id);
    if (source) this.dispose(source);
  }

  registerCart(id: string, chunks: Float32Array[], durationMs: number, mixType: "dry" | "wet"): void {
    this.cartLibrary.set(id, { chunks: chunks.map((chunk) => chunk.slice()), durationMs, mixType });
  }

  playCart(id: string, onEnded: () => void): void {
    const asset = this.cartLibrary.get(id);
    if (!asset || this.currentCart) throw new Error(`Station element is not ready for ${id}`);
    const source = this.makeSource(id, "cart", asset.durationMs, () => {
      this.restoreAfterCart();
      if (this.currentCart === source) this.currentCart = null;
      this.dispose(source);
      onEnded();
    });
    this.currentCart = source;
    source.playing = true;
    source.gain.gain.setValueAtTime(asset.mixType === "dry" ? 0.94 : 0.88, this.now());
    this.duckForCart(asset.mixType);
    for (const chunk of asset.chunks) this.enqueueCart(source, chunk.slice());
    source.node.port.postMessage({ type: "end" });
    source.node.port.postMessage({ type: "play" });
  }

  private enqueueCart(source: PcmSource, pcm: Float32Array): void {
    source.receivedFrames += pcm.length / 2;
    source.node.port.postMessage({ type: "chunk", pcm }, [pcm.buffer]);
  }

  private duckForCart(mixType: "dry" | "wet"): void {
    if (!this.musicBus) return;
    this.ramp(this.musicBus.gain, mixType === "dry" ? 0.5 : 0.16, 120);
  }

  private restoreAfterCart(): void {
    if (!this.musicBus) return;
    this.ramp(this.musicBus.gain, 1, 280);
  }

  private startTransition(): void {
    if (!this.transition || this.transition.playing) return;
    this.transition.playing = true;
    this.transition.node.port.postMessage({ type: "play" });
  }

  fadeInTransition(durationMs: number): void {
    if (!this.transition) return;
    this.startTransition();
    this.ramp(this.transition.gain.gain, 1, durationMs);
  }

  fadeTrackToTransition(durationMs: number): void {
    if (!this.transition) return;
    this.startTransition();
    this.ramp(this.transition.gain.gain, 1, durationMs);
    const oldTrack = this.currentTrack;
    if (oldTrack) {
      this.ramp(oldTrack.gain.gain, 0, durationMs);
      window.setTimeout(() => {
        if (this.currentTrack === oldTrack) this.currentTrack = null;
        this.dispose(oldTrack);
      }, durationMs + 80);
    }
  }

  playTrack(id: string, fadeMs = 120): void {
    this.crossfadeToTrack(id, fadeMs);
  }

  crossfadeToTrack(id: string, durationMs = TRACK_FADE_MS): void {
    const incoming = this.incomingTracks.get(id);
    if (!incoming) throw new Error(`Incoming audio is missing for ${id}`);
    this.incomingTracks.delete(id);
    incoming.playing = true;
    incoming.node.port.postMessage({ type: "play" });
    this.ramp(incoming.gain.gain, 1, durationMs);

    const oldTrack = this.currentTrack;
    if (oldTrack) {
      this.ramp(oldTrack.gain.gain, 0, durationMs);
      window.setTimeout(() => this.dispose(oldTrack), durationMs + 80);
    }
    this.currentTrack = incoming;
    this.trackStartedAt = this.now();
  }

  fadeTransitionToTrack(id: string, durationMs: number): void {
    this.crossfadeToTrack(id, durationMs);
    const oldTransition = this.transition;
    if (oldTransition) {
      this.ramp(oldTransition.gain.gain, 0, durationMs);
      window.setTimeout(() => {
        if (this.transition === oldTransition) this.transition = null;
        this.dispose(oldTransition);
      }, durationMs + 80);
    }
  }

  discardTransition(afterMs = 0): void {
    const source = this.transition;
    if (!source) return;
    window.setTimeout(() => {
      if (this.transition === source) this.transition = null;
      this.dispose(source);
    }, afterMs);
  }

  getBufferedMs(id: string): number {
    const source = this.findSource(id);
    return source ? (source.availableFrames / 48_000) * 1_000 : 0;
  }

  getProgress(): PlaybackClock | null {
    const source = this.currentTrack;
    if (!source || source.durationMs === null) return null;
    const playheadMs = Math.min(source.durationMs, (this.now() - this.trackStartedAt) * 1_000);
    return {
      trackId: source.id,
      playheadMs,
      remainingMs: Math.max(0, source.durationMs - playheadMs),
      bufferedMs: this.getBufferedMs(source.id)
    };
  }

  hasTransition(): boolean {
    return this.transition !== null;
  }

  readSpectrum(target: Uint8Array<ArrayBuffer>): boolean {
    if (!this.analyser || target.length !== this.analyser.frequencyBinCount) return false;
    this.analyser.getByteFrequencyData(target);
    return true;
  }

  spectrumBinCount(): number {
    return this.analyser?.frequencyBinCount ?? 128;
  }

  async setPaused(paused: boolean): Promise<void> {
    if (!this.context) return;
    if (paused) await this.context.suspend();
    else await this.context.resume();
  }

  async stopAll(): Promise<void> {
    for (const source of this.incomingTracks.values()) this.dispose(source);
    for (const source of this.ttsSources.values()) this.dispose(source);
    if (this.currentCart) this.dispose(this.currentCart);
    if (this.currentTrack) this.dispose(this.currentTrack);
    if (this.transition) this.dispose(this.transition);
    this.incomingTracks.clear();
    this.ttsSources.clear();
    this.cartLibrary.clear();
    this.currentTrack = null;
    this.transition = null;
    this.currentCart = null;
    this.analyser = null;
    const context = this.context;
    this.initialization = null;
    this.context = null;
    if (context) await context.close();
  }

  private findSource(id: string): PcmSource | undefined {
    if (this.currentTrack?.id === id) return this.currentTrack;
    if (this.transition?.id === id) return this.transition;
    if (this.currentCart?.id === id) return this.currentCart;
    return this.incomingTracks.get(id) ?? this.ttsSources.get(id);
  }

  private now(): number {
    return this.context?.currentTime ?? 0;
  }

  private ramp(parameter: AudioParam, target: number, durationMs: number): void {
    const now = this.now();
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(parameter.value, now);
    parameter.linearRampToValueAtTime(target, now + durationMs / 1_000);
  }

  private dispose(source: PcmSource): void {
    source.node.port.postMessage({ type: "reset" });
    source.node.disconnect();
    source.gain.disconnect();
    this.ttsSources.delete(source.id);
    this.incomingTracks.delete(source.id);
  }
}
