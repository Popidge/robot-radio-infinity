import type {
  MicWindow,
  MusicWordTimestamp,
  TrackPresentationMap,
  TrackSection,
  TrackSectionWindow,
  VocalRegion
} from "@robot-radio/eleven-shared";

const VOCAL_GROUP_GAP_MS = 3_200;
const MIC_EDGE_PAD_MS = 320;
const MIN_MIC_WINDOW_MS = 1_500;

function token(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}

function lyricTokens(section: TrackSection): string[] {
  return (section.lyrics ?? "").split(/\s+/).map(token).filter(Boolean);
}

function plannedSections(sections: TrackSection[] | undefined, durationMs: number): TrackSectionWindow[] {
  if (!sections?.length) {
    return [{ name: "Track", startMs: 0, endMs: durationMs, hasLyrics: true, transitionFriendly: false, confidence: 0.25 }];
  }
  const total = sections.reduce((sum, section) => sum + Math.max(0, section.durationMs), 0) || durationMs;
  let cursor = 0;
  return sections.map((section, index) => {
    const startMs = cursor;
    const endMs = index === sections.length - 1
      ? durationMs
      : Math.min(durationMs, Math.round(cursor + (section.durationMs / total) * durationMs));
    cursor = endMs;
    return {
      name: section.name,
      startMs,
      endMs,
      hasLyrics: lyricTokens(section).length > 0,
      transitionFriendly: section.transitionFriendly === true,
      confidence: 0.62
    };
  });
}

function observedWordsBySection(sections: TrackSection[] | undefined, timestamps: MusicWordTimestamp[]): MusicWordTimestamp[][] {
  if (!sections?.length) return [];
  let insideInstruction = false;
  const audibleTimestamps = timestamps.filter((stamp) => {
    const beginsInstruction = stamp.word.includes("{");
    const endsInstruction = stamp.word.includes("}");
    if (beginsInstruction) insideInstruction = true;
    const audible = !insideInstruction;
    if (endsInstruction) insideInstruction = false;
    return audible;
  });
  const normalized = audibleTimestamps.map((stamp) => ({ stamp, value: token(stamp.word) }));
  const result: MusicWordTimestamp[][] = sections.map(() => []);
  let providerCursor = 0;

  sections.forEach((section, sectionIndex) => {
    const wanted = lyricTokens(section);
    if (!wanted.length) return;
    let lyricCursor = 0;
    for (let index = providerCursor; index < normalized.length && lyricCursor < wanted.length; index += 1) {
      const candidate = normalized[index];
      if (!candidate?.value) continue;
      let match = -1;
      for (let lookahead = lyricCursor; lookahead < Math.min(wanted.length, lyricCursor + 8); lookahead += 1) {
        if (candidate.value === wanted[lookahead]) { match = lookahead; break }
      }
      if (match < 0) continue;
      result[sectionIndex]?.push(candidate.stamp);
      lyricCursor = match + 1;
      providerCursor = index + 1;
    }
  });
  return result;
}

function groupObservedWords(words: MusicWordTimestamp[], sectionName: string): VocalRegion[] {
  if (!words.length) return [];
  const regions: VocalRegion[] = [];
  let startMs = words[0]?.startMs ?? 0;
  let endMs = words[0]?.endMs ?? startMs;
  for (const stamp of words.slice(1)) {
    if (stamp.startMs - endMs > VOCAL_GROUP_GAP_MS) {
      regions.push({ startMs, endMs, sectionName, source: "observed", confidence: 0.94 });
      startMs = stamp.startMs;
    }
    endMs = Math.max(endMs, stamp.endMs);
  }
  regions.push({ startMs, endMs, sectionName, source: "observed", confidence: 0.94 });
  return regions;
}

function safeWindow(
  startMs: number,
  endMs: number,
  kind: MicWindow["kind"],
  source: MicWindow["source"],
  confidence: number
): MicWindow | null {
  const start = Math.max(0, Math.round(startMs));
  const end = Math.max(start, Math.round(endMs));
  return end - start >= MIN_MIC_WINDOW_MS ? { startMs: start, endMs: end, kind, source, confidence } : null;
}

