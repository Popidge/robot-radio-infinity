import type { MusicWordTimestamp, TrackSection } from "@robot-radio/eleven-shared";
import { hashText } from "./visual-theme";

export interface LyricCue {
  text: string;
  startMs: number;
  endMs: number;
  rotationDeg: number;
  colourIndex: number;
}

function lyricLines(lyrics: string | undefined): string[] {
  return (lyrics ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line) && !/^\{[^}]+\}$/.test(line));
}

function normalizedDurations(sections: TrackSection[], durationMs: number): number[] {
  const declaredTotal = sections.reduce((sum, section) => sum + section.durationMs, 0);
  if (declaredTotal <= 0 || durationMs <= 0) return sections.map((section) => section.durationMs);
  let used = 0;
  return sections.map((section, index) => {
    const duration = index === sections.length - 1
      ? Math.max(1, durationMs - used)
      : Math.max(1, Math.round((section.durationMs / declaredTotal) * durationMs));
    used += duration;
    return duration;
  });
}

function normalizedWord(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function timestampWindow(
  text: string,
  timestamps: MusicWordTimestamp[],
  fromIndex: number
): { startMs: number; endMs: number; nextIndex: number } | undefined {
  const words = text.split(/\s+/).map(normalizedWord).filter(Boolean);
  if (!words.length) return undefined;
  const normalizedTimestamps = timestamps.map((timestamp) => normalizedWord(timestamp.word));
  for (let start = Math.max(0, fromIndex); start <= normalizedTimestamps.length - words.length; start += 1) {
    if (words.every((word, offset) => word === normalizedTimestamps[start + offset])) {
      const first = timestamps[start];
      const last = timestamps[start + words.length - 1];
      if (!first || !last) return undefined;
      return {
        startMs: Math.max(0, first.startMs - 80),
        endMs: Math.max(first.startMs + 700, last.endMs + 260),
        nextIndex: start + words.length
      };
    }
  }
  return undefined;
}

export function splitLyricForDisplay(text: string): [string, string?] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [text];
  let bestIndex = 1;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const firstLength = words.slice(0, index).join(" ").length;
    const secondLength = words.slice(index).join(" ").length;
    const difference = Math.abs(firstLength - secondLength);
    if (difference < bestDifference) {
      bestDifference = difference;
      bestIndex = index;
    }
  }
  return [words.slice(0, bestIndex).join(" "), words.slice(bestIndex).join(" ")];
}

export function buildLyricCues(
  sections: TrackSection[] | undefined,
  durationMs: number | null,
  wordTimestamps: MusicWordTimestamp[] | undefined = undefined
): LyricCue[] {
  if (!sections?.length || !durationMs || durationMs <= 0) return [];
  const durations = normalizedDurations(sections, durationMs);
  const cues: LyricCue[] = [];
  let sectionStartMs = 0;
  let timestampIndex = 0;

  sections.forEach((section, sectionIndex) => {
    const sectionDurationMs = durations[sectionIndex] ?? section.durationMs;
    const lines = lyricLines(section.lyrics);
    if (lines.length > 0) {
      const leadInMs = Math.min(1_000, sectionDurationMs * 0.08);
      const usableMs = Math.max(lines.length * 500, sectionDurationMs - leadInMs * 2);
      const lineDurationMs = usableMs / lines.length;
      lines.forEach((text, lineIndex) => {
        const signature = `${section.name}|${text}|${sectionIndex}|${lineIndex}`;
        const hash = hashText(signature);
        const fallbackStartMs = sectionStartMs + leadInMs + lineIndex * lineDurationMs;
        const exact = wordTimestamps?.length ? timestampWindow(text, wordTimestamps, timestampIndex) : undefined;
        if (exact) timestampIndex = exact.nextIndex;
        const startMs = exact?.startMs ?? fallbackStartMs;
        cues.push({
          text,
          startMs,
          endMs: exact?.endMs ?? Math.min(sectionStartMs + sectionDurationMs, startMs + lineDurationMs - 120),
          rotationDeg: [-8, -5, 4, 7][hash % 4] ?? 4,
          colourIndex: hash % 3
        });
      });
    }
    sectionStartMs += sectionDurationMs;
  });

  return cues;
}

export function activeLyricCue(cues: LyricCue[], playheadMs: number): LyricCue | undefined {
  return cues.find((cue) => playheadMs >= cue.startMs && playheadMs < cue.endMs);
}
