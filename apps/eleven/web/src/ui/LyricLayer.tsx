import { useMemo, type CSSProperties } from "react";
import type { PlaybackState } from "@robot-radio/eleven-shared";
import { activeLyricCue, buildLyricCues, splitLyricForDisplay } from "./lyrics";
import type { VisualTheme } from "./visual-theme";

interface LyricLayerProps {
  playback: PlaybackState;
  theme: VisualTheme;
}

export function LyricLayer({ playback, theme }: LyricLayerProps) {
  const cues = useMemo(
    () => buildLyricCues(playback.sections, playback.durationMs, playback.wordTimestamps),
    [playback.durationMs, playback.sections, playback.wordTimestamps]
  );
  const cue = activeLyricCue(cues, playback.playheadMs);
  if (!cue) return null;
  const colours = [theme.primary, theme.secondary, theme.accent];
  const lines = splitLyricForDisplay(cue.text);
  const radians = cue.rotationDeg * (Math.PI / 180);
  const travel = 22 + theme.energy * 18;
  const travelX = Math.cos(radians) * travel;
  const travelY = Math.sin(radians) * travel;

  return (
    <div className="lyric-layer" aria-live="off" aria-hidden="true">
      <p
        key={`${cue.startMs}-${cue.text}`}
        style={{
          "--lyric-rotation": `${cue.rotationDeg}deg`,
          "--lyric-colour": colours[cue.colourIndex] ?? theme.primary,
          "--lyric-opacity": theme.lyricOpacity,
          "--lyric-from-x": `${travelX * -0.5}px`,
          "--lyric-from-y": `${travelY * -0.5}px`,
          "--lyric-to-x": `${travelX * 0.5}px`,
          "--lyric-to-y": `${travelY * 0.5}px`,
          "--lyric-duration": `${Math.max(900, cue.endMs - cue.startMs)}ms`
        } as CSSProperties}
      >
        <span>{lines[0]}</span>
        {lines[1] ? <span>{lines[1]}</span> : null}
      </p>
    </div>
  );
}
