// Microphone capture for conversation mode (public/voice/conversation.js).
// Runs on the audio thread: collects mono samples at the context's own rate
// and posts them in ~2048-sample blocks. Resampling to 16 kHz and framing
// happen on the main thread (createFrameAssembler), so this stays tiny.
// Nothing is stored here: a block is posted and forgotten.
class PG1VadCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.filled = 0;
    this.closed = false;
    this.port.onmessage = (e) => { if (e.data === 'close') this.closed = true; };
  }

  process(inputs) {
    if (this.closed) return false;
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const room = this.block.length - this.filled;
      const n = Math.min(room, ch.length - i);
      this.block.set(ch.subarray(i, i + n), this.filled);
      this.filled += n;
      i += n;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pg1-vad-capture', PG1VadCapture);
