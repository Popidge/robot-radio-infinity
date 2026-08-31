import { useState, type FormEvent } from "react";
import type { StationState } from "@robot-radio/shared";
import { AudioVisualizer } from "./AudioVisualizer";

interface PlayerProps {
  state: StationState;
  onStart(message: string): void;
  onStop(): void;
  onMessage(message: string): void;
  readSpectrum(target: Uint8Array<ArrayBuffer>): boolean;
  spectrumBinCount(): number;
}

function formatTime(ms: number | null): string {
  if (ms === null) return "--:--";
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function phaseLabel(state: StationState): string {
  if (!state.running) return "Waiting for a signal";
  if (state.startup?.status === "planning") return "Imagining your station";
  if (state.startup) return "Opening the transmission";
  if (state.dj.speaking) return "Your DJ is on the mic";
  if (state.continuity.audible) return "Following the music somewhere new";
  if (state.nextTrack.status === "generating" || state.nextTrack.status === "buffering") return "Making what comes next";
  return "Live and listening";
}

function listenerError(state: StationState): string {
  return state.playback.trackId
    ? "The DJ hit a snag with that plan, but the music is still playing. Try the request again."
    : "The opening signal hit a problem. Open diagnostics for the technical detail."
}

export function Player({ state, onStart, onStop, onMessage, readSpectrum, spectrumBinCount }: PlayerProps) {
  const [message, setMessage] = useState("");
  const [startingVibe, setStartingVibe] = useState("");
  const duration = state.playback.durationMs ?? 0;
  const progress = duration ? Math.min(100, (state.playback.playheadMs / duration) * 100) : 0;
  const latestDjLine = state.recentDjLines.at(-1);
  const recentRequests = state.recentUserMessages.slice(state.running ? -3 : 0);

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
    <section className={`radio ${state.running ? "is-running" : "is-idle"}`}>
      <header className="radio-header">
        <a className="brand" href="/" aria-label="Robot Radio Infinity home">
          <span className="brand-mark">RRI</span>
          <span>Robot Radio <b>Infinity</b></span>
        </a>
        <div className="broadcast-state" aria-live="polite"><i className={state.running ? "live" : ""} />{phaseLabel(state)}</div>
        {state.running ? <button className="stop-button" onClick={onStop}>End session</button> : null}
      </header>

      <div className="visual-stage">
        <AudioVisualizer running={state.running} speaking={state.dj.speaking} intent={state.intent} bpm={state.playback.bpm} readSpectrum={readSpectrum} spectrumBinCount={spectrumBinCount} />
        <div className="visual-vignette" />

        {!state.running ? (
          <div className="welcome">
            <p className="kicker">One continuous station, made around you</p>
            <h1>What do you want<br />to hear today?</h1>
            <p className="welcome-copy">Give the DJ a feeling, a place, a genre—or something that should not work together.</p>
            <form className="vibe-form" onSubmit={start}>
              <label className="sr-only" htmlFor="starting-vibe">What&apos;s your vibe today?</label>
              <input id="starting-vibe" value={startingVibe} onChange={(event) => setStartingVibe(event.target.value)} placeholder="Warm psychedelic soul for a rainy Sunday…" autoFocus />
              <button className="send-button" disabled={!startingVibe.trim()}>Start listening <span>→</span></button>
            </form>
          </div>
        ) : (
          <div className="on-air-card">
            <div className="on-air-label"><span>On air</span><i /></div>
            <h1>{state.playback.title ?? "The opening signal is taking shape"}</h1>
            <p>{state.playback.styleSummary ?? state.intent.description}</p>
            <div className="intent-tags">
              {[...state.intent.styles, ...state.intent.mood].slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          </div>
        )}
      </div>

      {state.running ? (
        <div className="listener-console">
          <div className="progress-block">
            <div className="timeline"><div style={{ width: `${progress}%` }} /></div>
            <div className="time-row"><span>{formatTime(state.playback.playheadMs)}</span><span>{formatTime(state.playback.remainingMs)} remaining</span></div>
          </div>

          {latestDjLine ? (
            <div className="dj-line" aria-live="polite">
              <span>DJ</span><p>“{latestDjLine}”</p>{state.dj.speaking ? <i>speaking</i> : null}
            </div>
          ) : null}

          <form className="chat-form" onSubmit={submit}>
            <label htmlFor="listener-request">Steer the station</label>
            <div className="chat-input">
              <input id="listener-request" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Keep this feeling, make the next one stranger, change it now…" autoComplete="off" />
              <button className="send-button" disabled={!message.trim()}>Send <span>→</span></button>
            </div>
          </form>

          {recentRequests.length ? <div className="request-memory" aria-label="Recent requests">{recentRequests.map((request, index) => <span key={`${request}-${index}`}>{request}</span>)}</div> : null}
        </div>
      ) : null}

      {state.error ? <div className="experience-error">{listenerError(state)}</div> : null}
    </section>
  );
}
