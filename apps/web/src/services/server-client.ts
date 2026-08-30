import {
  continuityPlanSchema,
  initialIntentPlanSchema,
  urgencyAssessmentSchema,
  userIntentPlanSchema,
  type ContinuityInput,
  type ContinuityPlan,
  type InitialIntentInput,
  type InitialIntentPlan,
  type LyriaTransitionPlan,
  type MusicalSnapshot,
  type StationCommand,
  type StationEvent,
  type TrackSpec,
  type UrgencyAssessment,
  type UrgencyInput,
  type UserIntentInput,
  type UserIntentPlan
} from "@robot-radio/shared";

export interface RemoteStreamCallbacks {
  onStart(metadata: { id: string; sampleRate: number; channels: number; durationMs: number | null }): void;
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
  continuity: unknown;
  dj: unknown;
  pendingUser?: unknown;
  startup?: unknown;
  transitionFragment?: unknown;
  pendingBridgeSpeech?: unknown;
  horizonFiredForTrackId: string | null;
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

  planInitialIntent(input: InitialIntentInput): Promise<InitialIntentPlan> {
    return this.post("/api/llm/initial-intent", input, initialIntentPlanSchema.parse);
  }

  planUserIntent(input: UserIntentInput): Promise<UserIntentPlan> {
    return this.post("/api/llm/user-plan", input, userIntentPlanSchema.parse);
  }

  planContinuity(input: ContinuityInput): Promise<ContinuityPlan> {
    return this.post("/api/llm/continuity-plan", input, continuityPlanSchema.parse);
  }

  streamMusic(spec: TrackSpec, generationRate: number, callbacks: RemoteStreamCallbacks): RemoteStream {
    return this.openStream("/stream/music", { spec, generationRate }, callbacks);
  }

  streamLyria(id: string, seed: MusicalSnapshot, callbacks: RemoteStreamCallbacks): RemoteStream {
    return this.openStream("/stream/lyria", { id, seed }, callbacks);
  }

  streamTTS(id: string, text: string, callbacks: RemoteStreamCallbacks): RemoteStream {
    return this.openStream("/stream/tts", { id, text }, callbacks);
  }

  async steerLyria(id: string, plan: LyriaTransitionPlan): Promise<void> {
    await this.post(`/api/lyria/${encodeURIComponent(id)}/steer`, plan, (value) => value);
  }

  async stopLyria(id: string): Promise<void> {
    await this.post(`/api/lyria/${encodeURIComponent(id)}/stop`, {}, (value) => value);
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
    const socket = new WebSocket(base);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        callbacks.onChunk(new Float32Array(event.data));
        return;
      }
      const message = JSON.parse(String(event.data)) as {
        type: string;
        id?: string;
        sampleRate?: number;
        channels?: number;
        durationMs?: number | null;
        error?: string;
      };
      if (message.type === "stream-start") {
        callbacks.onStart({
          id: message.id ?? "unknown",
          sampleRate: message.sampleRate ?? 48_000,
          channels: message.channels ?? 2,
          durationMs: message.durationMs ?? null
        });
      } else if (message.type === "stream-end") {
        callbacks.onEnd();
      } else if (message.type === "stream-error") {
        callbacks.onError(new Error(message.error ?? "Remote stream failed"));
      }
    };
    socket.onerror = () => callbacks.onError(new Error(`WebSocket failed: ${path}`));
    return { close: () => socket.close(1000, "Client released stream") };
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
