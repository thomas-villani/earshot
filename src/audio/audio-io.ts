import workletUrl from './capture-worklet.ts?worker&url';

/** ggwave is only reliable at 48 kHz (see NOTES.md), so we ask the browser to resample everything to that. */
export const SAMPLE_RATE = 48000;

export class AudioIO {
  readonly ctx: AudioContext;
  private stream?: MediaStream;
  trackSettings?: MediaTrackSettings;
  onSamples: (samples: Float32Array) => void = () => {};

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }

  /** Must be called from a user gesture. */
  async startCapture(): Promise<void> {
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const track = this.stream.getAudioTracks()[0];
    this.trackSettings = track.getSettings();
    await this.ctx.audioWorklet.addModule(workletUrl);
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'capture-processor');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onSamples(e.data);
    src.connect(node);
    // Worklets only run when connected to the graph; route through a muted gain to keep it alive.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(this.ctx.destination);
  }

  /** Plays a waveform; resolves when playback ends. */
  async play(wave: Float32Array): Promise<void> {
    await this.ctx.resume();
    const buf = this.ctx.createBuffer(1, wave.length, SAMPLE_RATE);
    buf.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    return new Promise((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
  }
}
