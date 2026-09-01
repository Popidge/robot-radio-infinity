import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import type { StationState } from "@robot-radio/eleven-shared";
import { AudioVisualizer } from "./AudioVisualizer";
import { LyricLayer } from "./LyricLayer";
import { RobotDj } from "./RobotDj";
import { createVisualTheme } from "./visual-theme";

interface PlayerProps {
  state: StationState;
  paused: boolean;
  onStart(message: string): void;
  onStop(): void;
  onTogglePause(): void;
  onMessage(message: string): void;
  readSpectrum(target: Uint8Array<ArrayBuffer>): boolean;
  spectrumBinCount(): number;
}

function formatTime(ms: number | null): string {
  if (ms === null) return "--:--";
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function phaseLabel(state: StationState, paused: boolean): string {
  if (paused) return "Transmission paused";
  if (!state.running) return "Waiting for a signal";
  if (state.startup?.status === "planning") return "Imagining your station";
  if (state.startup) return "Opening the transmission";
  if (state.dj.speaking) return "Your DJ is on the mic";
  if (state.transition.status === "audible") return "Moving somewhere new";
  if (state.nextTrack.status === "generating" || state.nextTrack.status === "buffering") return "Making what comes next";
  return "Live and listening";
}

function listenerError(state: StationState): string {
  return state.playback.trackId
    ? "The DJ hit a snag with that plan, but the music is still playing. Try the request again."
    : "The opening signal hit a problem. Add ?debug=1 to the address for technical detail.";
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 5h24v17H13l-7 6v-6H4z" />
      <path d="M9 11h14M9 16h9" />
    </svg>
  );
}

export function Player({ state, paused, onStart, onStop, onTogglePause, onMessage, readSpectrum, spectrumBinCount }: PlayerProps) {
  const [message, setMessage] = useState("");
  const [startingVibe, setStartingVibe] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const duration = state.playback.durationMs ?? 0;
  const progress = duration ? Math.min(100, (state.playback.playheadMs / duration) * 100) : 0;
  const theme = useMemo(
    () => createVisualTheme(state.playback, state.intent),
    [state.intent, state.playback.energy, state.playback.mood, state.playback.styles, state.playback.title]
  );
  const visualStyle = {
    "--paper": theme.paper,
    "--ink": theme.ink,
    "--track-primary": theme.primary,
    "--track-secondary": theme.secondary,
    "--track-accent": theme.accent,
    "--track-energy": theme.energy
  } as CSSProperties;

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    onMessage(trimmed);
    setMessage("");
  }

  function start(event: FormEvent): void {
    event.preventDefault();
    const trimmed = startingVibe.trim();
    if (!trimmed) return;
    onStart(trimmed);
  }

  return (
    <section className={`radio-canvas ${state.running ? "is-running" : "is-idle"} ${paused ? "is-paused" : ""}`} style={visualStyle}>
      <AudioVisualizer
        running={state.running && !paused}
        speaking={state.dj.speaking}
        bpm={state.playback.bpm}
        theme={theme}
        readSpectrum={readSpectrum}
        spectrumBinCount={spectrumBinCount}
      />
      {state.running ? <LyricLayer playback={state.playback} theme={theme} /> : null}

      <header className="station-stamp">
        <span className="station-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span>Robot Radio Infinity</span>
      </header>

      <p className="broadcast-state sr-only" aria-live="polite">{phaseLabel(state, paused)}</p>

      {!state.running ? (
        <div className="welcome-panel comic-panel">
          <h1>What do you want to hear today?</h1>
          <form className="vibe-form" onSubmit={start}>
            <label className="sr-only" htmlFor="starting-vibe">What&apos;s your vibe today?</label>
            <input
              id="starting-vibe"
              value={startingVibe}
              onChange={(event) => setStartingVibe(event.target.value)}
              placeholder="Warm psychedelic soul for a rainy Sunday…"
              autoFocus
            />
            <button disabled={!startingVibe.trim()} aria-label="Start listening">→</button>
          </form>
        </div>
      ) : (
        <>
          <div className="track-title-panel comic-panel" aria-live="polite">
            <h1>{state.playback.title ?? "The opening signal is taking shape"}</h1>
          </div>

          <div className="transport-panel comic-panel" aria-label="Player controls">
            <button className="transport-button" onClick={onTogglePause} aria-label={paused ? "Resume" : "Pause"}>
              {paused ? <span className="play-icon" aria-hidden="true" /> : <span className="pause-icon" aria-hidden="true"><i /><i /></span>}
            </button>
            <time>{formatTime(state.playback.playheadMs)}</time>
            <div className="timeline" aria-label={`${Math.round(progress)} percent played`}>
              <div style={{ width: `${progress}%` }} />
            </div>
            <time>{formatTime(state.playback.durationMs)}</time>
            <button className="end-button" onClick={onStop} aria-label="End session">×</button>
          </div>
        </>
      )}

      <RobotDj state={state} />

      {state.running ? (
        <div className={`chat-dock ${chatOpen ? "is-open" : ""}`}>
          {chatOpen ? (
            <div className="chat-panel comic-panel">
              <button className="chat-close" onClick={() => setChatOpen(false)} aria-label="Collapse conversation">↓</button>
              <div className="chat-history" aria-live="polite">
                {state.conversation.map((entry, index) => (
                  <p className={`chat-message is-${entry.role}`} key={`${entry.at}-${index}`}>
                    <b>{entry.role === "dj" ? "DJ" : "YOU"}</b>
                    <span>{entry.text}</span>
                  </p>
                ))}
              </div>
              <form className="chat-form" onSubmit={submit}>
                <label className="sr-only" htmlFor="listener-request">Steer the station</label>
                <input
                  id="listener-request"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Steer the station…"
                  autoComplete="off"
                />
                <button disabled={!message.trim()} aria-label="Send request">→</button>
              </form>
            </div>
          ) : (
            <button className="chat-toggle comic-panel" onClick={() => setChatOpen(true)} aria-label="Open conversation">
              <ChatIcon />
              {state.pendingUser && !state.pendingUser.applied ? <i aria-hidden="true" /> : null}
            </button>
          )}
        </div>
      ) : null}

      {state.error ? <div className="experience-error comic-panel">{listenerError(state)}</div> : null}
    </section>
  );
}
