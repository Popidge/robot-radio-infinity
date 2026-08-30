import { useRef, useState, useSyncExternalStore } from "react";
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

  function updateSlowGeneration(enabled: boolean): void {
    runtime.setSlowGeneration(enabled);
    setSlowGeneration(enabled);
  }

  return (
    <main>
      <Player
        state={state}
        slowGeneration={slowGeneration}
        onStart={(message) => void runtime.start(message)}
        onStop={() => runtime.stop()}
        onMessage={(message) => runtime.sendUserMessage(message)}
        onSlowGeneration={updateSlowGeneration}
      />
      <StationDebugger state={state} />
      <footer>Browser-owned state · streamed PCM · deterministic continuity</footer>
    </main>
  );
}
