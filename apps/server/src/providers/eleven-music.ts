import type { MusicProvider, MusicStream, TrackSection, TrackSpec, TransitionProvider, TransitionSpec } from "@robot-radio/shared";
import { fixtureSeed } from "../fixtures/waveforms";
import { decodeAudioResponse, type DecodedAudioStream } from "./incremental-audio";
import { CHANNELS, SAMPLE_RATE, createFixtureStream, type StreamControl } from "./stream-utils";

interface CompositionChunk {
  text: string;
  duration_ms: number;
  positive_styles: string[];
  negative_styles: string[];
  context_adherence: "high";
}

interface ActiveRequest { controller: AbortController; decoder?: DecodedAudioStream }

function defaultSections(spec: TrackSpec): TrackSection[] {
  const intro = Math.max(8_000, Math.round(spec.durationMs * 0.12));
  const outro = Math.max(10_000, Math.round(spec.durationMs * 0.14));
  const middle = Math.max(8_000, spec.durationMs - intro - outro);
  return [
    { name: "Intro", durationMs: intro, description: "Establish the original hook quickly, with room for a radio link and a smooth entrance.", transitionFriendly: true },
    { name: "Development", durationMs: middle, description: "Develop the hook through a coherent full arrangement with purposeful musical changes." },
    { name: "Outro", durationMs: outro, description: "Resolve the phrase, reduce density, and end cleanly without silence.", transitionFriendly: true }
  ];
}

function normalizedSections(spec: TrackSpec): TrackSection[] {
  const source = spec.sections?.length ? spec.sections : defaultSections(spec);
  const total = source.reduce((sum, section) => sum + section.durationMs, 0);
  if (total <= 0) return defaultSections(spec);
  let used = 0;
  return source.map((section, index) => {
    const durationMs = index === source.length - 1
      ? Math.max(1_000, spec.durationMs - used)
      : Math.max(1_000, Math.round((section.durationMs / total) * spec.durationMs));
    used += durationMs;
    return { ...section, durationMs };
  });
}

function vocalDirection(spec: TrackSpec, section: TrackSection): string {
  const vocals = spec.vocals?.trim();
  if (!vocals || /instrumental|no vocals/i.test(vocals)) return "[Instrumental] No sung or spoken words.";
  const lyrics = section.lyrics?.trim();
  return lyrics ? `[Original vocals in ${spec.language ?? "the requested language"}]\n${lyrics}` : `Original vocals: ${vocals}. Language: ${spec.language ?? "appropriate to the musical direction"}.`;
}

function trackPlan(spec: TrackSpec): { chunks: CompositionChunk[] } {
  return {
    chunks: normalizedSections(spec).map((section) => ({
      text: [
        `[${section.name}]`,
        `Working title: "${spec.title}".`,
        spec.description,
        section.description,
        vocalDirection(spec, section),
        section.transitionFriendly ? "Make the section boundary clean and useful for radio crossfading." : ""
      ].filter(Boolean).join("\n"),
      duration_ms: section.durationMs,
      positive_styles: [
        ...spec.styles,
        ...spec.mood,
        `${Math.round(spec.bpm)} BPM`,
        spec.key,
        "original composition",
        "coherent arrangement",
        "radio-ready production",
        section.transitionFriendly ? "smooth section boundary" : "purposeful musical development"
      ],
      negative_styles: ["named artist imitation", "copyrighted melody", "long silence", "abrupt truncation"],
      context_adherence: "high"
    }))
  };
}

function transitionPlan(spec: TransitionSpec): { chunks: CompositionChunk[] } {
  const departure = Math.round(spec.durationMs * 0.28);
  const arrival = Math.round(spec.durationMs * 0.32);
  const morph = spec.durationMs - departure - arrival;
  const common = ["instrumental radio bed", "polished production", "coherent harmonic movement", `${Math.round(spec.bpm)} BPM`];
  const negative = ["lead vocals", "backing vocals", "spoken words", "abrupt edit", "hard stop", "silence", "sound effects montage"];
  return {
    chunks: [
      {
        text: `[Instrumental departure]\nBegin inside this musical world: ${spec.sourceSummary}. ${spec.description} Remove melodic density early and create clean space for a DJ voice.`,
        duration_ms: departure,
        positive_styles: [...common, ...spec.styles.slice(0, 3), "stable departure groove", "space for speech"],
        negative_styles: negative,
        context_adherence: "high"
      },
      {
        text: `[Instrumental transformation]\nGradually and musically transform from ${spec.sourceSummary} toward ${spec.destinationSummary}. Avoid a collage or hard genre switch.`,
        duration_ms: morph,
        positive_styles: [...common, ...spec.mood, "gradual timbral transformation", "DJ-friendly transition"],
        negative_styles: negative,
        context_adherence: "high"
      },
      {
        text: `[Instrumental arrival]\nArrive clearly in this destination: ${spec.destinationSummary}. End on a stable continuing phrase that can crossfade cleanly into the next full track.`,
        duration_ms: arrival,
        positive_styles: [...common, ...spec.styles.slice(-3), "clear destination identity", "crossfade-ready ending"],
        negative_styles: negative,
        context_adherence: "high"
      }
    ]
  };
}

