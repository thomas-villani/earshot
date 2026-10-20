// Can we send audible + ultrasound simultaneously and decode both? (doubling throughput)
import factory from 'ggwave';
import { applyChannel, CLEAN, highpass, lowpass, type ChannelConfig } from '../test/sim/channel';
import { Rng } from '../test/sim/rng';

const g = await factory({ print: () => {}, printErr: () => {} });
g.disableLog();
const P = g.ProtocolId;
const AUDIBLE = ['AUDIBLE_NORMAL', 'AUDIBLE_FAST', 'AUDIBLE_FASTEST'];
const ULTRA = ['ULTRASOUND_NORMAL', 'ULTRASOUND_FAST', 'ULTRASOUND_FASTEST'];
const OTHER = ['DT_NORMAL', 'DT_FAST', 'DT_FASTEST'];

function params() {
  const p = g.getDefaultParameters();
  p.sampleFormatInp = g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  p.sampleFormatOut = g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  return p;
}
/** rxToggleProtocol is global; check whether it is captured per instance at init time. */
function initWith(enabled: string[]) {
  for (const n of [...AUDIBLE, ...ULTRA, ...OTHER]) g.rxToggleProtocol(P['GGWAVE_PROTOCOL_' + n], enabled.includes(n) ? 1 : 0);
  return g.init(params());
}
const tx = initWith([...AUDIBLE, ...ULTRA]);
const rxAll = initWith([...AUDIBLE, ...ULTRA]);
const rxAud = initWith(AUDIBLE);
const rxUlt = initWith(ULTRA);

function encode(data: Uint8Array, proto: string): Float32Array {
  const v = g.encode(tx, data, P['GGWAVE_PROTOCOL_' + proto], 25);
  return new Float32Array(Uint8Array.from(new Uint8Array(v.buffer, v.byteOffset, v.length)).buffer);
}
function decode(inst: number, x: Float32Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + 1024 <= x.length; i += 1024) {
    const r = g.decode(inst, new Uint8Array(x.buffer, x.byteOffset + i * 4, 1024 * 4));
    if (r.length) out.push(Uint8Array.from(new Uint8Array(r.buffer, r.byteOffset, r.length)));
  }
  return out;
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const normalize = (x: Float32Array, peak: number) => {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return x.map((v) => (v / m) * peak);
};

const rng = new Rng(7);
const A = rng.bytes(64), B = rng.bytes(64);

// 1. clean mix: which instance decodes what?
const a = encode(A, 'AUDIBLE_FAST'), b = encode(B, 'ULTRASOUND_FAST');
const mix = new Float32Array(Math.max(a.length, b.length) + 48000);
for (let i = 0; i < a.length; i++) mix[i] += a[i] * 0.5;
for (let i = 0; i < b.length; i++) mix[i] += b[i] * 0.5;
const show = (frames: Uint8Array[]) => frames.map((f) => (same(f, A) ? 'A' : same(f, B) ? 'B' : 'garbage')).join(',') || 'nothing';
console.log('clean mix, rx with all protocols:', show(decode(rxAll, mix)));
console.log('clean mix, audible-only rx:      ', show(decode(rxAud, mix)));
console.log('clean mix, ultrasound-only rx:   ', show(decode(rxUlt, mix)));
console.log('clean mix, band-split (LP 10k -> audible rx, HP 12k -> ultra rx):', show(decode(rxAud, lowpass(mix, 10000))), show(decode(rxUlt, highpass(highpass(mix, 12000), 12000))));

// 2. through the living-room channel: dual-band vs each band alone at the same total speaker power
const ROOM: ChannelConfig = { device: 'phone', rt60: 0.4, drrDb: 0, snrDb: 0, noise: 'pink', gainDb: 0, driftPpm: 50 };
const TRIALS = 30;
// ggwave allows 4 live instances: keep tx, re-create receivers per trial
for (const inst of [rxAll, rxAud, rxUlt]) g.free(inst);
console.log(`\nLiving room (phone, RT60 0.4, pink noise, 50 ppm), 64 B per band, ${TRIALS} trials. SNR is for the total transmitted signal.`);
console.log('| SNR | audible alone | ultra alone | dual: audible | dual: ultra | dual goodput vs best single |');
console.log('|---|---|---|---|---|---|');
for (const snr of [10, 0, -5, -10]) {
  let aAlone = 0, uAlone = 0, aDual = 0, uDual = 0;
  for (let t = 0; t < TRIALS; t++) {
    const pa = rng.bytes(64), pb = rng.bytes(64);
    const wa = normalize(encode(pa, 'AUDIBLE_FAST'), 0.25), wb = normalize(encode(pb, 'ULTRASOUND_FAST'), 0.25);
    const cfg = { ...ROOM, snrDb: snr };
    // each band alone at full power
    const ra = initWith(AUDIBLE), ru = initWith(ULTRA);
    if (decode(ra, applyChannel(wa, cfg, rng)).some((f) => same(f, pa))) aAlone++;
    if (decode(ru, applyChannel(wb, cfg, rng)).some((f) => same(f, pb))) uAlone++;
    // both at once, same total power (each scaled by 1/sqrt2)
    const m = new Float32Array(Math.max(wa.length, wb.length));
    for (let i = 0; i < wa.length; i++) m[i] += wa[i] * Math.SQRT1_2;
    for (let i = 0; i < wb.length; i++) m[i] += wb[i] * Math.SQRT1_2;
    const rx = applyChannel(m, cfg, rng);
    g.free(ra);
    g.free(ru);
    const da = initWith(AUDIBLE), du = initWith(ULTRA);
    if (decode(da, rx).some((f) => same(f, pa))) aDual++;
    if (decode(du, rx).some((f) => same(f, pb))) uDual++;
    g.free(da);
    g.free(du);
  }
  const pct = (n: number) => `${Math.round((100 * n) / TRIALS)}%`;
  const ratio = (aDual + uDual) / Math.max(aAlone, uAlone);
  console.log(`| ${snr} | ${pct(aAlone)} | ${pct(uAlone)} | ${pct(aDual)} | ${pct(uDual)} | ${ratio.toFixed(2)}× |`);
}
