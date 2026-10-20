// Runs on the audio thread: batches 128-sample render quanta and posts them to the main thread.
const BATCH = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(BATCH);
  private fill = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(BATCH - this.fill, ch.length - i);
      this.buf.set(ch.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === BATCH) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BATCH);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