function endStyle(sections: TrackSection[] | undefined): TrackPresentationMap["endStyle"] {
  const ending = sections?.at(-1);
  const text = `${ending?.name ?? ""} ${ending?.description ?? ""}`.toLowerCase();
  if (/cold|hard stop|abrupt|precise (?:final|stop)/.test(text)) return "cold";
  if (/fade/.test(text)) return "fade";
  if (/resolve|clean (?:end|ending)|final hit/.test(text)) return "resolved";
  return "unknown";
}

/**
 * Reconciles authored composition sections with timestamps actually observed from
 * Eleven Music. Provider timestamps that merely echo {instrumental} instructions
 * never become vocal markers because only authored lyric words are matched.
 */
export function buildTrackPresentationMap(
  trackId: string,
  durationMs: number,
  sections: TrackSection[] | undefined,
  wordTimestamps: MusicWordTimestamp[] = []
): TrackPresentationMap {
  const boundedDuration = Math.max(1, Math.round(durationMs));
  const sectionWindows = plannedSections(sections, boundedDuration);
  const observed = observedWordsBySection(sections, wordTimestamps);
  const vocalRegions = sectionWindows.flatMap((window, index) => {
    const groups = groupObservedWords(observed[index] ?? [], window.name);
    if (groups.length) return groups;
    return window.hasLyrics
      ? [{ startMs: window.startMs, endMs: window.endMs, sectionName: window.name, source: "planned" as const, confidence: 0.48 }]
      : [];
  });
  const observedRegions = vocalRegions.filter((region) => region.source === "observed");
  const firstObserved = observedRegions[0];
  const lastObserved = observedRegions.at(-1);
  const firstVocalMs = firstObserved?.startMs ?? vocalRegions[0]?.startMs;
  const lastVocalEndMs = lastObserved?.endMs ?? vocalRegions.at(-1)?.endMs;
  const safeMicWindows: MicWindow[] = [];

  sectionWindows.forEach((window, index) => {
    if (window.hasLyrics) return;
    const previous = [...vocalRegions].reverse().find((region) => region.endMs <= window.endMs);
    const following = vocalRegions.find((region) => region.startMs >= window.startMs);
    const startMs = index === 0
      ? 0
      : previous?.source === "observed" ? previous.endMs + MIC_EDGE_PAD_MS : window.startMs;
    const endMs = index === sectionWindows.length - 1
      ? boundedDuration
      : following?.source === "observed" ? following.startMs - MIC_EDGE_PAD_MS : window.endMs;
    const name = window.name.toLowerCase();
    const kind: MicWindow["kind"] = index === 0 || /intro|opening|ramp/.test(name)
      ? "intro"
      : index === sectionWindows.length - 1 || /outro|ending/.test(name) ? "outro" : "instrumental";
    const candidate = safeWindow(startMs, endMs, kind, observedRegions.length ? "reconciled" : "planned", observedRegions.length ? 0.9 : 0.62);
    if (candidate) safeMicWindows.push(candidate);
  });

  for (let index = 1; index < observedRegions.length; index += 1) {
    const previous = observedRegions[index - 1];
    const current = observedRegions[index];
    if (!previous || !current) continue;
    const candidate = safeWindow(previous.endMs + MIC_EDGE_PAD_MS, current.startMs - MIC_EDGE_PAD_MS, "vocal_gap", "observed", 0.82);
    if (candidate && !safeMicWindows.some((window) => candidate.startMs >= window.startMs && candidate.endMs <= window.endMs)) {
      safeMicWindows.push(candidate);
    }
  }

  safeMicWindows.sort((left, right) => left.startMs - right.startMs);
  const intro = safeMicWindows.find((window) => window.kind === "intro");
  const outro = [...safeMicWindows].reverse().find((window) => window.kind === "outro");
  return {
    trackId,
    durationMs: boundedDuration,
    sections: sectionWindows,
    vocalRegions,
    safeMicWindows,
    introEndMs: intro?.endMs,
    firstVocalMs,
    lastVocalEndMs,
    outroStartMs: outro?.startMs,
    endStyle: endStyle(sections)
  };
}
