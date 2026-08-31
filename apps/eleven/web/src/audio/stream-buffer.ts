export class PcmRingBuffer {
  private readonly samples: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private availableSamples = 0;

  constructor(
    readonly capacityFrames: number,
    readonly channels: number
  ) {
    this.samples = new Float32Array(capacityFrames * channels);
  }

  get availableFrames(): number {
    return Math.floor(this.availableSamples / this.channels);
  }

  write(input: Float32Array): number {
    let written = 0;
    for (let index = 0; index < input.length; index += 1) {
      if (this.availableSamples === this.samples.length) {
        this.readIndex = (this.readIndex + 1) % this.samples.length;
        this.availableSamples -= 1;
      }
      this.samples[this.writeIndex] = input[index] ?? 0;
      this.writeIndex = (this.writeIndex + 1) % this.samples.length;
      this.availableSamples += 1;
      written += 1;
    }
    return Math.floor(written / this.channels);
  }

  readFrame(target: Float32Array): boolean {
    if (this.availableSamples < this.channels) return false;
    for (let channel = 0; channel < this.channels; channel += 1) {
      target[channel] = this.samples[this.readIndex] ?? 0;
      this.readIndex = (this.readIndex + 1) % this.samples.length;
      this.availableSamples -= 1;
    }
    return true;
  }
}
