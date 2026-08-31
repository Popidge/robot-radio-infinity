import type {
  ContinuityInput,
  ContinuityPlan,
  InitialIntentInput,
  InitialIntentPlan,
  LLMProvider,
  TrackRepairInput,
  TrackRepairPlan,
  TrackDirective,
  UrgencyAssessment,
  UrgencyInput,
  UserIntentInput,
  UserIntentPlan
} from "@robot-radio/google-shared";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function includesAny(message: string, values: string[]): boolean {
  return values.some((value) => message.includes(value));
}

function titleFromMessage(message: string): string {
  const words = message
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 5);
  return words.length
    ? words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`).join(" ")
    : "A New Signal";
}

function directiveFromMessage(message: string): TrackDirective {
  const normalized = message.toLowerCase();
  const styles = ["ambient", "techno", "jazz", "reggae", "death metal", "house", "disco", "drum and bass"]
    .filter((style) => normalized.includes(style));
  if (normalized.includes("death-reggae")) styles.push("death-reggae");
  if (normalized.includes("german")) styles.push("German underground");
  const heavy = includesAny(normalized, ["heavy", "death", "hard", "aggressive"]);
  const calm = includesAny(normalized, ["calm", "soft", "ambient", "gentle"]);
  return {
    title: titleFromMessage(message),
    description: message,
    styles: styles.length ? styles : ["adaptive electronica"],
    mood: heavy ? ["intense", "dark"] : calm ? ["calm", "spacious"] : ["focused", "kinetic"],
    energy: heavy ? 0.9 : calm ? 0.3 : 0.65,
    bpm: heavy ? 148 : calm ? 88 : 118,
    key: heavy ? "D minor" : calm ? "A minor" : "E minor",
    durationMs: 45_000
  };
}

export class MockLLMProvider implements LLMProvider {
  async planInitialIntent(input: InitialIntentInput): Promise<InitialIntentPlan> {
    await delay(Number(process.env.MOCK_URGENCY_LATENCY_MS ?? 180));
    const directive = directiveFromMessage(input.message);
    return {
      intent: {
        description: directive.description,
        styles: directive.styles ?? ["adaptive electronica"],
        mood: directive.mood ?? ["focused"],
        energy: directive.energy,
        bpmRange: directive.bpm ? [directive.bpm - 6, directive.bpm + 6] : undefined,
        keyPreference: directive.key,
        vocals: directive.vocals ?? "instrumental",
        language: directive.language,
        djTalkativeness: 0.35
      },
      firstTrackTitle: directive.title
    };
  }

  async assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment> {
    await delay(Number(process.env.MOCK_URGENCY_LATENCY_MS ?? 180));
    const message = input.message.toLowerCase();
    if (includesAny(message, ["great", "love this", "nice", "thanks", "thank you"])) {
      return { timing: "conversation_only", interruptCurrentTrack: false, confidence: 0.96 };
    }
    if (includesAny(message, ["fuck", "right now", "immediately", "stop this", "switch this", "change this"])) {
      return { timing: "immediate", interruptCurrentTrack: true, confidence: 0.97 };
    }
    if (includesAny(message, ["next one", "next track", "next song"])) {
      return { timing: "next_track", interruptCurrentTrack: false, confidence: 0.94 };
    }
    return { timing: "future", interruptCurrentTrack: false, confidence: 0.84 };
  }

  async planUserIntent(input: UserIntentInput): Promise<UserIntentPlan> {
    await delay(Number(process.env.MOCK_PLANNER_LATENCY_MS ?? 850));
    const message = input.message.toLowerCase();
    const directive = directiveFromMessage(input.message);
    const isConversation = includesAny(message, ["great", "love this", "nice", "thanks", "thank you"]);
    const speak = includesAny(message, ["dj", "announce", "tell me", "introduce"]);

    const destinationIntent = isConversation
      ? input.currentIntent
      : {
          ...input.currentIntent,
          description: directive.description,
          styles: directive.styles ?? input.currentIntent.styles,
          mood: directive.mood ?? input.currentIntent.mood,
          energy: directive.energy,
          bpmRange: directive.bpm ? ([directive.bpm - 6, directive.bpm + 6] as [number, number]) : input.currentIntent.bpmRange,
          keyPreference: directive.key,
          vocals: directive.vocals ?? input.currentIntent.vocals
        };

    return {
      destinationIntent,
      nextTrack: isConversation
        ? {
            title: input.currentTrack?.title ?? "Hold This Feeling",
            description: input.currentIntent.description,
            styles: input.currentIntent.styles,
            mood: input.currentIntent.mood,
            energy: input.currentIntent.energy,
            bpm: input.currentIntent.bpmRange
              ? Math.round((input.currentIntent.bpmRange[0] + input.currentIntent.bpmRange[1]) / 2)
              : undefined,
            key: input.currentIntent.keyPreference,
            vocals: input.currentIntent.vocals,
            durationMs: 180_000
          }
        : { ...directive, durationMs: 180_000 },
      transition: {
        sourceSummary: input.currentTrack?.styleSummary ?? input.currentIntent.description,
        destinationSummary: destinationIntent.description,
        suggestedDurationMs: 4_000,
        lyriaKeyframes: [
          { at: 0, description: input.currentTrack?.styleSummary ?? input.currentIntent.description },
          {
            at: 1,
            description: destinationIntent.description,
            energy: destinationIntent.energy,
            bpm: directive.bpm,
            key: destinationIntent.keyPreference
          }
        ]
      },
      dj: speak
        ? { speak: true, text: `All right — let’s bend the signal toward ${directive.description}.` }
        : { speak: false }
    };
  }

  async planContinuity(input: ContinuityInput): Promise<ContinuityPlan> {
    await delay(Number(process.env.MOCK_PLANNER_LATENCY_MS ?? 850));
    const intent = input.currentIntent;
    const chapter = input.recentTracks.length;
    const energyShift = chapter % 2 === 0 ? 0.05 : -0.04;
    const energy = Math.min(1, Math.max(0, (intent.energy ?? 0.6) + energyShift));
    const shouldSpeak =
      (intent.djTalkativeness ?? 0.25) >= 0.3 &&
      chapter > 0 &&
      chapter % 3 === 0 &&
      input.recentDjLines.at(-1) !== "Same world, different corner — let’s see what is hiding over here.";
    return {
      nextTrack: {
        title: chapter % 2 === 0 ? "Signals Through Glass" : "The Turn Between Rooms",
        description: `${chapter % 2 === 0 ? "A spacious" : "A rhythm-led"} variation of ${intent.description}`,
        styles: intent.styles,
        mood: intent.mood,
        energy,
        bpm: intent.bpmRange
          ? Math.round((intent.bpmRange[0] + intent.bpmRange[1]) / 2) + (chapter % 2 === 0 ? 2 : -2)
          : 116,
        key: intent.keyPreference ?? "E minor",
        vocals: intent.vocals,
        language: intent.language,
        durationMs: 45_000
      },
      transition: { type: shouldSpeak ? "dj_link" : "simple_fade" },
      dj: shouldSpeak
        ? { speak: true, text: "Same world, different corner — let’s see what is hiding over here." }
        : { speak: false }
    };
  }

  async repairTrackSpec(input: TrackRepairInput): Promise<TrackRepairPlan> {
    await delay(Number(process.env.MOCK_PLANNER_LATENCY_MS ?? 850));
    const contentRejection = /copyright|artist|style|imitat|policy|safety|named|protected/i.test(input.providerError);
    if (!contentRejection) return { track: input.rejectedSpec };
    return {
      track: {
        ...input.rejectedSpec,
        description: "Original country and western with theatrical, wide-range rock vocals and dramatic harmonic movement",
        styles: input.rejectedSpec.styles,
        mood: input.rejectedSpec.mood,
        vocals: "theatrical, agile, wide-range rock vocals without imitating a specific performer"
      }
    };
  }
}
