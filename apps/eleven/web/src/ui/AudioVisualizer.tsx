import { useEffect, useRef } from "react";
import type { VisualTheme } from "./visual-theme";

interface AudioVisualizerProps {
  running: boolean;
  speaking: boolean;
  bpm?: number;
  theme: VisualTheme;
  readSpectrum(target: Uint8Array<ArrayBuffer>): boolean;
  spectrumBinCount(): number;
}

export function AudioVisualizer({ running, speaking, bpm, theme, readSpectrum, spectrumBinCount }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const spectrum = new Uint8Array(spectrumBinCount());
    const tempo = bpm ?? 112;
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

      const bars = Math.max(56, Math.min(112, Math.floor(width / 12)));
      const gap = Math.max(2, Math.min(5, width / 360));
      const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
      const centerY = height * 0.5;
      for (let index = 0; index < bars; index += 1) {
        const normalizedIndex = index / Math.max(1, bars - 1);
        const spectrumIndex = Math.min(spectrum.length - 1, Math.floor((Math.exp(normalizedIndex * 4.2) - 1) / (Math.exp(4.2) - 1) * spectrum.length));
        const liveValue = hasAudio ? (spectrum[spectrumIndex] ?? 0) / 255 : 0;
        const idleValue = 0.018 + (Math.sin(now * 0.001 + index * 0.43) + 1) * 0.008;
        const value = Math.max(0.012, hasAudio ? liveValue : idleValue);
        const shaped = Math.min(1, Math.pow(value, 1.38 - theme.energy * 0.42) * (0.7 + theme.energy * 0.42));
        const halfHeight = Math.max(1, shaped * height * 0.5);
        const x = index * (barWidth + gap);
        const colour = normalizedIndex < 0.34 ? theme.primary : normalizedIndex < 0.72 ? theme.secondary : theme.accent;
        context.globalAlpha = Math.min(1, theme.waveOpacity + value * 0.14 + beat * 0.025 + (speaking ? 0.08 : 0));
        context.fillStyle = colour;
        context.fillRect(x, centerY - halfHeight, barWidth, halfHeight);
        context.fillRect(x, centerY, barWidth, halfHeight);
      }
      context.globalAlpha = Math.min(0.78, theme.waveOpacity + 0.12);
      context.fillStyle = theme.ink;
      context.fillRect(0, Math.floor(centerY), width, 2);
      context.globalAlpha = 1;
      animationFrame = requestAnimationFrame(draw);
    };

    animationFrame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [bpm, readSpectrum, running, speaking, spectrumBinCount, theme]);

  return <canvas ref={canvasRef} className="audio-visualizer" aria-hidden="true" />;
}
