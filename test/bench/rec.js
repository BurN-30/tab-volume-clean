// AudioWorklet recorder for the real-time bench: sends its input (mono) with the frame index of its first sample.
class Rec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(12000);
    this.n = 0;
    this.start = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    if (this.n === 0) this.start = currentFrame;
    if (ch) this.buf.set(ch, this.n);
    else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    if (this.n + 128 > this.buf.length) {
      this.port.postMessage({ start: this.start, d: this.buf.slice(0, this.n) });
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('rec', Rec);
