import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine, PCM_PLAYER_WORKLET_PATH } from "./audio-engine";

function audioParam() {
  return {
    value: 0,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn()
  };
}

function audioNode() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

describe("AudioEngine initialization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the processor once from the same-origin production asset", async () => {
    let finishModuleLoad: (() => void) | undefined;
    const addModule = vi.fn(() => new Promise<void>((resolve) => { finishModuleLoad = resolve; }));
    const gains: Array<ReturnType<typeof audioNode> & { gain: ReturnType<typeof audioParam> }> = [];
    const context = {
      audioWorklet: { addModule },
      createGain: vi.fn(() => {
        const gain = { ...audioNode(), gain: audioParam() };
        gains.push(gain);
        return gain;
      }),
      createAnalyser: vi.fn(() => ({ ...audioNode(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128 })),
      createDynamicsCompressor: vi.fn(() => ({
        ...audioNode(),
        threshold: audioParam(),
        knee: audioParam(),
        ratio: audioParam(),
        attack: audioParam(),
        release: audioParam()
      })),
      destination: {},
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    };
    const AudioContextMock = vi.fn(() => context);
    vi.stubGlobal("AudioContext", AudioContextMock);

    const engine = new AudioEngine();
    const first = engine.initialize();
    const second = engine.initialize();

    expect(AudioContextMock).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledOnce();
    expect(addModule).toHaveBeenCalledWith(PCM_PLAYER_WORKLET_PATH);

    finishModuleLoad?.();
    await Promise.all([first, second]);

    expect(gains).toHaveLength(7);
  });

  it("ships a plain JavaScript processor that registers pcm-player", () => {
    const source = readFileSync(new URL("../../public/pcm-player.worklet.js", import.meta.url), "utf8");

    expect(source).toContain('registerProcessor("pcm-player", PcmPlayerProcessor)');
    expect(source).not.toContain("export ");
  });
});
