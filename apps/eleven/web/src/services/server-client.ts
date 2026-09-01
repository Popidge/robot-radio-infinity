import {
  producerPlanSchema,
  trackRepairPlanSchema,
  urgencyAssessmentSchema,
  type AudioStreamEncoding,
  type ContinuityInput,
  type InitialIntentInput,
  type ProducerPlan,
  type ShowState,
  type StationCommand,
  type StationEvent,
  type TrackSpec,
  type TransitionSpec,
  type TrackRepairInput,
  type TrackRepairPlan,
  type UrgencyAssessment,
  type UrgencyInput,
  type UserIntentInput
} from "@robot-radio/eleven-shared";
import { StreamAudioDecoder } from "../audio/stream-audio-decoder";

export interface RemoteStreamCallbacks {
  onStart(metadata: { id: string; encoding: AudioStreamEncoding; sampleRate: number; channels: number; durationMs: number | null }): void;
  onChunk(chunk: Float32Array): void;
  onEnd(): void;
  onError(error: Error): void;
}

export interface RemoteStream {
  close(): void;
}

export interface StationDebugState {
  phase: string;
  running: boolean;
  error?: string;
  playback: unknown;
  intent: unknown;
  nextTrack: unknown;
  transition: unknown;
  dj: unknown;
  showState: ShowState;
  pendingUser?: unknown;
  startup?: unknown;
  horizonFiredForTrackId: string | null;
  horizonRequestId?: string;
  eventCount: number;
  commandCount: number;
}

interface StationDebugTransition {
  sequence: number;
  clientAt: number;
  event: StationEvent;
  commands: StationCommand[];
  state: StationDebugState;
}

export class ServerClient {
  private debugQueue: StationDebugTransition[] = [];
  private debugTimer: number | null = null;
  private reportedDebugFailure = false;

  constructor(private readonly baseUrl = import.meta.env.VITE_SERVER_URL ?? window.location.origin) {}

  logStationTransition(transition: StationDebugTransition): void {
    this.debugQueue.push(transition);
    if (transition.event.type.endsWith("FAILED") || transition.event.type === "START_STATION" || transition.event.type === "STOP_STATION") {
      this.flushDebugTransitions();
      return;
    }
    if (this.debugTimer === null) {
      this.debugTimer = window.setTimeout(() => this.flushDebugTransitions(), 250);
    }
  }

  flushDebugTransitions(): void {
    if (this.debugTimer !== null) window.clearTimeout(this.debugTimer);
    this.debugTimer = null;
    if (!this.debugQueue.length) return;
    const transitions = this.debugQueue.splice(0, this.debugQueue.length);
    void fetch(this.url("/api/debug/station-transitions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transitions }),
      keepalive: true
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Debug log endpoint returned ${response.status}`);
        this.reportedDebugFailure = false;
      })
      .catch((error) => {
        if (this.reportedDebugFailure) return;
        this.reportedDebugFailure = true;
        console.warn("Station debug transitions could not be persisted", error);
      });
  }

  assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment> {
    return this.post("/api/llm/urgency", input, urgencyAssessmentSchema.parse);
  }

  planInitialIntent(input: InitialIntentInput): Promise<ProducerPlan> {
    return this.post("/api/llm/initial-intent", input, producerPlanSchema.parse);
  }

  planUserIntent(input: UserIntentInput): Promise<ProducerPlan> {
    return this.post("/api/llm/user-plan", input, producerPlanSchema.parse);
  }

  planContinuity(input: ContinuityInput): Promise<ProducerPlan> {
    return this.post("/api/llm/continuity-plan", input, producerPlanSchema.parse);
  }

  repairTrackSpec(input: TrackRepairInput): Promise<TrackRepairPlan> {
    return this.post("/api/llm/track-repair", input, trackRepairPlanSchema.parse);
  }

  streamMusic(spec: TrackSpec, generationRate: number, callbacks: RemoteStreamCallbacks): RemoteStream {
    return this.openStream("/stream/music", { spec, generationRate }, callbacks);
  }

  streamTransition(spec: TransitionSpec, generationRate: number, callbacks: RemoteStreamCallbacks): RemoteStream {
    return this.openStream("/stream/transition", { spec, generationRate }, callbacks);
  }

  streamTTS(id: string, text: string, callbacks: RemoteStreamCallbacks): RemoteStream {
    return this.openStream("/stream/tts", { id, text }, callbacks);
  }

  async cancelMusic(id: string): Promise<void> {
    await fetch(this.url(`/api/music/${encodeURIComponent(id)}`), { method: "DELETE" });
  }

  private async post<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message = typeof result === "object" && result && "error" in result ? String(result.error) : response.statusText;
      throw new Error(message);
    }
    return parse(result);
  }

  private openStream(path: string, payload: unknown, callbacks: RemoteStreamCallbacks): RemoteStream {
    const base = new URL(this.baseUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = path;
    base.search = new URLSearchParams({ payload: this.encodePayload(payload) }).toString();
    const socket = new WebSocket(base.toString());
    socket.binaryType = "arraybuffer";
    let decoder: StreamAudioDecoder | null = null;
    let processing = Promise.resolve();
    let released = false;
    let failed = false;

    const closeDecoder = (): void => {
      const current = decoder;
      decoder = null;
      if (current) void current.close().catch(() => undefined);
    };
    const fail = (error: unknown): void => {
      if (released || failed) return;
      failed = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      callbacks.onError(failure);
      closeDecoder();
      socket.close(1011, "Stream failed");
    };
    const enqueue = (operation: () => Promise<void> | void): void => {
      processing = processing.then(async () => {
        if (!released && !failed) await operation();
      }).catch(fail);
    };

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        enqueue(async () => {
          if (!decoder) throw new Error("Received audio before stream metadata");
          const chunks = await decoder.push(bytes);
          if (!released) for (const chunk of chunks) callbacks.onChunk(chunk);
        });
        return;
      }
      try {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          id?: string;
          encoding?: AudioStreamEncoding;
          sampleRate?: number;
          channels?: number;
          durationMs?: number | null;
          error?: string;
        };
        if (message.type === "stream-start") {
          if (message.encoding !== "mp3" && message.encoding !== "pcm-f32le") {
            throw new Error(`Unsupported audio stream encoding: ${String(message.encoding)}`);
          }
          const metadata = {
            id: message.id ?? "unknown",
            encoding: message.encoding,
            sampleRate: message.sampleRate ?? 48_000,
            channels: message.channels ?? 2,
            durationMs: message.durationMs ?? null
          };
          decoder = new StreamAudioDecoder(metadata);
          callbacks.onStart(metadata);
        } else if (message.type === "stream-end") {
          enqueue(async () => {
            if (!decoder) throw new Error("Stream ended before metadata arrived");
            for (const chunk of decoder.finish()) callbacks.onChunk(chunk);
            await decoder.close();
            decoder = null;
            if (!released) callbacks.onEnd();
            socket.close(1000, "Stream completed");
          });
        } else if (message.type === "stream-error") {
          enqueue(() => { throw new Error(message.error ?? "Remote stream failed") });
        }
      } catch (error) {
        fail(error);
      }
    };
    socket.onerror = () => fail(new Error(`WebSocket failed: ${path}`));
    return {
      close: () => {
        if (released) return;
        released = true;
        closeDecoder();
        socket.close(1000, "Client released stream");
      }
    };
  }

  private encodePayload(payload: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }
}
