class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(512);
    this.position = 0;
    this.phase = 0;
    this.total = 0;
    this.count = 0;
    this.running = true;
    this.port.onmessage = ({data}) => {
      if (data === 'flush') {
        if (this.position) this.port.postMessage(this.samples.slice(0, this.position).buffer);
        this.position = 0;
        this.running = false;
        this.port.postMessage('flushed');
      }
    };
  }
  process(inputs) {
    if (!this.running) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.total += sample;this.count++;this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const clamped = Math.min(1, Math.max(-1, this.total / this.count));
      this.total = 0;this.count = 0;
      this.samples[this.position++] = Math.round(clamped * (clamped < 0 ? 32768 : 32767));
      if (this.position === 512) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(512);
        this.position = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
