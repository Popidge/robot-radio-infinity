// This file is a same-origin browser asset. Keep it valid plain JavaScript so
// the AudioWorklet can load it under the production Content Security Policy.

class PcmRingBuffer {
  constructor(capacityFrames, channels) {
    this.capacityFrames = capacityFrames;
    this.channels = channels;
    this.samples = new Float32Array(capacityFrames * channels);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.availableSamples = 0;
  }

  get availableFrames() {
    return Math.floor(this.availableSamples / this.channels);
  }

  write(input) {
    for (let index = 0; index < input.length; index += 1) {
      if (this.availableSamples === this.samples.length) {
        this.readIndex = (this.readIndex + 1) % this.samples.length;
        this.availableSamples -= 1;
      }
      this.samples[this.writeIndex] = input[index] ?? 0;
      this.writeIndex = (this.writeIndex + 1) % this.samples.length;
      this.availableSamples += 1;
    }
  }

  readFrame(target) {
    if (this.availableSamples < this.channels) return false;
    for (let channel = 0; channel < this.channels; channel += 1) {
      target[channel] = this.samples[this.readIndex] ?? 0;
      this.readIndex = (this.readIndex + 1) % this.samples.length;
      this.availableSamples -= 1;
    }
    return true;
  }
}

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new PcmRingBuffer(sampleRate * 180, 2);
    this.frame = new Float32Array(2);
    this.playing = false;
    this.inputEnded = false;
    this.consumedFrames = 0;
    this.reportCounter = 0;
    this.starveCounter = 0;
    this.endedReported = false;

    this.port.onmessage = (event) => {
      const message = event.data;
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

  process(_inputs, outputs) {
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
