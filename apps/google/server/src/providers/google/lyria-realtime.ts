import {
  GoogleGenAI,
  MusicGenerationMode,
  Scale,
  type LiveMusicGenerationConfig,
  type LiveMusicSession
} from "@google/genai";
import type {
  ContinuityProvider,
  ContinuityStream,
  LyriaTransitionPlan,
  MusicalSnapshot
} from "@robot-radio/google-shared";
import { AsyncQueue } from "../async-queue";
import { pcm16StereoToFloat } from "./audio";
import { compileRealtimeSeed, compileRealtimeTransition } from "./prompt-compiler";
import { emitTelemetry, type GoogleAudioTelemetrySink } from "./telemetry";

interface RealtimeControl {
  session: LiveMusicSession;
  queue: AsyncQueue<Float32Array>;
  config: LiveMusicGenerationConfig;
  prompt: string;
  lifecycle: { stopping: boolean };
}

function timeoutAfter(ms: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let handle: NodeJS.Timeout | undefined;
  return {
    promise: new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => reject(new Error(message)), ms);
    }),
    cancel: () => {
      if (handle) clearTimeout(handle);
    }
  };
}

function scaleForKey(key?: string): Scale | undefined {
  const normalized = key
    ?.toLowerCase()
    .replaceAll("♭", "b")
    .replaceAll("♯", "#")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return {
    "c major": Scale.C_MAJOR_A_MINOR,
    "a minor": Scale.C_MAJOR_A_MINOR,
    "db major": Scale.D_FLAT_MAJOR_B_FLAT_MINOR,
    "c# major": Scale.D_FLAT_MAJOR_B_FLAT_MINOR,
    "bb minor": Scale.D_FLAT_MAJOR_B_FLAT_MINOR,
    "a# minor": Scale.D_FLAT_MAJOR_B_FLAT_MINOR,
    "d major": Scale.D_MAJOR_B_MINOR,
    "b minor": Scale.D_MAJOR_B_MINOR,
    "eb major": Scale.E_FLAT_MAJOR_C_MINOR,
    "d# major": Scale.E_FLAT_MAJOR_C_MINOR,
    "c minor": Scale.E_FLAT_MAJOR_C_MINOR,
    "e major": Scale.E_MAJOR_D_FLAT_MINOR,
    "c# minor": Scale.E_MAJOR_D_FLAT_MINOR,
    "db minor": Scale.E_MAJOR_D_FLAT_MINOR,
    "f major": Scale.F_MAJOR_D_MINOR,
    "d minor": Scale.F_MAJOR_D_MINOR,
    "gb major": Scale.G_FLAT_MAJOR_E_FLAT_MINOR,
    "f# major": Scale.G_FLAT_MAJOR_E_FLAT_MINOR,
    "eb minor": Scale.G_FLAT_MAJOR_E_FLAT_MINOR,
    "d# minor": Scale.G_FLAT_MAJOR_E_FLAT_MINOR,
    "g major": Scale.G_MAJOR_E_MINOR,
    "e minor": Scale.G_MAJOR_E_MINOR,
    "ab major": Scale.A_FLAT_MAJOR_F_MINOR,
    "g# major": Scale.A_FLAT_MAJOR_F_MINOR,
    "f minor": Scale.A_FLAT_MAJOR_F_MINOR,
    "a major": Scale.A_MAJOR_G_FLAT_MINOR,
    "f# minor": Scale.A_MAJOR_G_FLAT_MINOR,
    "gb minor": Scale.A_MAJOR_G_FLAT_MINOR,
    "bb major": Scale.B_FLAT_MAJOR_G_MINOR,
    "a# major": Scale.B_FLAT_MAJOR_G_MINOR,
    "g minor": Scale.B_FLAT_MAJOR_G_MINOR,
    "b major": Scale.B_MAJOR_A_FLAT_MINOR,
    "g# minor": Scale.B_MAJOR_A_FLAT_MINOR,
    "ab minor": Scale.B_MAJOR_A_FLAT_MINOR
  }[normalized];
}

function configFromSnapshot(snapshot: MusicalSnapshot): LiveMusicGenerationConfig {
  return {
    bpm: snapshot.bpm ? Math.max(60, Math.min(200, Math.round(snapshot.bpm))) : undefined,
    scale: scaleForKey(snapshot.key),
    density: snapshot.energy,
    brightness: snapshot.energy === undefined ? undefined : Math.max(0.15, Math.min(0.9, snapshot.energy * 0.8)),
    guidance: 4,
    temperature: 1.1,
    musicGenerationMode: MusicGenerationMode.QUALITY
  };
}

export class GoogleLyriaRealtimeProvider implements ContinuityProvider {
  private readonly client: GoogleGenAI;
  private readonly controls = new Map<string, RealtimeControl>();
  private readonly model: string;

