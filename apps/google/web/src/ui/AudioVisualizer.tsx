import { useEffect, useRef } from "react";
import type { MusicalIntent } from "@robot-radio/google-shared";

interface AudioVisualizerProps {
  running: boolean;
  speaking: boolean;
  intent: MusicalIntent;
  bpm?: number;
  readSpectrum(target: Uint8Array<ArrayBuffer>): boolean;
  spectrumBinCount(): number;
}

function hashHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}

export function AudioVisualizer({ running, speaking, intent, bpm, readSpectrum, spectrumBinCount }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const spectrum = new Uint8Array(spectrumBinCount());
    const baseHue = hashHue([...intent.styles, ...intent.mood].join("|"));
    const energy = intent.energy ?? 0.55;
    const tempo = bpm ?? (intent.bpmRange ? (intent.bpmRange[0] + intent.bpmRange[1]) / 2 : 112);
    let animationFrame = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const draw = (now: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const hasAudio = running && readSpectrum(spectrum);
      const beat = (Math.sin((now / 60_000) * tempo * Math.PI * 2) + 1) / 2;
      context.clearRect(0, 0, width, height);

      const wash = context.createRadialGradient(width * 0.5, height * 0.55, 0, width * 0.5, height * 0.55, width * 0.62);
      wash.addColorStop(0, `hsla(${baseHue}, 88%, 62%, ${0.08 + energy * 0.08 + beat * 0.025})`);
      wash.addColorStop(0.55, `hsla(${(baseHue + 58) % 360}, 80%, 48%, 0.035)`);
      wash.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = wash;
      context.fillRect(0, 0, width, height);

      const bars = 56;
      const gap = 3;
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
      const centerY = height * 0.54;
      for (let index = 0; index < bars; index += 1) {
        const spectrumIndex = Math.min(spectrum.length - 1, Math.floor((index / bars) ** 1.65 * spectrum.length));
        const liveValue = hasAudio ? (spectrum[spectrumIndex] ?? 0) / 255 : 0;
        const idleValue = 0.05 + Math.sin(now * 0.0007 + index * 0.37) * 0.025;
        const value = Math.max(0.025, hasAudio ? liveValue : idleValue);
        const shaped = Math.pow(value, 1.35) * (0.62 + energy * 0.64);
        const barHeight = Math.max(2, shaped * height * 0.58);
        const x = index * (barWidth + gap);
        const hue = (baseHue + index * 0.72 + (speaking ? 38 : 0)) % 360;
        const gradient = context.createLinearGradient(0, centerY - barHeight / 2, 0, centerY + barHeight / 2);
        gradient.addColorStop(0, `hsla(${hue}, 96%, ${speaking ? 72 : 64}%, ${0.42 + value * 0.5})`);
        gradient.addColorStop(0.5, `hsla(${(hue + 22) % 360}, 92%, 68%, ${0.76 + beat * 0.12})`);
        gradient.addColorStop(1, `hsla(${hue}, 90%, 50%, 0.18)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.roundRect(x, centerY - barHeight / 2, barWidth, barHeight, barWidth / 2);
        context.fill();
      }
      animationFrame = requestAnimationFrame(draw);
    };

    animationFrame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [bpm, intent, readSpectrum, running, speaking, spectrumBinCount]);

  return <canvas ref={canvasRef} className="audio-visualizer" aria-hidden="true" />;
}
