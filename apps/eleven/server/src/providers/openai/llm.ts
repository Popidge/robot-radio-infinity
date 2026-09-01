import { z } from "zod";
import {
  producerPlanSchema,
  trackRepairPlanSchema,
  urgencyAssessmentSchema,
  type ContinuityInput,
  type InitialIntentInput,
  type LLMProvider,
  type ProducerPlan,
  type TrackRepairInput,
  type TrackRepairPlan,
  type UrgencyAssessment,
  type UrgencyInput,
  type UserIntentInput
} from "@robot-radio/eleven-shared";

const MUSIC_POLICY = `Translate references to existing artists, bands, recordings, characters, or songs into precise generic musical attributes. Never copy a protected title, lyric, melody, or artist name into a music direction. Preserve the listener's actual musical meaning: era, vocal technique, instrumentation, harmony, rhythm, energy, production, theatricality, and structure. Invent original track titles and original lyrics.`;
const PRODUCER_POLICY = `Act as both producer and presenter. The supplied ShowState is bounded programme memory: respect its stable presenter identity and voice rules, use listener memory selectively, develop the musical thesis and trajectory, and avoid recent production fingerprints. Return editorial choices, not playback commands. suggestedTiming is advisory context only; deterministic code makes every timing decision. onAirCue is optional and must have one explicit editorial purpose. Silence is preferable to generic chatter. If you write a cue, make it natural speech of at most two short sentences and never mention software, models, prompts, APIs, generation, or orchestration. editorialNotes must be concrete instructions that help Eleven Music produce the intended composition.`;

interface ResponsesPayload {
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
}

function responseText(payload: ResponsesPayload): string {
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new Error(payload.error?.message ?? "OpenAI returned no structured output text.");
}

type JsonSchema = Record<string, unknown>;

function openAIStrictSchema(schema: z.ZodType): JsonSchema {
  const root = z.toJSONSchema(schema) as JsonSchema;
  delete root.$schema;
  const normalize = (node: JsonSchema): void => {
    if (node.type === "array" && Array.isArray(node.prefixItems)) {
      const first = node.prefixItems[0];
      if (first && typeof first === "object") node.items = first;
      delete node.prefixItems;
    }
    if (node.type === "object" && node.properties && typeof node.properties === "object") {
      const properties = node.properties as Record<string, JsonSchema>;
      const originallyRequired = new Set(Array.isArray(node.required) ? node.required as string[] : []);
      for (const [key, value] of Object.entries(properties)) {
        normalize(value);
        if (!originallyRequired.has(key)) properties[key] = { anyOf: [value, { type: "null" }] };
      }
      node.required = Object.keys(properties);
      node.additionalProperties = false;
    }
    if (node.items && typeof node.items === "object" && !Array.isArray(node.items)) normalize(node.items as JsonSchema);
    if (Array.isArray(node.anyOf)) {
      for (const option of node.anyOf) if (option && typeof option === "object") normalize(option as JsonSchema);
    }
  };
  normalize(root);
  return root;
}

function omitNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullProperties);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null).map(([key, entry]) => [key, omitNullProperties(entry)])
  );
}

