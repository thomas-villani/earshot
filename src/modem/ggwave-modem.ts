import factory from 'ggwave';
import type { Modem, ProtocolId } from './modem';

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

/** ggwave's samplesPerFrame; decode() silently drops any partial frame, so input is buffered to multiples of this. */
const SAMPLES_PER_FRAME = 1024;

export class GgwaveModem implements Modem {
  readonly maxFrameBytes = 140;
  private g: any;
  private instance = -1;
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
    if (this.instance >= 0) this.g.free(this.instance);
    const F = this.g.SampleFormat;
    const p = this.g.getDefaultParameters();
    p.sampleRateInp = rate;
    p.sampleRateOut = rate;
    p.sampleFormatInp = F.GGWAVE_SAMPLE_FORMAT_F32;
    p.sampleFormatOut = F.GGWAVE_SAMPLE_FORMAT_F32;
    this.instance = this.g.init(p);
    if (this.instance < 0) throw new Error('ggwave init failed');
    this.rate = rate;
    this.fill = 0;
  }

  encode(frame: Uint8Array, protocol: ProtocolId): Float32Array {
    if (frame.length === 0 || frame.length > this.maxFrameBytes) {
      // ggwave would silently truncate to 140 bytes
      throw new RangeError(`frame must be 1..${this.maxFrameBytes} bytes, got ${frame.length}`);
    }
    const view: Int8Array = this.g.encode(this.instance, frame, this.g.ProtocolId[PROTOCOL_NAMES[protocol]], this.volume);
    // view aliases a static WASM buffer that the next call overwrites
    const bytes = new Uint8Array(view.length);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.length));
    return new Float32Array(bytes.buffer);
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
        const res: Int8Array = this.g.decode(this.instance, new Uint8Array(this.pending.buffer));
        if (res && res.length > 0) out.push(Uint8Array.from(new Uint8Array(res.buffer, res.byteOffset, res.length)));
      }
    }
    return out;
  }
}
