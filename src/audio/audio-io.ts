import workletUrl from './capture-worklet.ts?worker&url';

/** ggwave is only reliable at 48 kHz (see NOTES.md), so we ask the browser to resample everything to that. */
export const SAMPLE_RATE = 48000;

export class AudioIO {
  readonly ctx: AudioContext;
  /** Available while capturing; feeds the spectrogram. */
  analyser?: AnalyserNode;
  trackSettings?: MediaTrackSettings;
  onSamples: (samples: Float32Array) => void = () => {};
  private stream?: MediaStream;
  private nodes: AudioNode[] = [];
  private workletLoaded = false;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  }

  get capturing(): boolean {
    return !!this.stream;
  }

  /** Must be called from a user gesture. */
  async startCapture(): Promise<void> {
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.trackSettings = this.stream.getAudioTracks()[0].getSettings();
    if (!this.workletLoaded) {
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.workletLoaded = true;
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'capture-processor');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onSamples(e.data);
    src.connect(node);
    // Worklets only run when connected to the graph; route through a muted gain to keep it alive.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(this.ctx.destination);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -110;
    this.analyser.maxDecibels = -30;
    src.connect(this.analyser);
    this.nodes = [src, node, mute, this.analyser];
  }

  stopCapture(): void {
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.analyser = undefined;
  }

  /** Plays a waveform; resolves when playback ends or `signal` aborts it. */
  async play(wave: Float32Array, signal?: AbortSignal): Promise<void> {
    await this.ctx.resume();
    if (signal?.aborted) return;
    const buf = this.ctx.createBuffer(1, wave.length, SAMPLE_RATE);
    buf.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    return new Promise((resolve) => {
      src.onended = () => resolve();
      signal?.addEventListener('abort', () => src.stop(), { once: true });
      src.start();
    });
  }
}
