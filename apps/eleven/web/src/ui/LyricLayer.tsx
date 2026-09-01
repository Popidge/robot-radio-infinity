import { useMemo, type CSSProperties } from "react";
import type { PlaybackState } from "@robot-radio/eleven-shared";
import { activeLyricCue, buildLyricCues } from "./lyrics";
import type { VisualTheme } from "./visual-theme";

interface LyricLayerProps {
  playback: PlaybackState;
  theme: VisualTheme;
}

export function LyricLayer({ playback, theme }: LyricLayerProps) {
  const cues = useMemo(
    () => buildLyricCues(playback.sections, playback.durationMs),
    [playback.durationMs, playback.sections]
  );
  const cue = activeLyricCue(cues, playback.playheadMs);
  if (!cue) return null;
  const colours = [theme.primary, theme.secondary, theme.accent];

  return (
    <div className="lyric-layer" aria-live="off" aria-hidden="true">
      <p
        key={`${cue.startMs}-${cue.text}`}
        style={{
          "--lyric-rotation": `${cue.rotationDeg}deg`,
          "--lyric-colour": colours[cue.colourIndex] ?? theme.primary,
          "--lyric-opacity": theme.lyricOpacity
        } as CSSProperties}
      >
        {cue.text}
      </p>
    </div>
  );
}
