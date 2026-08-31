import pcmPlayerWorkletCode from "./pcm-player.worklet.ts?raw";

type SourceKind = "track" | "lyria" | "tts";

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

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private currentTrackBus: GainNode | null = null;
  private incomingTrackBus: GainNode | null = null;
  private lyriaBus: GainNode | null = null;
  private ttsBus: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private currentTrack: PcmSource | null = null;
  private incomingTracks = new Map<string, PcmSource>();
  private lyria: PcmSource | null = null;
  private ttsSources = new Map<string, PcmSource>();
  private trackStartedAt = 0;

  async initialize(): Promise<void> {
    if (this.context) {
      await this.context.resume();
      return;
    }
    this.context = new AudioContext({ sampleRate: 48_000, latencyHint: "playback" });
    const workletBlob = new Blob([pcmPlayerWorkletCode], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(workletBlob);
    try {
      await this.context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    this.masterBus = this.context.createGain();
    this.musicBus = this.context.createGain();
    this.currentTrackBus = this.context.createGain();
    this.incomingTrackBus = this.context.createGain();
    this.lyriaBus = this.context.createGain();
    this.ttsBus = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.82;
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 8;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;

    this.currentTrackBus.connect(this.musicBus);
    this.incomingTrackBus.connect(this.musicBus);
    this.lyriaBus.connect(this.musicBus);
    this.musicBus.connect(this.masterBus);
    this.ttsBus.connect(this.masterBus);
    this.masterBus.connect(this.analyser);
    this.analyser.connect(compressor);
    compressor.connect(this.context.destination);
    this.masterBus.gain.value = 0.82;
    await this.context.resume();
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
    const bus = kind === "lyria" ? this.lyriaBus : kind === "tts" ? this.ttsBus : this.incomingTrackBus;
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

  createLyria(id: string): void {
    if (this.lyria?.id === id) return;
    if (this.lyria) this.dispose(this.lyria);
    this.lyria = this.makeSource(id, "lyria", null);
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

  commitContinuity(): void {
    if (!this.lyria || this.lyria.playing) return;
    this.lyria.playing = true;
    this.lyria.node.port.postMessage({ type: "play" });
  }

  fadeInLyria(durationMs: number): void {
    if (!this.lyria) return;
    this.commitContinuity();
    this.ramp(this.lyria.gain.gain, 1, durationMs);
  }

  fadeTrackToLyria(durationMs: number): void {
    if (!this.lyria) return;
    this.commitContinuity();
    this.ramp(this.lyria.gain.gain, 1, durationMs);
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

  fadeLyriaToTrack(id: string, durationMs: number): void {
    this.crossfadeToTrack(id, durationMs);
    const oldLyria = this.lyria;
    if (oldLyria) {
      this.ramp(oldLyria.gain.gain, 0, durationMs);
      window.setTimeout(() => {
        if (this.lyria === oldLyria) this.lyria = null;
        this.dispose(oldLyria);
      }, durationMs + 80);
    }
  }

  releaseLyria(afterMs = 0): void {
    const source = this.lyria;
    if (!source) return;
    window.setTimeout(() => {
      if (this.lyria === source) this.lyria = null;
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

  hasLyria(): boolean {
    return this.lyria !== null;
  }

  readSpectrum(target: Uint8Array<ArrayBuffer>): boolean {
    if (!this.analyser || target.length !== this.analyser.frequencyBinCount) return false;
    this.analyser.getByteFrequencyData(target);
    return true;
  }

  spectrumBinCount(): number {
    return this.analyser?.frequencyBinCount ?? 128;
  }

  async stopAll(): Promise<void> {
    for (const source of this.incomingTracks.values()) this.dispose(source);
    for (const source of this.ttsSources.values()) this.dispose(source);
    if (this.currentTrack) this.dispose(this.currentTrack);
    if (this.lyria) this.dispose(this.lyria);
    this.incomingTracks.clear();
    this.ttsSources.clear();
    this.currentTrack = null;
    this.lyria = null;
    this.analyser = null;
    const context = this.context;
    this.context = null;
    if (context) await context.close();
  }

  private findSource(id: string): PcmSource | undefined {
    if (this.currentTrack?.id === id) return this.currentTrack;
    if (this.lyria?.id === id) return this.lyria;
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
