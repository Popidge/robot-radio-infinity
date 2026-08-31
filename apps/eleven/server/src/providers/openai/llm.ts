import { z } from "zod";
import {
  continuityPlanSchema,
  djLinePlanSchema,
  initialIntentPlanSchema,
  trackRepairPlanSchema,
  urgencyAssessmentSchema,
  userIntentPlanSchema,
  type ContinuityInput,
  type ContinuityPlan,
  type DJLineInput,
  type DJLinePlan,
  type InitialIntentInput,
  type InitialIntentPlan,
  type LLMProvider,
  type TrackRepairInput,
  type TrackRepairPlan,
  type UrgencyAssessment,
  type UrgencyInput,
  type UserIntentInput,
  type UserIntentPlan
} from "@robot-radio/eleven-shared";

const MUSIC_POLICY = `Translate references to existing artists, bands, recordings, characters, or songs into precise generic musical attributes. Never copy a protected title, lyric, melody, or artist name into a music direction. Preserve the listener's actual musical meaning: era, vocal technique, instrumentation, harmony, rhythm, energy, production, theatricality, and structure. Invent original track titles and original lyrics.`;

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

  planInitialIntent(input: InitialIntentInput): Promise<InitialIntentPlan> {
    return this.structured({
      name: "initial_station_plan",
      schema: initialIntentPlanSchema,
      effort: "low",
      system: `You are the musical director of an AI radio station. Turn the listener's opening vibe into a durable MusicalIntent and a concrete original first track. All energy and djTalkativeness values are decimal numbers from 0 to 1, never percentages. ${MUSIC_POLICY} Set a useful 180000 ms duration and provide 3-7 composition sections whose durations approximately cover the track. Make the intro legible quickly and the outro transition-friendly.`,
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

  planUserIntent(input: UserIntentInput): Promise<UserIntentPlan> {
    return this.structured({
      name: "listener_music_plan",
      schema: userIntentPlanSchema,
      effort: "low",
      system: `You are the station's musical director. Independently interpret the listener message into the next durable musical intent and one complete original next track. All energy and djTalkativeness values are decimal numbers from 0 to 1, never percentages. Do not decide timing and do not write DJ dialogue; separate code handles both. ${MUSIC_POLICY} Preserve unchanged preferences unless the listener overrides them. Set a useful 180000 ms track duration. Give the track a memorable original title and a 3-8 section composition plan. Sections must create a coherent intro, development, and clean transition-friendly outro. Do not put a named artist or protected work in any returned field.`,
      input
    });
  }

  planContinuity(input: ContinuityInput): Promise<ContinuityPlan> {
    return this.structured({
      name: "station_continuity_plan",
      schema: continuityPlanSchema,
      effort: "low",
      system: `Choose the next original track strictly inside the current MusicalIntent. The horizon means "more of this current vibe," not permission to alter the station's persistent intent. Omit intentPatch. Vary composition, instrumentation, hooks, and arrangement enough to avoid repetition while preserving the requested styles, mood, energy range, tempo range, vocals, and language. Use recent history to avoid repeating titles or musical ideas. ${MUSIC_POLICY} Set a 180000 ms duration and a coherent 3-8 section structure with a clean intro and outro. Choose dj_link sparingly; simple_fade is normal.`,
      input
    });
  }

  planDjLine(input: DJLineInput): Promise<DJLinePlan> {
    return this.structured({
      name: "radio_dj_line",
      schema: djLinePlanSchema,
      fast: true,
      effort: "none",
      system: `You are Robot Radio Infinity's warm, curious, slightly odd late-night AI DJ. Decide whether one brief spoken link genuinely improves the moment. Use the rolling history so you remember listener language and track titles, avoid repeating yourself, and sound like the same host. Speak at most two short sentences. Acknowledge requests naturally, but do not narrate software, models, prompts, APIs, or orchestration. Never claim a track already played if it did not. If silence is better, return speak false.`,
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
