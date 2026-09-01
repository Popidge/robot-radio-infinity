import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { StationRuntime } from "./station/runtime";
import { Player } from "./ui/Player";
import { StationDebugger } from "./ui/StationDebugger";
import "./styles.css";

interface DemoAuthStatus {
  passwordRequired: boolean;
  configured: boolean;
  authenticated: boolean;
}

type AccessState =
  | { phase: "checking" }
  | { phase: "ready"; status: DemoAuthStatus }
  | { phase: "error"; message: string };

const serverOrigin = import.meta.env.VITE_SERVER_URL ?? window.location.origin;

async function authRequest(password?: string): Promise<DemoAuthStatus> {
  const response = await fetch(new URL("/api/auth/session", serverOrigin), {
    method: password === undefined ? "GET" : "POST",
    credentials: "include",
    headers: password === undefined ? undefined : { "content-type": "application/json" },
    body: password === undefined ? undefined : JSON.stringify({ password })
  });
  const result = await response.json() as Partial<DemoAuthStatus> & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The private signal did not accept that request.");
  return {
    passwordRequired: Boolean(result.passwordRequired),
    configured: Boolean(result.configured),
    authenticated: Boolean(result.authenticated)
  };
}

function AccessGate({ access, onAuthenticated, onRetry }: {
  access: AccessState;
  onAuthenticated(status: DemoAuthStatus): void;
  onRetry(): void;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onAuthenticated(await authRequest(password));
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "That password did not work.");
    } finally {
      setSubmitting(false);
    }
  }

  const notConfigured = access.phase === "ready" && !access.status.configured;
  return (
    <main className="access-canvas">
      <header className="station-stamp">
        <span className="station-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span className="station-wordmark"><span>Robot Radio</span><span>Infinity</span></span>
      </header>
      <section className="access-panel comic-panel" aria-live="polite">
        {access.phase === "checking" ? (
          <>
            <p className="access-kicker">Private transmission</p>
            <h1>Tuning the signal.</h1>
          </>
        ) : access.phase === "error" ? (
          <>
            <p className="access-kicker">Signal unavailable</p>
            <h1>The demo server did not answer.</h1>
            <p>{access.message}</p>
            <button className="access-submit" type="button" onClick={onRetry}>Try again <span aria-hidden="true">→</span></button>
          </>
        ) : notConfigured ? (
          <>
            <p className="access-kicker">Private transmission</p>
            <h1>This demo is not configured yet.</h1>
            <p>The owner must add <code>DEMO_PASSWORD</code> to the Vercel environment and redeploy.</p>
          </>
        ) : (
          <>
            <p className="access-kicker">Private transmission</p>
            <h1>Enter the shared password.</h1>
            <p>This live demo generates new music and radio presentation with paid AI services.</p>
            <form className="access-form" onSubmit={(event) => void submit(event)}>
              <label className="sr-only" htmlFor="demo-password">Demo password</label>
              <input
                id="demo-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                autoFocus
                maxLength={256}
              />
              <button disabled={!password || submitting} aria-label="Enter private demo">
                {submitting ? "…" : "→"}
              </button>
            </form>
            <p className="cookie-note">Entering the password will set a cookie to remember you&apos;ve put it in right, nothing else.</p>
            {error ? <p className="access-error">{error}</p> : null}
          </>
        )}
      </section>
    </main>
  );
}

function RadioApp() {
  const runtimeRef = useRef<StationRuntime | null>(null);
  if (!runtimeRef.current) runtimeRef.current = new StationRuntime();
  const runtime = runtimeRef.current;
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [slowGeneration, setSlowGeneration] = useState(runtime.isSlowGeneration());
  const [paused, setPaused] = useState(false);
  const showDiagnostics = new URLSearchParams(window.location.search).has("debug");

  useEffect(() => {
    const dispose = () => runtime.dispose();
    window.addEventListener("beforeunload", dispose);
    return () => window.removeEventListener("beforeunload", dispose);
  }, [runtime]);

  function updateSlowGeneration(enabled: boolean): void {
    runtime.setSlowGeneration(enabled);
    setSlowGeneration(enabled);
  }

  async function togglePaused(): Promise<void> {
    const next = !paused;
    await runtime.setPaused(next);
    setPaused(next);
  }

  function stop(): void {
    setPaused(false);
    runtime.stop();
  }

  return (
    <main className="app-shell">
      <Player
        state={state}
        paused={paused}
        onStart={(message) => { setPaused(false); void runtime.start(message) }}
        onStop={stop}
        onTogglePause={() => void togglePaused()}
        onMessage={(message) => runtime.sendUserMessage(message)}
        onSetDjMuted={(muted) => runtime.setDjMuted(muted)}
        readSpectrum={runtime.readSpectrum}
        spectrumBinCount={runtime.spectrumBinCount}
      />

      {showDiagnostics ? <details className="diagnostics">
        <summary><span>Transmission diagnostics</span><small>Buffers, orchestration and test controls</small></summary>
        <div className="test-controls">
          <button disabled={!state.running} onClick={() => runtime.sendUserMessage("this is great")}>Praise</button>
          <button disabled={!state.running} onClick={() => runtime.sendUserMessage("next one should be heavier")}>Request next track</button>
          <button disabled={!state.running} onClick={() => runtime.sendUserMessage("right now, take this somewhere darker and announce it")}>Immediate redirect</button>
          <label><input type="checkbox" checked={slowGeneration} onChange={(event) => updateSlowGeneration(event.target.checked)} />Simulate slow generation</label>
        </div>
        <StationDebugger state={state} />
      </details> : null}
    </main>
  );
}

export default function App() {
  const [access, setAccess] = useState<AccessState>({ phase: "checking" });

  function loadAccess(): void {
    setAccess({ phase: "checking" });
    void authRequest()
      .then((status) => setAccess({ phase: "ready", status }))
      .catch((error) => setAccess({
        phase: "error",
        message: error instanceof Error ? error.message : "The private signal could not reach its server."
      }));
  }

  useEffect(loadAccess, []);

  if (access.phase === "ready" && access.status.authenticated) return <RadioApp />;
  return <AccessGate access={access} onAuthenticated={(status) => setAccess({ phase: "ready", status })} onRetry={loadAccess} />;
}
