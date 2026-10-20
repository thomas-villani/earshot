// Evaluate the text compressor on the held-out message set (test/fixtures/messages.ts).
//   npx tsx test/compress-eval.ts
// Compares today's encoding (JSON/QR payloads, deflate if smaller) with packed payloads + best codec.
import modelData from '../src/compress/model-data.json';
import { TextCodec, type ModelData } from '../src/compress/text-codec';
import { GgwaveModem } from '../src/modem/ggwave-modem';
import { EVAL_MESSAGES } from './fixtures/messages';

const codec = TextCodec.fromData(modelData as ModelData);
const modem = await GgwaveModem.create();
const utf8 = (s: string) => new TextEncoder().encode(s);

async function deflate(b: Uint8Array): Promise<number> {
  const s = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return (await new Response(s).arrayBuffer()).byteLength;
}

/** The payload as the app encodes it before this change. */
function legacy(category: string, packed: string): string {
  const f = packed.split('\x1e');
  if (category === 'contact') {
    const o: Record<string, string> = { n: f[0] };
    (['p', 'e', 'o'] as const).forEach((k, i) => f[i + 1] && (o[k] = f[i + 1]));
    return JSON.stringify(o);
  }
  if (category === 'wifi') return `WIFI:T:${f[0] === 'N' ? 'nopass' : f[0] === 'E' ? 'WEP' : 'WPA'};S:${f[1]};${f[0] === 'N' ? '' : `P:${f[2]};`};`;
  if (category === 'prompt') return JSON.stringify(f[1] ? { prompt: f[0], context: f[1] } : { prompt: f[0] });
  return packed;
}

/** Audible-fast airtime of a SINGLE frame carrying a message payload of `n` bytes (+2 type/flags, +6 frame header). */
const airtime = (n: number) => (n + 8 <= 140 ? modem.encode(new Uint8Array(n + 8), 'audible-fast').length / 48000 : NaN);

console.log('| category | n | before (avg B) | packed raw | packed + deflate | packed + model | saving | airtime before → after (Fast) |');
console.log('|---|---|---|---|---|---|---|---|');
let allBefore = 0, allAfter = 0;
for (const [cat, msgs] of Object.entries(EVAL_MESSAGES)) {
  let before = 0, raw = 0, def = 0, best = 0, tBefore = 0, tAfter = 0;
  for (const m of msgs) {
    const old = utf8(legacy(cat, m));
    const b = Math.min(old.length, await deflate(old));
    const p = utf8(m);
    const d = Math.min(p.length, await deflate(p));
    const enc = codec.encode(p);
    if (!codec.decode(enc, 65535)?.every((x, i) => x === p[i])) throw new Error(`round-trip failed: ${m}`);
    const after = Math.min(p.length, d, enc.length);
    before += b;
    raw += p.length;
    def += d;
    best += after;
    tBefore += airtime(b);
    tAfter += airtime(after);
  }
  allBefore += before;
  allAfter += best;
  const n = msgs.length;
  const avg = (x: number) => (x / n).toFixed(1);
  const t = Number.isNaN(tBefore) ? 'multi-frame' : `${(tBefore / n).toFixed(2)} s → ${(tAfter / n).toFixed(2)} s`;
  console.log(`| ${cat} | ${n} | ${avg(before)} | ${avg(raw)} | ${avg(def)} | ${avg(best)} | ${Math.round(100 * (1 - best / before))}% | ${t} |`);
}
console.log(`\nOverall: ${allBefore} → ${allAfter} bytes (${Math.round(100 * (1 - allAfter / allBefore))}% smaller)`);
