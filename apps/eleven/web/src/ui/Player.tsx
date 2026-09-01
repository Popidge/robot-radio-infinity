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

export function Player({ state, paused, onStart, onStop, onTogglePause, onMessage, readSpectrum, spectrumBinCount }: PlayerProps) {
  const [message, setMessage] = useState("");
  const [startingVibe, setStartingVibe] = useState("");
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [titleCompact, setTitleCompact] = useState(false);
  const duration = state.playback.durationMs ?? 0;
  const progress = duration ? Math.min(100, (state.playback.playheadMs / duration) * 100) : 0;
  const latestMessage = state.conversation.at(-1);
  const trackTitle = state.playback.title ?? "The opening signal is taking shape";
  const titleDensity = state.playback.title === null ? "is-forming" : trackTitle.length > 46 ? "is-dense" : "";
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
        <div className={`welcome-panel comic-panel is-step-${onboardingStep}`}>
          <div className="onboarding-progress" aria-label={`Introduction step ${onboardingStep + 1} of 3`}>
            {[0, 1, 2].map((step) => <i className={step <= onboardingStep ? "is-complete" : ""} key={step} />)}
          </div>
          <div className="onboarding-copy" key={onboardingStep} aria-live="polite">
            {onboardingStep === 0 ? (
              <>
                <h1>Your own infinite radio station.</h1>
                <p>Every track is made live for you. Nothing is prerecorded, and nobody else will hear the same show.</p>
                <button className="onboarding-next" type="button" onClick={() => setOnboardingStep(1)}>Meet your DJ <span aria-hidden="true">→</span></button>
              </>
            ) : null}
            {onboardingStep === 1 ? (
              <>
                <h1>The DJ is listening.</h1>
                <p>Ask for whatever you want next. Say “right now” if you want it sooner. Or just chat—the DJ responds while it produces and presents your personal, never-heard-before station.</p>
                <div className="onboarding-actions">
                  <button className="onboarding-back" type="button" onClick={() => setOnboardingStep(0)} aria-label="Previous introduction step">←</button>
                  <button className="onboarding-next" type="button" onClick={() => setOnboardingStep(2)}>Make your station <span aria-hidden="true">→</span></button>
                </div>
              </>
            ) : null}
            {onboardingStep === 2 ? (
              <>
                <h1>Send a prompt and create a whole radio station that never existed before</h1>
                <form className="vibe-form has-back" onSubmit={start}>
                  <button className="onboarding-back" type="button" onClick={() => setOnboardingStep(1)} aria-label="Previous introduction step">←</button>
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
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className={`track-title-panel comic-panel ${titleDensity} ${titleCompact ? "is-compact" : "is-featured"}`}>
            <button
              type="button"
              className="title-size-toggle"
              onClick={() => setTitleCompact((compact) => !compact)}
              aria-label={titleCompact ? "Feature track title" : "Move track title to corner"}
              aria-pressed={titleCompact}
            >
              {titleCompact ? "+" : "−"}
            </button>
            <h1 aria-live="polite">{trackTitle}</h1>
            <span className="now-playing-tag">Now playing</span>
          </div>

          <div id="control-plane" className={`control-stack ${chatOpen ? "is-chat-open" : ""} ${controlsOpen ? "is-visible" : "is-hidden"}`}>
            {chatOpen ? (
              <div className="chat-panel">
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
                    autoFocus
                  />
                  <button disabled={!message.trim()} aria-label="Send request">→</button>
                </form>
              </div>
            ) : (
              <button className={`chat-peek ${state.pendingUser && !state.pendingUser.applied ? "has-pending" : ""}`} onClick={() => setChatOpen(true)} aria-label="Open conversation">
                <b>{latestMessage?.role === "listener" ? "YOU" : "DJ"}</b>
                <span>{latestMessage?.text ?? phaseLabel(state, paused)}</span>
                <i aria-hidden="true">↗</i>
              </button>
            )}

            <div className="transport-panel" aria-label="Player controls">
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
          </div>
        </>
      )}

      <RobotDj state={state} controlsOpen={controlsOpen} onToggleControls={() => setControlsOpen((open) => !open)} />

      {state.error ? <div className="experience-error comic-panel">{listenerError(state)}</div> : null}
    </section>
  );
}
