// Clean-loopback error rates per protocol and payload length (wrong data / nothing decoded).
import { GgwaveModem } from '../src/modem/ggwave-modem';
import { PROTOCOLS } from '../src/modem/modem';
const m = await GgwaveModem.create();
const same = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((v, i) => v === b[i]);
let seed = 999; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16);
const lens = [2, 3, 8, 16, 32, 64, 100, 140];
const TRIALS = 25;
console.log('protocol'.padEnd(20), lens.map((l) => `${l}B`.padStart(9)).join(''), '   (wrong data / nothing decoded, of', TRIALS, ')');
for (const p of PROTOCOLS) {
  const cells: string[] = [];
  for (const len of lens) {
    let wrong = 0, none = 0;
    for (let t = 0; t < TRIALS; t++) {
      const f = Uint8Array.from({ length: len }, () => rnd() & 0xff);
      const w = m.encode(f, p);
      const off = rnd() % 4096;
      const pad = new Float32Array(w.length + off + 48000); pad.set(w, off);
      const got = m.pushSamples(pad);
      if (got.length === 0) none++; else if (!got.some((g) => same(f, g))) wrong++;
    }
    cells.push(`${wrong}/${none}`.padStart(9));
  }
  console.log(p.padEnd(20), cells.join(''));
}
