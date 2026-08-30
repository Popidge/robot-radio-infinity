import { useState, type FormEvent } from "react";
import type { StationState } from "@robot-radio/shared";

interface PlayerProps {
  state: StationState;
  slowGeneration: boolean;
  onStart(message: string): void;
  onStop(): void;
  onMessage(message: string): void;
  onSlowGeneration(enabled: boolean): void;
}

function formatTime(ms: number | null): string {
  if (ms === null) return "--:--";
  const totalSeconds = Math.max(0, Math.round(ms / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export function Player({
  state,
  slowGeneration,
  onStart,
  onStop,
  onMessage,
  onSlowGeneration
}: PlayerProps) {
  const [message, setMessage] = useState("");
  const [startingVibe, setStartingVibe] = useState("");
  const duration = state.playback.durationMs ?? 0;
  const progress = duration ? Math.min(100, (state.playback.playheadMs / duration) * 100) : 0;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!message.trim()) return;
    onMessage(message);
    setMessage("");
  }

  function start(event: FormEvent): void {
    event.preventDefault();
    if (!startingVibe.trim()) return;
    onStart(startingVibe);
  }

  return (
    <section className="player panel">
      <div className="eyebrow">Local transmission · provider-neutral core</div>
      <div className="player-heading">
        <div>
          <h1>Robot Radio <span>∞</span></h1>
          <p className="phase"><i className={state.running ? "live" : ""} />{state.phase.replaceAll("_", " ")}</p>
        </div>
        <div className="transport">
          <button disabled={!state.running} onClick={onStop}>Stop</button>
        </div>
      </div>

      {!state.running ? (
        <form className="request" onSubmit={start}>
          <label htmlFor="starting-vibe">What&apos;s your vibe today?</label>
          <div>
            <input
              id="starting-vibe"
              value={startingVibe}
              onChange={(event) => setStartingVibe(event.target.value)}
              placeholder="For example: warm, optimistic jazz-house for a Sunday afternoon"
              autoFocus
            />
            <button className="primary" disabled={!startingVibe.trim()}>Start station</button>
          </div>
        </form>
      ) : null}

      <div className="now-playing">
        <span>On air</span>
        <strong>{state.playback.title ?? "Waiting for the first generated buffer"}</strong>
        <small>
          {state.playback.bpm ? `${state.playback.bpm} BPM` : "—"} · {state.playback.key ?? "—"} · energy {state.playback.energy?.toFixed(2) ?? "—"}
        </small>
      </div>
      <div className="timeline"><div style={{ width: `${progress}%` }} /></div>
      <div className="time-row"><span>{formatTime(state.playback.playheadMs)}</span><span>-{formatTime(state.playback.remainingMs)}</span></div>

      <form className="request" onSubmit={submit} hidden={!state.running}>
        <label htmlFor="listener-request">Tell the station what you want</label>
        <div>
          <input
            id="listener-request"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="For example: right now, switch this to German death-reggae and announce it"
            disabled={!state.running}
          />
          <button className="primary" disabled={!state.running || !message.trim()}>Send</button>
        </div>
      </form>

      <div className="quick-actions">
        <button disabled={!state.running} onClick={() => onMessage("this is great")}>Conversation only</button>
        <button disabled={!state.running} onClick={() => onMessage("next one should be heavier")}>Next track</button>
        <button disabled={!state.running} onClick={() => onMessage("right now, switch this to German death-reggae and announce it")}>Immediate redirect</button>
        <label>
          <input
            type="checkbox"
            checked={slowGeneration}
            onChange={(event) => onSlowGeneration(event.target.checked)}
          />
          Slow future music
        </label>
      </div>
    </section>
  );
}
