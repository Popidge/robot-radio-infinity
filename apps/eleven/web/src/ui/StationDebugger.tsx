import type { StationCommand, StationEvent, StationState } from "@robot-radio/eleven-shared";

interface StationDebuggerProps {
  state: StationState;
}

function milliseconds(value: number): string {
  return `${(value / 1_000).toFixed(1)}s`;
}

function eventSummary(event: StationEvent): string {
  if (event.type === "USER_MESSAGE") return `“${event.message}”`;
  if (event.type === "TRACK_BUFFER_UPDATED") return `${milliseconds(event.bufferedMs)} buffered · ${event.generationRate.toFixed(2)}×`;
  if (event.type === "TRANSITION_BUFFER_UPDATED") return `${milliseconds(event.bufferedMs)} buffered · ${event.generationRate.toFixed(2)}×`;
  if (event.type === "TRACK_PROGRESS") return `${milliseconds(event.remainingMs)} remaining`;
  if (event.type === "TRACK_REPAIR_RECEIVED") return `repair attempt ${event.attempt}`;
  if (event.type === "TRACK_REPAIR_FAILED") return event.error;
  if ("trackId" in event) return String(event.trackId);
  if ("transitionId" in event && event.transitionId) return String(event.transitionId);
  return "";
}

function commandSummary(command: StationCommand): string {
  if (command.type === "GENERATE_TRACK") return command.spec.title;
  if (command.type === "GENERATE_TRANSITION") return command.spec.description;
  if (command.type === "FADE") return `${command.from} → ${command.to} · ${milliseconds(command.durationMs)}`;
  if (command.type === "PREPARE_SPEECH") return `“${command.text}”`;
  if (command.type === "PLAY_SPEECH") return command.speechId;
  if (command.type === "GENERATE_CART") return `${command.spec.mixType} ${command.spec.kind} · ${command.spec.title}`;
  if (command.type === "PLAY_CART") return command.cartId;
  if (command.type === "CANCEL_SPEECH") return command.speechId;
  if (command.type === "CANCEL_TRACK" || command.type === "PLAY_TRACK") return command.trackId;
  if (command.type === "CANCEL_TRANSITION" || command.type === "PLAY_TRANSITION") return command.transitionId;
  if (command.type === "REPAIR_TRACK_SPEC") return `attempt ${command.input.attempt} · ${command.input.providerError}`;
  return "";
}

export function StationDebugger({ state }: StationDebuggerProps) {
  const events = state.recentEvents.slice(-16).reverse();
  const commands = state.recentCommands.slice(-12).reverse();
  const incomingStatus = state.nextTrack.status === "none" && state.queuedDirective ? "queued" : state.nextTrack.status;
  const incomingTitle = state.nextTrack.spec?.title ?? state.queuedDirective?.title ?? "No pending track";
  return (
    <section className="debugger">
      <div className="metrics-grid">
        <article className="panel metric-card">
          <header><span>Incoming track</span><b className={`status ${incomingStatus}`}>{incomingStatus}</b></header>
          <strong>{incomingTitle}</strong>
          <dl>
            <div><dt>Buffer</dt><dd>{milliseconds(state.nextTrack.bufferedMs)}</dd></div>
            <div><dt>Generated</dt><dd>{milliseconds(state.nextTrack.generatedMs)}</dd></div>
            <div><dt>Rate</dt><dd>{state.nextTrack.generationRate?.toFixed(2) ?? "—"}×</dd></div>
            <div><dt>First audio</dt><dd>{state.nextTrack.firstAudioMs ? `${Math.round(state.nextTrack.firstAudioMs)}ms` : "—"}</dd></div>
            <div><dt>Revision</dt><dd>{state.nextTrack.revision ?? "—"}</dd></div>
          </dl>
        </article>

        <article className="panel metric-card">
          <header><span>Generated transition</span><b className={`status ${state.transition.status}`}>{state.transition.status}</b></header>
          <strong>{state.transition.status === "audible" ? "AUDIBLE BRIDGE" : state.transition.spec?.description ?? "No transition needed"}</strong>
          <dl>
            <div><dt>Buffer</dt><dd>{milliseconds(state.transition.bufferedMs)}</dd></div>
            <div><dt>Stream</dt><dd title={state.transition.transitionId}>{state.transition.transitionId?.slice(-9) ?? "—"}</dd></div>
            <div><dt>Rate</dt><dd>{state.transition.generationRate?.toFixed(2) ?? "—"}×</dd></div>
            <div><dt>TTS</dt><dd>{state.dj.muted ? "Muted" : state.dj.speaking ? "Speaking / ducked" : state.dj.prepared?.status ?? "Idle"}</dd></div>
            <div><dt>Pending cue</dt><dd>{state.dj.pending?.purpose ?? "—"}</dd></div>
            <div><dt>Station elements</dt><dd>{state.carts.entries.filter((entry) => entry.status === "ready").length}/{state.carts.entries.length} ready</dd></div>
            <div><dt>Autonomy</dt><dd>{state.autonomy.mode}</dd></div>
            <div><dt>Startup</dt><dd>{state.startup?.status ?? "—"}</dd></div>
          </dl>
        </article>

        <article className="panel metric-card intent-card">
          <header><span>Musical intent</span><b className="status semantic">semantic</b></header>
          <strong>{state.intent.description}</strong>
          <div className="tags">
            {state.intent.styles.map((style) => <span key={style}>{style}</span>)}
            {state.intent.mood.map((mood) => <span key={mood}>{mood}</span>)}
          </div>
          <pre>{JSON.stringify(state.intent, null, 2)}</pre>
        </article>

        <article className="panel metric-card show-state-card">
          <header><span>Producer memory</span><b className="status semantic">bounded</b></header>
          <strong>{state.showState.musicalThesis.current}</strong>
          <dl>
            <div><dt>Presenter</dt><dd>{state.showState.presenter.name}</dd></div>
            <div><dt>Preferences</dt><dd>{state.showState.listener.preferences.length}/8</dd></div>
            <div><dt>Fingerprints</dt><dd>{state.showState.recentProductionFingerprints.length}/8</dd></div>
            <div><dt>Link shapes</dt><dd>{state.showState.recentLinkFingerprints.length}/8</dd></div>
            <div><dt>Talkativeness</dt><dd>{Math.round(state.showState.speechCadence.sessionTalkativeness * 100)}%</dd></div>
            <div><dt>Last cue</dt><dd>{state.showState.speechCadence.lastCuePurpose ?? "—"}</dd></div>
          </dl>
          <pre>{JSON.stringify(state.showState, null, 2)}</pre>
        </article>
      </div>

      <div className="logs-grid">
        <article className="panel log">
          <header><span>Append-only event log</span><b>{state.recentEvents.length}</b></header>
          <ol>
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <time>{new Date(event.at).toLocaleTimeString()}</time>
                <code>{event.type}</code>
                <small>{eventSummary(event)}</small>
              </li>
            ))}
          </ol>
        </article>
        <article className="panel log">
          <header><span>Emitted commands</span><b>{state.recentCommands.length}</b></header>
          <ol>
            {commands.map((command, index) => (
              <li key={`${command.type}-${index}`}>
                <code>{command.type}</code>
                <small>{commandSummary(command)}</small>
              </li>
            ))}
          </ol>
        </article>
      </div>
      {state.error ? <div className="error-banner">{state.error}</div> : null}
    </section>
  );
}
