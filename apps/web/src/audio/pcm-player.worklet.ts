import { PcmRingBuffer } from "./stream-buffer";

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

class PcmPlayerProcessor extends AudioWorkletProcessor {
  private readonly ring = new PcmRingBuffer(sampleRate * 180, 2);
  private readonly frame = new Float32Array(2);
  private playing = false;
  private inputEnded = false;
  private consumedFrames = 0;
  private reportCounter = 0;
  private starveCounter = 0;
  private endedReported = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; pcm?: Float32Array };
      if (message.type === "chunk" && message.pcm) this.ring.write(message.pcm);
      if (message.type === "play") this.playing = true;
      if (message.type === "pause") this.playing = false;
      if (message.type === "end") this.inputEnded = true;
      if (message.type === "reset") {
        this.playing = false;
        this.inputEnded = true;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1];
    if (!left || !right) return true;

    for (let index = 0; index < left.length; index += 1) {
      if (this.playing && this.ring.readFrame(this.frame)) {
        left[index] = this.frame[0] ?? 0;
        right[index] = this.frame[1] ?? this.frame[0] ?? 0;
        this.consumedFrames += 1;
        this.starveCounter = 0;
      } else {
        left[index] = 0;
        right[index] = 0;
        if (this.playing && !this.inputEnded) this.starveCounter += 1;
      }
    }

    this.reportCounter += left.length;
    if (this.reportCounter >= 2_048) {
      this.port.postMessage({
        type: "metrics",
        consumedFrames: this.consumedFrames,
        availableFrames: this.ring.availableFrames,
        starved: this.starveCounter > sampleRate / 4
      });
      this.reportCounter = 0;
    }

    if (this.playing && this.inputEnded && this.ring.availableFrames === 0 && !this.endedReported) {
      this.endedReported = true;
      this.port.postMessage({ type: "ended" });
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