async function errorPayload(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 12_000);
  try { return JSON.stringify(JSON.parse(text)) } catch { return text }
}

export class ElevenMusicApiProvider implements MusicProvider, TransitionProvider {
  private readonly active = new Map<string, ActiveRequest>();

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io"
  ) {}

  generate(spec: TrackSpec, _generationRate: number): Promise<MusicStream>;
  generate(spec: TransitionSpec, _generationRate: number): Promise<MusicStream>;
  async generate(spec: TrackSpec | TransitionSpec, _generationRate: number): Promise<MusicStream> {
    await this.cancel(spec.id);
    const controller = new AbortController();
    const active: ActiveRequest = { controller };
    this.active.set(spec.id, active);
    const isTransition = "instrumental" in spec;
    const timeout = setTimeout(() => controller.abort(new Error("Eleven Music did not finish within the configured timeout.")), Number(process.env.ELEVENLABS_MUSIC_TIMEOUT_MS ?? 240_000));
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/music/stream?output_format=mp3_48000_128`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": this.apiKey },
        body: JSON.stringify({
          model_id: process.env.ELEVENLABS_MUSIC_MODEL ?? "music_v2",
          composition_plan: isTransition ? transitionPlan(spec) : trackPlan(spec),
          store_for_inpainting: false
        }),
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      this.active.delete(spec.id);
      throw error;
    }
    if (!response.ok) {
      clearTimeout(timeout);
      this.active.delete(spec.id);
      throw new Error(`Eleven Music rejected ${isTransition ? "transition" : "track"} ${spec.id} with HTTP ${response.status}: ${await errorPayload(response)}`);
    }
    if (!response.body) {
      clearTimeout(timeout);
      this.active.delete(spec.id);
      throw new Error("Eleven Music returned no audio body.");
    }
    const decoder = decodeAudioResponse(response.body);
    active.decoder = decoder;
    void decoder.completed.finally(() => { clearTimeout(timeout); if (this.active.get(spec.id) === active) this.active.delete(spec.id) });
    return { id: spec.id, sampleRate: 48_000, channels: 2, durationMs: spec.durationMs, chunks: decoder.chunks };
  }

  async cancel(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    active.controller.abort();
    active.decoder?.stop();
  }
}

export class MockElevenMusicProvider implements MusicProvider, TransitionProvider {
  private readonly controls = new Map<string, StreamControl>();

  async generate(spec: TrackSpec | TransitionSpec, generationRate: number): Promise<MusicStream> {
    const control: StreamControl = {
      cancelled: false,
      parameters: {
        kind: "music",
        bpm: spec.bpm,
        energy: spec.energy,
        seed: fixtureSeed(`${spec.id}:${spec.description}`)
      },
      startupLatencyMs: Number(process.env.MOCK_MUSIC_STARTUP_MS ?? 450),
      failAfterMs: process.env.MOCK_MUSIC_FAIL_AFTER_MS ? Number(process.env.MOCK_MUSIC_FAIL_AFTER_MS) : undefined,
      starveAtMs: process.env.MOCK_MUSIC_STARVE_AT_MS ? Number(process.env.MOCK_MUSIC_STARVE_AT_MS) : undefined,
      starveForMs: process.env.MOCK_MUSIC_STARVE_FOR_MS ? Number(process.env.MOCK_MUSIC_STARVE_FOR_MS) : undefined
    };
    this.controls.set(spec.id, control);
    return { id: spec.id, sampleRate: SAMPLE_RATE, channels: CHANNELS, durationMs: spec.durationMs, chunks: createFixtureStream(control, spec.durationMs, generationRate) };
  }

  async cancel(id: string): Promise<void> {
    const control = this.controls.get(id);
    if (control) control.cancelled = true;
    this.controls.delete(id);
  }
}

export type ElevenMusicProvider = MusicProvider;
