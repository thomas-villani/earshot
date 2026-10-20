import factory from 'ggwave';
import { BAND_OF, type Modem, type ProtocolId } from './modem';

// DT_NORMAL is omitted: it never decoded in the milestone 0 spike, even on a clean loopback.
const PROTOCOL_NAMES: Record<ProtocolId, string> = {
  'audible-normal': 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL',
  'audible-fast': 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
  'audible-fastest': 'GGWAVE_PROTOCOL_AUDIBLE_FASTEST',
  'ultrasound-normal': 'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL',
  'ultrasound-fast': 'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
  'ultrasound-fastest': 'GGWAVE_PROTOCOL_ULTRASOUND_FASTEST',
  'dt-fast': 'GGWAVE_PROTOCOL_DT_FAST',
  'dt-fastest': 'GGWAVE_PROTOCOL_DT_FASTEST',
};
const ALL_NAMES = [...Object.values(PROTOCOL_NAMES), 'GGWAVE_PROTOCOL_DT_NORMAL'];

/** ggwave's samplesPerFrame; decode() silently drops any partial frame, so input is buffered to multiples of this. */
const SAMPLES_PER_FRAME = 1024;

/**
 * One TX instance plus one RX instance per band, so simultaneous audible + ultrasound transmissions
 * both decode (a single decoder locks onto one transmission). 3 of ggwave's 4 allowed instances.
 */
export class GgwaveModem implements Modem {
  readonly maxFrameBytes = 140;
  private g: any;
  private tx = -1;
  private rx: number[] = [];
  private rate = 48000;
  private pending = new Float32Array(SAMPLES_PER_FRAME);
  private fill = 0;

  private constructor(g: any, public volume: number) {
    this.g = g;
  }

  static async create(opts: { sampleRate?: number; volume?: number } = {}): Promise<GgwaveModem> {
    // Silence the binding's stdout printf ("n = ..., nActual = ...") and ggwave's own logging.
    const g = await factory({ print: () => {}, printErr: () => {} });
    g.disableLog();
    const m = new GgwaveModem(g, opts.volume ?? 25);
    m.setSampleRate(opts.sampleRate ?? 48000);
    return m;
  }

  get sampleRate(): number {
    return this.rate;
  }

  setSampleRate(rate: number): void {
    // ggwave caps the number of live instances (4), so always free before re-creating.
    for (const inst of [this.tx, ...this.rx]) if (inst >= 0) this.g.free(inst);
    this.tx = this.init(rate, ALL_NAMES);
    const band = (b: 'audible' | 'ultrasound') =>
      (Object.keys(PROTOCOL_NAMES) as ProtocolId[]).filter((p) => BAND_OF[p] === b).map((p) => PROTOCOL_NAMES[p]);
    // DT tones overlap the audible band, so the audible decoder listens for them too
    this.rx = [this.init(rate, [...band('audible'), 'GGWAVE_PROTOCOL_DT_NORMAL']), this.init(rate, band('ultrasound'))];
    this.rate = rate;
    this.fill = 0;
  }

  /** rxToggleProtocol is global but captured per instance at init, so set it just before each init. */
  private init(rate: number, rxProtocols: string[]): number {
    for (const name of ALL_NAMES) this.g.rxToggleProtocol(this.g.ProtocolId[name], rxProtocols.includes(name) ? 1 : 0);
    const F = this.g.SampleFormat;
    const p = this.g.getDefaultParameters();
    p.sampleRateInp = rate;
    p.sampleRateOut = rate;
    p.sampleFormatInp = F.GGWAVE_SAMPLE_FORMAT_F32;
    p.sampleFormatOut = F.GGWAVE_SAMPLE_FORMAT_F32;
    const inst = this.g.init(p);
    if (inst < 0) throw new Error('ggwave init failed');
    return inst;
  }

  encode(frame: Uint8Array, protocol: ProtocolId): Float32Array {
    if (frame.length === 0 || frame.length > this.maxFrameBytes) {
      // ggwave would silently truncate to 140 bytes
      throw new RangeError(`frame must be 1..${this.maxFrameBytes} bytes, got ${frame.length}`);
    }
    const view: Int8Array = this.g.encode(this.tx, frame, this.g.ProtocolId[PROTOCOL_NAMES[protocol]], this.volume);
    // view aliases a static WASM buffer that the next call overwrites
    const bytes = new Uint8Array(view.length);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.length));
    return new Float32Array(bytes.buffer);
  }

  encodeParallel(items: { frame: Uint8Array; protocol: ProtocolId }[]): Float32Array {
    const bands = new Set(items.map((i) => BAND_OF[i.protocol]));
    if (bands.size !== items.length) throw new Error('parallel frames must use different bands');
    const waves = items.map((i) => this.encode(i.frame, i.protocol));
    if (waves.length === 1) return waves[0];
    // split the power evenly so the mix is as loud as a single transmission
    const gain = 1 / Math.sqrt(waves.length);
    const out = new Float32Array(Math.max(...waves.map((w) => w.length)));
    for (const w of waves) for (let i = 0; i < w.length; i++) out[i] += w[i] * gain;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    return out;
  }

  pushSamples(samples: Float32Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 0; i < samples.length; ) {
      const n = Math.min(SAMPLES_PER_FRAME - this.fill, samples.length - i);
      this.pending.set(samples.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === SAMPLES_PER_FRAME) {
        this.fill = 0;
        const input = new Uint8Array(this.pending.buffer);
        for (const inst of this.rx) {
          const res: Int8Array = this.g.decode(inst, input);
          if (res && res.length > 0) out.push(Uint8Array.from(new Uint8Array(res.buffer, res.byteOffset, res.length)));
        }
      }
    }
    return out;
  }
}
