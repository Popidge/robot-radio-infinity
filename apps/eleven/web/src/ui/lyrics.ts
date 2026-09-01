import type { TrackSection } from "@robot-radio/eleven-shared";
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

export function buildLyricCues(sections: TrackSection[] | undefined, durationMs: number | null): LyricCue[] {
  if (!sections?.length || !durationMs || durationMs <= 0) return [];
  const durations = normalizedDurations(sections, durationMs);
  const cues: LyricCue[] = [];
  let sectionStartMs = 0;

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
        const startMs = sectionStartMs + leadInMs + lineIndex * lineDurationMs;
        cues.push({
          text,
          startMs,
          endMs: Math.min(sectionStartMs + sectionDurationMs, startMs + lineDurationMs - 120),
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
