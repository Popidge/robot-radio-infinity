import type {
  ContinuityInput,
  InitialIntentInput,
  LLMProvider,
  ProducerPlan,
  TrackRepairInput,
  TrackRepairPlan,
  TrackDirective,
  UrgencyAssessment,
  UrgencyInput,
  UserIntentInput
} from "@robot-radio/eleven-shared";

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
  const wantsVocals = includesAny(normalized, ["vocal", "lyrics", "sing", "singer", "song"]);
  return {
    title: titleFromMessage(message),
    description: message,
    styles: styles.length ? styles : ["adaptive electronica"],
    mood: heavy ? ["intense", "dark"] : calm ? ["calm", "spacious"] : ["focused", "kinetic"],
    energy: heavy ? 0.9 : calm ? 0.3 : 0.65,
    bpm: heavy ? 148 : calm ? 88 : 118,
    key: heavy ? "D minor" : calm ? "A minor" : "E minor",
    vocals: wantsVocals ? "original expressive lead vocals" : "instrumental",
    language: wantsVocals ? "English" : undefined,
    durationMs: 45_000,
    sections: wantsVocals ? [
      { name: "Intro", durationMs: 8_000, description: "Establish the hook with one clear opening vocal line.", lyrics: "Turn the dial until the room comes through", transitionFriendly: true },
      { name: "Verse", durationMs: 14_000, description: "Bring the vocal close and rhythmic.", lyrics: "I found a signal in the afterglow\nPulled it apart just to watch it grow" },
      { name: "Chorus", durationMs: 13_000, description: "Open into a direct, memorable refrain.", lyrics: "Keep the signal alive\nTurn the noise into light" },
      { name: "Outro", durationMs: 10_000, description: "Return to the hook and leave a clean handoff.", transitionFriendly: true }
    ] : undefined
  };
}

function fingerprint(directive: TrackDirective): string {
  return `${directive.title}: ${(directive.styles ?? []).join(", ")}; ${(directive.mood ?? []).join(", ")}; ${directive.bpm ?? "flexible"} BPM; ${directive.description}`.slice(0, 300);
}

export class MockLLMProvider implements LLMProvider {
  async planInitialIntent(input: InitialIntentInput): Promise<ProducerPlan> {
    await delay(Number(process.env.MOCK_URGENCY_LATENCY_MS ?? 180));
    const directive = directiveFromMessage(input.message);
    const intent = {
      description: directive.description,
      styles: directive.styles ?? ["adaptive electronica"],
      mood: directive.mood ?? ["focused"],
      energy: directive.energy,
      bpmRange: directive.bpm ? [directive.bpm - 6, directive.bpm + 6] as [number, number] : undefined,
      keyPreference: directive.key,
      vocals: directive.vocals ?? "instrumental",
      language: directive.language
    };
    return {
      musicalDirection: { intent, nextTrack: { ...directive, durationMs: 180_000 } },
      onAirCue: { text: "You’ve found Robot Radio Infinity. Let’s build this signal around you.", purpose: "opening" },
      memoryUpdates: {
        listener: { preferences: [input.message], notablePhrases: [input.message] },
        musicalThesis: directive.description,
        intendedTrajectory: ["Establish the requested world", "Develop it through contrasting arrangement choices"],
        productionFingerprint: fingerprint(directive)
      },
      editorialNotes: ["Establish a distinctive original hook in the first eight seconds", "Leave a clean, lower-density outro for the next radio handoff"],
      suggestedTiming: "opening"
    };
  }

  async assessUrgency(input: UrgencyInput): Promise<UrgencyAssessment> {
    await delay(Number(process.env.MOCK_URGENCY_LATENCY_MS ?? 180));
    const message = input.message.toLowerCase();
    if (includesAny(message, ["great", "love this", "nice", "thanks", "thank you"])) {
      return { timing: "conversation_only", interruptCurrentTrack: false, confidence: 0.96 };
    }
    if (includesAny(message, ["fuck", "right now", "immediately", "stop this", "switch this", "change this"])) {
      return {
        timing: "immediate",
        interruptCurrentTrack: true,
        confidence: 0.97,
        immediateTransition: {
          description: `Leave the current track cleanly and transform toward ${input.message}.`,
          sourceSummary: input.currentTrack?.styleSummary ?? input.currentIntent.description,
          destinationSketch: input.message,
          energyDirection: includesAny(message, ["calm", "soft", "slower"]) ? "down" : includesAny(message, ["heavy", "hard", "faster"]) ? "up" : "steady"
        }
      };
    }
    if (includesAny(message, ["next one", "next track", "next song"])) {
      return { timing: "next_track", interruptCurrentTrack: false, confidence: 0.94 };
    }
    return { timing: "future", interruptCurrentTrack: false, confidence: 0.84 };
  }

  async planUserIntent(input: UserIntentInput): Promise<ProducerPlan> {
    await delay(Number(process.env.MOCK_PLANNER_LATENCY_MS ?? 850));
    const message = input.message.toLowerCase();
    const directive = directiveFromMessage(input.message);
    const isConversation = includesAny(message, ["great", "love this", "nice", "thanks", "thank you"]);

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

    const nextTrack = isConversation
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
      : { ...directive, durationMs: 180_000 };
    const suggestedTiming = isConversation ? "conversation_only" as const
      : includesAny(message, ["right now", "immediately", "switch this", "change this"]) ? "immediate" as const
      : includesAny(message, ["next one", "next track", "next song"]) ? "next_track" as const
      : "future" as const;
    return {
      musicalDirection: { intent: destinationIntent, nextTrack },
      onAirCue: {
        text: isConversation ? "I hear you. I’ll keep the signal moving." : `I’ve got it — ${directive.title} is where we’re heading.`,
        purpose: "listener_acknowledgement"
      },
      memoryUpdates: {
        listener: isConversation
          ? { callbacks: [input.message], notablePhrases: [input.message] }
          : { preferences: [input.message], notablePhrases: [input.message] },
        musicalThesis: destinationIntent.description,
        intendedTrajectory: ["Respond to the latest listener direction", "Preserve continuity while making the change unmistakable"],
        productionFingerprint: fingerprint(nextTrack)
      },
      editorialNotes: ["Make the requested change audible in the opening phrase", "Use a distinct hook and arrangement from recent production fingerprints"],
      suggestedTiming
    };
  }

  async planContinuity(input: ContinuityInput): Promise<ProducerPlan> {
    await delay(Number(process.env.MOCK_PLANNER_LATENCY_MS ?? 850));
    const intent = input.currentIntent;
    const chapter = input.showState.recentProductionFingerprints.length;
    const energyShift = chapter % 2 === 0 ? 0.05 : -0.04;
    const energy = Math.min(1, Math.max(0, (intent.energy ?? 0.6) + energyShift));
    const shouldSpeak =
      input.showState.speechCadence.sessionTalkativeness >= 0.55 &&
      chapter > 0 &&
      chapter % 3 === 0 &&
      input.showState.speechCadence.lastCuePurpose !== "tease";
    const nextTrack: TrackDirective = {
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
    };
    return {
      musicalDirection: { intent, nextTrack },
      onAirCue: shouldSpeak ? { text: `Coming up: ${nextTrack.title}.`, purpose: "tease" } : undefined,
      memoryUpdates: {
        intendedTrajectory: ["Stay inside the current thesis", "Change the dominant production fingerprint"],
        productionFingerprint: fingerprint(nextTrack)
      },
      editorialNotes: ["Avoid the instrumentation and hook shape in recent production fingerprints", "Keep the intro immediately legible and the outro crossfade-friendly"],
      suggestedTiming: "continuity"
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
