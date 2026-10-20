// Milestone 0 spike: binary handling, sample-rate config, streamed decode.
import factory from 'ggwave';

const g = await factory();
g.disableLog();
const P = g.ProtocolId;

function makeInstance(rateIn: number, rateOut: number) {
  const p = g.getDefaultParameters();
  p.sampleRateInp = rateIn;
  p.sampleRateOut = rateOut;
  p.sampleFormatInp = g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  p.sampleFormatOut = g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  return { inst: g.init(p), params: p };
}

const asBytes = (f: Float32Array) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);

function encode(inst: number, data: Uint8Array, proto: number): Float32Array {
  const view: Int8Array = g.encode(inst, data, proto, 25);
  // view aliases a static WASM buffer; copy before the next call
  const copy = new Uint8Array(view.length);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.length));
  return new Float32Array(copy.buffer);
}

function streamDecode(inst: number, samples: Float32Array, chunk: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  // pad with silence so the decoder sees the end marker
  const padded = new Float32Array(samples.length + 48000);
  padded.set(samples, 12000);
  // ggwave drops partial frames, so accumulate arriving chunks into whole 1024-sample frames
  const spf = 1024;
  const pending = new Float32Array(spf);
  let fill = 0;
  for (let i = 0; i < padded.length; i += chunk) {
    const c = padded.subarray(i, i + chunk);
    for (let j = 0; j < c.length; ) {
      const n = Math.min(spf - fill, c.length - j);
      pending.set(c.subarray(j, j + n), fill);
      fill += n; j += n;
      if (fill === spf) {
        fill = 0;
        const res: Int8Array = g.decode(inst, asBytes(pending));
        if (res && res.length > 0) out.push(Uint8Array.from(new Uint8Array(res.buffer, res.byteOffset, res.length)));
      }
    }
  }
  return out;
}

function resample(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * from) / to, i0 = Math.floor(t), f = t - i0;
    y[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f;
  }
  return y;
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (a: Uint8Array) => Buffer.from(a).toString('hex');

console.log('default params:', g.getDefaultParameters());

// 1. Binary: every byte value 0..255, including 0x00 and >=0x80, in 140-byte chunks
const all = Uint8Array.from({ length: 256 }, (_, i) => i);
const payloads = [all.subarray(0, 140), all.subarray(116, 256), new Uint8Array([0, 0, 0]), new Uint8Array([0xff]), new Uint8Array(141)];
const { inst: tx } = makeInstance(48000, 48000);
let { inst: rx } = makeInstance(48000, 48000);
for (const p of payloads) {
  let wave: Float32Array;
  try { wave = encode(tx, p, P.GGWAVE_PROTOCOL_AUDIBLE_FASTEST); } catch (e) { console.log(`len ${p.length}: encode threw ${e}`); continue; }
  if (wave.length === 0) { console.log(`len ${p.length}: encode returned empty`); continue; }
  const got = streamDecode(rx, wave, 128);
  console.log(`binary len ${p.length}: ${got.length === 1 && eq(got[0], p) ? 'OK' : 'FAIL ' + got.map(hex)}`);
}

// 2. Airtime and round-trip per protocol (128-sample chunks = AudioWorklet render quantum)
const msg = new TextEncoder().encode('https://example.com/some/path?q=1');
const msg140 = all.subarray(0, 140);
const names = ['AUDIBLE_NORMAL', 'AUDIBLE_FAST', 'AUDIBLE_FASTEST', 'ULTRASOUND_NORMAL', 'ULTRASOUND_FAST', 'ULTRASOUND_FASTEST', 'DT_NORMAL', 'DT_FAST', 'DT_FASTEST'];
for (const name of names) {
  const id = P['GGWAVE_PROTOCOL_' + name];
  const w = encode(tx, msg, id);
  const w140 = encode(tx, msg140, id);
  const ok = streamDecode(rx, w, 128).some((r) => eq(r, msg));
  const ok140 = streamDecode(rx, w140, 128).some((r) => eq(r, msg140));
  console.log(`${name.padEnd(20)} ${msg.length}B: ${(w.length / 48000).toFixed(2)}s ${ok ? 'OK' : 'FAIL'} | 140B: ${(w140.length / 48000).toFixed(2)}s ${ok140 ? 'OK' : 'FAIL'}`);
}

// 3. Sample-rate mismatch: encoded at 48000, captured at 44100
const w48 = encode(tx, msg, P.GGWAVE_PROTOCOL_AUDIBLE_FAST);
const w441 = resample(w48, 48000, 44100);
g.free(rx);
const { inst: rx441 } = makeInstance(44100, 44100);
const { inst: rxWrong } = makeInstance(48000, 48000);
console.log('44.1k capture, rx configured 44.1k:', streamDecode(rx441, w441, 128).some((r) => eq(r, msg)) ? 'OK' : 'FAIL');
console.log('44.1k capture, rx configured 48k (misconfigured):', streamDecode(rxWrong, w441, 128).some((r) => eq(r, msg)) ? 'OK' : 'FAIL');

g.free(rx441); g.free(rxWrong);
rx = makeInstance(48000, 48000).inst;
// 4. Chunk sizes
for (const c of [128, 512, 1024, 4096]) {
  console.log(`chunk ${c}:`, streamDecode(rx, w48, c).some((r) => eq(r, msg)) ? 'OK' : 'FAIL');
}
