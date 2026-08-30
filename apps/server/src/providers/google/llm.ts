import { GoogleGenAI } from "@google/genai";
import {
  continuityPlanSchema,
  initialIntentPlanSchema,
  urgencyAssessmentSchema,
  userIntentPlanSchema,
  type ContinuityInput,
  type ContinuityPlan,
  type InitialIntentInput,
  type InitialIntentPlan,
  type LLMProvider,
  type UrgencyAssessment,
  type UrgencyInput,
  type UserIntentInput,
  type UserIntentPlan
} from "@robot-radio/shared";
import { z, type ZodType } from "zod";

const URGENCY_INSTRUCTION = `You classify only when a radio listener expects a requested change.
Do not design music, write DJ dialogue, or plan a transition.
Use conversation_only for praise or chat with no requested change.
Use future for a persistent preference that need not interrupt this track.
Use next_track when the listener explicitly refers to the next song.
Use immediate only when the listener clearly rejects or redirects the current music.`;

const INITIAL_INTENT_INSTRUCTION = `Convert the listener's opening request into one complete semantic musical intent.
Keep descriptions and list items concise. Do not select providers, transitions, gain values, buffers, fades, or DSP parameters.`;

const USER_PLAN_INSTRUCTION = `You are the musical policy planner for an AI radio station.
Always return a complete destinationIntent, a complete nextTrack directive, a transition, and a DJ decision.
The separate urgency classifier owns timing. Do not classify the request as immediate, future, or next-track.
Plan the transition even when deterministic code can later ignore it.
Preserve current preferences unless the listener changes them. Keep DJ text and all string fields concise.
Do not choose gain values, buffers, fades, provider options, or DSP parameters.`;

const CONTINUITY_INSTRUCTION = `You plan the next item in a continuous AI radio station.
Preserve the current vibe by default. Most transitions must be simple_fade.
Use lyria_bridge only for a substantial musical change. Do not make buffer or playback decisions.`;

export class GoogleLLMProvider implements LLMProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly fastModel: string;
  private readonly fastThinkingLevel: "minimal" | "low" | "medium" | "high";

  constructor(
    apiKey: string,
    model = process.env.GEMINI_LLM_MODEL ?? "gemini-3.7-flash",
    fastModel = process.env.GEMINI_FAST_LLM_MODEL ?? "gemini-3.5-flash-lite"
  ) {
    this.client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
    this.model = model;
    this.fastModel = fastModel;
    const configuredLevel = process.env.GEMINI_FAST_LLM_THINKING_LEVEL ?? "minimal";
    if (!(["minimal", "low", "medium", "high"] as const).includes(configuredLevel as typeof this.fastThinkingLevel)) {
      throw new Error(`GEMINI_FAST_LLM_THINKING_LEVEL is invalid: ${configuredLevel}`);
    }
    this.fastThinkingLevel = configuredLevel as typeof this.fastThinkingLevel;
  }

  planInitialIntent(input: InitialIntentInput): Promise<InitialIntentPlan> {
    return this.generateStructured(
      INITIAL_INTENT_INSTRUCTION,
      input,
      initialIntentPlanSchema,
      this.fastModel,
      this.fastThinkingLevel
    );
  }

  assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment> {
    return this.generateStructured(
      URGENCY_INSTRUCTION,
      input,
      urgencyAssessmentSchema,
      this.fastModel,
      this.fastThinkingLevel
    );
  }

  planUserIntent(input: UserIntentInput): Promise<UserIntentPlan> {
    return this.generateStructured(USER_PLAN_INSTRUCTION, input, userIntentPlanSchema);
  }

  planContinuity(input: ContinuityInput): Promise<ContinuityPlan> {
    return this.generateStructured(CONTINUITY_INSTRUCTION, input, continuityPlanSchema);
  }

  private async generateStructured<T>(
    systemInstruction: string,
    input: unknown,
    schema: ZodType<T>,
    model = this.model,
    thinkingLevel: "minimal" | "low" | "medium" | "high" = "low"
  ): Promise<T> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const response = await this.client.interactions.create(
      {
        model,
        input: JSON.stringify(input),
        system_instruction: systemInstruction,
        response_format: { type: "text", mime_type: "application/json", schema: jsonSchema },
        generation_config: { thinking_level: thinkingLevel },
        store: false
      },
      { timeout: Number(process.env.GEMINI_LLM_TIMEOUT_MS ?? 30_000) }
    );
    if (!response.output_text) throw new Error(`Gemini model ${model} returned no structured text`);
    return schema.parse(JSON.parse(response.output_text));
  }
}
