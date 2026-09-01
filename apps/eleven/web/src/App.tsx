import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StationRuntime } from "./station/runtime";
import { Player } from "./ui/Player";
import { StationDebugger } from "./ui/StationDebugger";
import "./styles.css";

export default function App() {
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