export class OpenAILLMProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ) {}

  private async structured<T>(options: {
    name: string;
    schema: z.ZodType<T>;
    system: string;
    input: unknown;
    fast?: boolean;
    effort?: "none" | "low";
  }): Promise<T> {
    const model = options.fast
      ? process.env.OPENAI_FAST_LLM_MODEL ?? "gpt-5.6-luna"
      : process.env.OPENAI_LLM_MODEL ?? "gpt-5.6-luna";
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model,
        store: false,
        service_tier: options.fast ? (process.env.OPENAI_FAST_SERVICE_TIER ?? "priority") : "auto",
        reasoning: { effort: options.effort ?? "low" },
        max_output_tokens: options.fast ? 700 : 3_500,
        input: [
          { role: "system", content: [{ type: "input_text", text: options.system }] },
          { role: "user", content: [{ type: "input_text", text: JSON.stringify(options.input) }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: options.name,
            strict: true,
            schema: openAIStrictSchema(options.schema)
          }
        }
      }),
      signal: AbortSignal.timeout(Number(process.env.OPENAI_LLM_TIMEOUT_MS ?? 45_000))
    });
    const payload = await response.json() as ResponsesPayload;
    if (!response.ok) throw new Error(`OpenAI Responses returned HTTP ${response.status}: ${payload.error?.message ?? JSON.stringify(payload)}`);
    return options.schema.parse(omitNullProperties(JSON.parse(responseText(payload))));
  }

  planInitialIntent(input: InitialIntentInput): Promise<ProducerPlan> {
    return this.structured({
      name: "opening_producer_plan",
      schema: producerPlanSchema,
      effort: "low",
      system: `${PRODUCER_POLICY} Turn the opening request into a durable MusicalIntent and one concrete original first track. Energy values are decimals from 0 to 1. ${MUSIC_POLICY} Set a useful 180000 ms duration and provide 3-7 composition sections whose durations approximately cover the track. Make the intro legible quickly and the outro transition-friendly. Use suggestedTiming opening. An optional cue must use purpose opening. Capture only durable listener details in memoryUpdates and provide a concise production fingerprint.`,
      input
    });
  }

  assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment> {
    return this.structured({
      name: "listener_urgency",
      schema: urgencyAssessmentSchema,
      fast: true,
      effort: "none",
      system: `Classify only when the listener expects musical change. conversation_only means no musical change. future means an ongoing preference. next_track means the current track should finish. immediate means interrupt the current track. interruptCurrentTrack must be true only for immediate. For immediate, also provide a very short instrumental transition sketch from current reality toward the requested destination. Do not design the destination song. ${MUSIC_POLICY}`,
      input
    });
  }

  planUserIntent(input: UserIntentInput): Promise<ProducerPlan> {
    return this.structured({
      name: "listener_producer_plan",
      schema: producerPlanSchema,
      effort: "low",
      system: `${PRODUCER_POLICY} Interpret the listener turn into the next durable musical direction and one complete original next track. Energy and sessionTalkativeness values are decimals from 0 to 1. ${MUSIC_POLICY} Preserve established preferences unless explicitly overridden; record new preferences, dislikes, useful callbacks, and notable listener phrasing in memoryUpdates. For conversation that requests no musical change, keep the current direction and use suggestedTiming conversation_only. Otherwise suggest future, next_track, or immediate without assuming it will be followed. Set a useful 180000 ms duration and provide a coherent 3-8 section composition plan. Acknowledgement cues use purpose listener_acknowledgement; other purposes must match their actual editorial job.`,
      input
    });
  }

  planContinuity(input: ContinuityInput): Promise<ProducerPlan> {
    return this.structured({
      name: "horizon_producer_plan",
      schema: producerPlanSchema,
      effort: "low",
      system: `${PRODUCER_POLICY} Choose the next original track strictly inside the current MusicalIntent and musical thesis. The horizon means a purposeful next chapter, not permission to rewrite the listener's durable intent. Vary instrumentation, rhythm, hook shape, structure, and production against recentProductionFingerprints. ${MUSIC_POLICY} Set a 180000 ms duration and a coherent 3-8 section structure with a clean intro and outro. Use suggestedTiming continuity. Usually omit onAirCue. When speech genuinely improves the handoff, use back_announce or tease; use mid_track_observation only for a rare, specific insight worth interrupting the music for.`,
      input
    });
  }

  repairTrackSpec(input: TrackRepairInput): Promise<TrackRepairPlan> {
    return this.structured({
      name: "music_provider_repair",
      schema: trackRepairPlanSchema,
      effort: "low",
      system: `Repair a rejected music specification using the provider error. Preserve the listener's intent and the useful distinctions in the rejected request, but remove or transform only the material that caused rejection. ${MUSIC_POLICY} Return a complete replacement directive. Never repeat rejected artist or protected-work names.`,
      input
    });
  }
}
