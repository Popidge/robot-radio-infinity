import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PlaybackState } from "@robot-radio/eleven-shared";
import { activeLyricCue, buildLyricCues, lyricFitScale, splitLyricForDisplay } from "./lyrics";
import type { VisualTheme } from "./visual-theme";

interface LyricLayerProps {
  playback: PlaybackState;
  theme: VisualTheme;
}

export function LyricLayer({ playback, theme }: LyricLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lyricRef = useRef<HTMLParagraphElement | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const cues = useMemo(
    () => buildLyricCues(playback.sections, playback.durationMs, playback.wordTimestamps),
    [playback.durationMs, playback.sections, playback.wordTimestamps]
  );
  const cue = activeLyricCue(cues, playback.playheadMs);
  const lines = cue ? splitLyricForDisplay(cue.text) : [""];
  const rotationDeg = cue?.rotationDeg ?? 0;
  const radians = rotationDeg * (Math.PI / 180);
  const travel = 22 + theme.energy * 18;
  const travelX = Math.cos(radians) * travel;
  const travelY = Math.sin(radians) * travel;

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const lyric = lyricRef.current;
    if (!cue || !layer || !lyric) return;
    let active = true;
    const fit = () => {
      if (!active) return;
      setFitScale(lyricFitScale({
        contentWidth: lyric.scrollWidth,
        contentHeight: lyric.scrollHeight,
        viewportWidth: layer.clientWidth,
        viewportHeight: layer.clientHeight,
        rotationDeg,
        travelX,
        travelY,
        inset: layer.clientWidth <= 660 ? 16 : 32
      }));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(layer);
    fit();
    void document.fonts?.ready.then(fit);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cue, rotationDeg, travelX, travelY]);

  if (!cue) return null;

  return (
    <div ref={layerRef} className="lyric-layer" aria-live="off" aria-hidden="true">
      <div className="lyric-fit" style={{ "--lyric-fit-scale": fitScale } as CSSProperties}>
        <p
          ref={lyricRef}
          key={`${cue.startMs}-${cue.text}`}
          style={{
            "--lyric-rotation": `${rotationDeg}deg`,
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
    </div>
  );
}
