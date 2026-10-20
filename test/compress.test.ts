import { describe, expect, it } from 'vitest';
import { ArithDecoder, ArithEncoder, FreqTable } from '../src/compress/arith';
import { TextCodec } from '../src/compress/text-codec';
import { FIRST_MULTI, Vocab } from '../src/compress/tokenizer';
import { Rng } from './sim/rng';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('arithmetic coder', () => {
  it('round-trips random symbol sequences with skewed and flat tables', () => {
    const rng = new Rng(1);
    for (const freqs of [[1, 1], [1000, 1, 5, 300, 2], Array.from({ length: 300 }, (_, i) => 1 + (i % 7) * 30)]) {
      const table = new FreqTable(freqs);
      for (let t = 0; t < 50; t++) {
        const syms = Array.from({ length: rng.int(200) }, () => table.find(rng.int(table.total)));
        const enc = new ArithEncoder();
        for (const s of syms) enc.encode(table, s);
        const bytes = enc.finish();
        const dec = new ArithDecoder(bytes);
        expect(syms.map(() => dec.decode(table))).toEqual(syms);
      }
    }
  });

  it('approaches the entropy bound', () => {
    const table = new FreqTable([60000, 5536]);
    const enc = new ArithEncoder();
    for (let i = 0; i < 10000; i++) enc.encode(table, 0);
    // 10000 × log2(65536/60000) ≈ 1273 bits ≈ 160 bytes
    expect(enc.finish().length).toBeLessThan(165);
  });

  it('rejects zero frequencies and totals above 2^16', () => {
    expect(() => new FreqTable([1, 0])).toThrow();
    expect(() => new FreqTable([0x10000, 1])).toThrow();
  });
});

describe('tokenizer', () => {
  const vocab = new Vocab([utf8('th'), utf8('the'), utf8(' the'), utf8('he')]);

  it('picks the cheapest segmentation, not the greedy one', () => {
    const cost = new Float64Array(vocab.size).fill(8);
    // make "th" + "e" more expensive than "t" + "he"
    cost[FIRST_MULTI] = 20; // th
    cost[FIRST_MULTI + 1] = 30; // the
    cost[FIRST_MULTI + 3] = 2; // he
    const ids = vocab.segment(utf8('the'), cost);
    expect(ids.map((i) => new TextDecoder().decode(vocab.tokens[i]))).toEqual(['t', 'he']);
  });

  it('always covers arbitrary bytes', () => {
    const cost = new Float64Array(vocab.size).fill(8);
    const data = Uint8Array.from({ length: 50 }, (_, i) => (i * 37) & 0xff);
    const ids = vocab.segment(data, cost);
    expect(Uint8Array.from(ids.flatMap((i) => Array.from(vocab.tokens[i])))).toEqual(data);
  });
});

describe('TextCodec (toy model)', () => {
  const words = [' the', ' and', 'ing', 'https://', '.com', 'hello', ' world'].map(utf8);
  const freqs = Array.from({ length: 257 + words.length }, (_, i) => (i === 0 ? 50 : i < 257 ? 2 + (i >= 97 && i <= 122 ? 40 : 0) : 300));
  const codec = new TextCodec(new Vocab(words), freqs);

  it('round-trips text, empty input, emoji, and arbitrary bytes', () => {
    const rng = new Rng(4);
    const samples = [utf8('hello world and the thing'), new Uint8Array(0), utf8('👋 héllo https://example.com'), rng.bytes(300)];
    for (const s of samples) expect(codec.decode(codec.encode(s), 1000)).toEqual(s);
  });

  it('compresses text that matches the model', () => {
    const s = utf8('hello world and the https://example.com');
    expect(codec.encode(s).length).toBeLessThan(s.length * 0.6);
  });

  it('never hangs or overflows on garbage input', () => {
    const rng = new Rng(5);
    for (let t = 0; t < 200; t++) {
      const out = codec.decode(rng.bytes(rng.int(40)), 500);
      if (out) expect(out.length).toBeLessThanOrEqual(500);
    }
  });

  it('estimates size close to the real encoding', () => {
    const s = utf8('hello world and the thing and the other thing');
    expect(Math.abs(codec.bits(s) / 8 - codec.encode(s).length)).toBeLessThan(2);
  });
});

describe('trained model', () => {
  it('round-trips every held-out message and compresses English well', async () => {
    const { default: data } = await import('../src/compress/model-data.json');
    const { EVAL_MESSAGES } = await import('./fixtures/messages');
    const model = TextCodec.fromData(data);
    let raw = 0, packed = 0;
    for (const msgs of Object.values(EVAL_MESSAGES)) {
      for (const m of msgs) {
        const b = utf8(m);
        const enc = model.encode(b);
        expect(model.decode(enc, 65535)).toEqual(b);
        raw += b.length;
        packed += enc.length;
      }
    }
    expect(packed / raw).toBeLessThan(0.6);
  });

  it('was not trained on the evaluation set', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('tools/train-compressor.ts', 'utf8')).not.toMatch(/fixtures/);
  });
});
