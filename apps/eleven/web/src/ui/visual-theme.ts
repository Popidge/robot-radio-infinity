import type { MusicalIntent, PlaybackState } from "@robot-radio/eleven-shared";

export interface VisualTheme {
  paper: string;
  ink: string;
  primary: string;
  secondary: string;
  accent: string;
  waveOpacity: number;
  lyricOpacity: number;
  energy: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function printColour(hue: number, energy: number, lightnessOffset = 0): string {
  const saturation = Math.round(76 + energy * 18);
  const lightness = Math.round(clamp(42 + energy * 5 + lightnessOffset, 36, 54));
  return `hsl(${Math.round(hue) % 360} ${saturation}% ${lightness}%)`;
}

export function createVisualTheme(playback: PlaybackState, intent: MusicalIntent): VisualTheme {
  const energy = clamp(playback.energy ?? intent.energy ?? 0.55, 0, 1);
  const signature = [
    playback.title,
    ...(playback.styles ?? intent.styles),
    ...(playback.mood ?? intent.mood)
  ].filter(Boolean).join("|");
  const baseHue = hashText(signature || intent.description) % 360;

  return {
    paper: energy > 0.78 ? "#f8f1df" : "#f2eddf",
    ink: "#11100d",
    primary: printColour(baseHue, energy),
    secondary: printColour((baseHue + 132) % 360, energy, 1),
    accent: printColour((baseHue + 54) % 360, energy, 5),
    waveOpacity: 0.42 + energy * 0.43,
    lyricOpacity: 0.32 + energy * 0.3,
    energy
  };
}