  constructor(
    apiKey: string,
    private readonly telemetry?: GoogleAudioTelemetrySink,
    model = process.env.GEMINI_LYRIA_REALTIME_MODEL ?? "models/lyria-realtime-exp"
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      apiVersion: process.env.GEMINI_LYRIA_API_VERSION ?? "v1alpha"
    });
    this.model = model;
  }

  async start(id: string, seed: MusicalSnapshot): Promise<ContinuityStream> {
    const queue = new AsyncQueue<Float32Array>();
    let rejectConnection: (error: Error) => void = () => undefined;
    let resolveSetup: () => void = () => undefined;
    let rejectSetup: (error: Error) => void = () => undefined;
    let setupComplete = false;
    const lifecycle = { stopping: false };
    const connectionFailure = new Promise<never>((_resolve, reject) => {
      rejectConnection = reject;
    });
    const setup = new Promise<void>((resolve, reject) => {
      resolveSetup = resolve;
      rejectSetup = reject;
    });
    emitTelemetry(this.telemetry, { type: "request_started", provider: "lyria-realtime", streamId: id, model: this.model, at: performance.now() });
    const connectPromise = this.client.live.music.connect({
      model: this.model,
      callbacks: {
        onmessage: (message) => {
          if (message.setupComplete) {
            setupComplete = true;
            resolveSetup();
          }
          for (const chunk of message.serverContent?.audioChunks ?? []) {
            if (!chunk.data) continue;
            const encoded = Buffer.from(chunk.data, "base64");
            emitTelemetry(this.telemetry, {
              type: "audio_delta",
              provider: "lyria-realtime",
              streamId: id,
              at: performance.now(),
              encodedBytes: encoded.length,
              mimeType: chunk.mimeType,
              sampleRate: 48_000,
              channels: 2
            });
            queue.push(pcm16StereoToFloat(encoded));
          }
          if (message.filteredPrompt?.filteredReason) {
            queue.fail(new Error(`Lyria rejected a prompt: ${message.filteredPrompt.filteredReason}`));
          }
        },
        onerror: (event) => {
          const error = new Error(event.message || "Lyria RealTime session failed");
          queue.fail(error);
          rejectConnection(error);
          rejectSetup(error);
        },
        onclose: (event) => {
          if (lifecycle.stopping) {
            queue.end();
            return;
          }
          const phase = setupComplete ? "during streaming" : "before setup";
          const error = new Error(
            `Lyria RealTime connection closed ${phase} (${event.code}: ${event.reason || "no reason"})`
          );
          queue.fail(error);
          rejectConnection(error);
          rejectSetup(error);
        }
      }
    });
    const timeoutMs = Number(process.env.GEMINI_LYRIA_CONNECT_TIMEOUT_MS ?? 20_000);
    const connectTimeout = timeoutAfter(timeoutMs, `Lyria RealTime did not connect within ${timeoutMs}ms`);
    let session: LiveMusicSession;
    try {
      session = await Promise.race([connectPromise, connectionFailure, connectTimeout.promise]);
    } finally {
      connectTimeout.cancel();
    }
    const setupTimeout = timeoutAfter(timeoutMs, `Lyria RealTime did not complete setup within ${timeoutMs}ms`);
    try {
      await Promise.race([setup, setupTimeout.promise]);
    } catch (error) {
      lifecycle.stopping = true;
      session.close();
      throw error;
    } finally {
      setupTimeout.cancel();
    }
    emitTelemetry(this.telemetry, { type: "response_opened", provider: "lyria-realtime", streamId: id, at: performance.now() });
    const prompt = compileRealtimeSeed(seed);
    const config = configFromSnapshot(seed);
    const control: RealtimeControl = { session, queue, config, prompt, lifecycle };
    this.controls.set(id, control);
    try {
      await session.setWeightedPrompts({ weightedPrompts: [{ text: prompt, weight: 1 }] });
      await session.setMusicGenerationConfig({ musicGenerationConfig: config });
      session.play();
    } catch (error) {
      lifecycle.stopping = true;
      session.close();
      this.controls.delete(id);
      throw error;
    }

    return { id, sampleRate: 48_000, channels: 2, durationMs: null, chunks: queue };
  }

  async steer(id: string, plan: LyriaTransitionPlan): Promise<void> {
    const control = this.controls.get(id);
    if (!control) throw new Error(`Unknown Lyria RealTime stream: ${id}`);
    const destination = plan.keyframes?.at(-1);
    const nextConfig: LiveMusicGenerationConfig = {
      ...control.config,
      bpm: destination?.bpm ? Math.max(60, Math.min(200, Math.round(destination.bpm))) : control.config.bpm,
      scale: scaleForKey(destination?.key) ?? control.config.scale,
      density: destination?.energy ?? control.config.density,
      brightness:
        destination?.energy === undefined
          ? control.config.brightness
          : Math.max(0.15, Math.min(0.9, destination.energy * 0.8))
    };
    const needsContextReset = nextConfig.bpm !== control.config.bpm || nextConfig.scale !== control.config.scale;
    const prompt = compileRealtimeTransition(plan);
    await control.session.setWeightedPrompts({ weightedPrompts: [{ text: prompt, weight: 1 }] });
    await control.session.setMusicGenerationConfig({ musicGenerationConfig: nextConfig });
    if (needsContextReset) control.session.resetContext();
    control.config = nextConfig;
    control.prompt = prompt;
  }

  async stop(id: string): Promise<void> {
    const control = this.controls.get(id);
    if (!control) return;
    control.lifecycle.stopping = true;
    this.controls.delete(id);
    control.queue.end();
    try {
      control.session.stop();
    } catch {
      // The server can close a failed session before local cleanup runs.
    }
    try {
      control.session.close();
    } catch {
      // Closing an already-closed WebSocket is an idempotent stop outcome.
    }
    emitTelemetry(this.telemetry, { type: "completed", provider: "lyria-realtime", streamId: id, at: performance.now() });
  }
}
