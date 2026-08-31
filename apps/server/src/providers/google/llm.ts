import { GoogleGenAI } from "@google/genai";
import {
  continuityPlanSchema,
  initialIntentPlanSchema,
  trackRepairPlanSchema,
  urgencyAssessmentSchema,
  userIntentPlanSchema,
  type ContinuityInput,
  type ContinuityPlan,
  type InitialIntentInput,
  type InitialIntentPlan,
  type LLMProvider,
  type TrackRepairInput,
  type TrackRepairPlan,
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

const PROVIDER_SAFE_MUSIC = `Copyright and provider-safety rule:
Never put a real artist, band, song, album, record label, fictional franchise, or other protected proper name in provider-bound intent, track, transition, title, or keyframe fields.
When the listener names a reference, silently translate it into concrete generic attributes such as instrumentation, vocal character, era, harmony, rhythm, production texture, mood, and performance energy.
Create an original direction. Do not request imitation, melodic copying, lyrical copying, soundalikes, or "in the style of" any named work or person.`;

const DJ_PERSONA = `The DJ is a warm, curious, lightly mischievous late-night radio curator, not a chatbot or a hype announcer.
DJ speech is optional and must be one natural sentence of at most 24 words.
Use the recent listener messages, track records, and DJ lines as a small rolling memory. Acknowledge genuine preferences and avoid repeating wording or observations.
Never invent facts about music, the listener, or what the models are doing.`;

const TRACK_TITLE_INSTRUCTION = `Give every track an original, evocative title of roughly two to seven words.
The title is creative context for music and possible lyrics, not a summary sentence. Keep it distinct from recent track titles.
Recent track records are authoritative station memory. Use their titles and descriptions to resolve listener references to earlier music.`;

const INITIAL_INTENT_INSTRUCTION = `Convert the listener's opening request into one complete semantic musical intent.
Return the intent and an original firstTrackTitle for the first track that realizes it.
Keep descriptions and list items concise. Do not select providers, transitions, gain values, buffers, fades, or DSP parameters.
${TRACK_TITLE_INSTRUCTION}
${PROVIDER_SAFE_MUSIC}`;

const USER_PLAN_INSTRUCTION = `You are the musical policy planner for an AI radio station.
Always return a complete destinationIntent, a complete nextTrack directive, a transition, and a DJ decision.
The separate urgency classifier owns timing. Do not classify the request as immediate, future, or next-track.
Plan the transition even when deterministic code can later ignore it.
Preserve current preferences unless the listener changes them. Keep DJ text and all string fields concise.
Do not choose gain values, buffers, fades, provider options, or DSP parameters.
${TRACK_TITLE_INSTRUCTION}
${PROVIDER_SAFE_MUSIC}
${DJ_PERSONA}`;

const CONTINUITY_INSTRUCTION = `You plan the next item in a continuous AI radio station.
Preserve the listener's core intent, but gently curate: vary arrangement, rhythm, harmony, density, or energy so consecutive tracks do not feel cloned.
You may introduce one adjacent musical idea at a time when it fits the established taste. Use recent history to avoid repetition.
Most transitions must be simple_fade. Use lyria_bridge only for a substantial musical change.
Use dj_link sparingly when the current intent's djTalkativeness and recent silence make a short link feel natural.
Do not make buffer or playback decisions.
${TRACK_TITLE_INSTRUCTION}
${PROVIDER_SAFE_MUSIC}
${DJ_PERSONA}`;

const TRACK_REPAIR_INSTRUCTION = `A music provider rejected or failed to generate a planned track.
Read the exact providerError and repair the rejectedSpec while preserving the listener's currentIntent as closely as possible.
Change only the likely cause of rejection. If a named artist, band, song, album, or copyrighted work caused the rejection, translate that reference into concrete generic musical attributes.
Do not erase legitimate generic descriptions such as eras, genres, instrumentation, "80s rock opera", vocal range, theatricality, or production techniques.
If the error appears transient or technical rather than prompt-related, return an equivalent track directive so deterministic code can retry it unchanged.
Return one complete provider-safe track directive. Do not discuss the error or include repair notes in musical fields.
Preserve the rejected track title unless that title is the likely cause of rejection.
${TRACK_TITLE_INSTRUCTION}
${PROVIDER_SAFE_MUSIC}`;

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

  repairTrackSpec(input: TrackRepairInput): Promise<TrackRepairPlan> {
    return this.generateStructured(TRACK_REPAIR_INSTRUCTION, input, trackRepairPlanSchema);
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
