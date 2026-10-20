import { describe, expect, it } from 'vitest';
import {
  coefficients,
  decodePacket,
  encodeBlock,
  encodePacket,
  FountainDecoder,
  makeSource,
  seedSequence,
} from '../src/fountain/fountain';
import { Rng } from './sim/rng';

const msgOf = (n: number, seed = 1) => new Rng(seed).bytes(n);

function decodeWith(message: Uint8Array, maxB: number, seeds: Iterable<number>): { decoded: Uint8Array | null | undefined; used: number } {
  const src = makeSource(message, maxB);
  const dec = new FountainDecoder(src.k, src.b);
  let used = 0;
  for (const seed of seeds) {
    dec.add(seed, encodeBlock(src, seed));
    used++;
    if (dec.complete) break;
  }
  return { decoded: dec.message(), used };
}

describe('makeSource', () => {
  it('sizes blocks evenly', () => {
    const src = makeSource(new Uint8Array(500), 129);
    expect(src.k).toBe(4);
    expect(src.b).toBe(127); // ceil(506 / 4), not 129
    expect(makeSource(new Uint8Array(1), 129)).toMatchObject({ k: 1, b: 7 });
  });

  it('refuses messages needing more than 255 blocks', () => {
    expect(() => makeSource(new Uint8Array(256 * 129), 129)).toThrow(RangeError);
  });
});

describe('coefficients', () => {
  it('is systematic below k and a nonempty subset within k bits above', () => {
    expect(Array.from(coefficients(3, 10))).toEqual([1 << 3]);
    for (let seed = 40; seed < 2000; seed++) {
      const c = coefficients(seed, 40);
      expect(c.length).toBe(2);
      expect(c[0] | c[1]).not.toBe(0);
      expect(c[1] >>> 8).toBe(0); // no bits beyond k = 40
    }
  });

  it('is deterministic', () => {
    expect(coefficients(12345, 17)).toEqual(coefficients(12345, 17));
  });
});

describe('fountain decode', () => {
  it('decodes from exactly k systematic blocks', () => {
    const m = msgOf(500);
    const { decoded, used } = decodeWith(m, 129, seedSequence(4, 0));
    expect(decoded).toEqual(m);
    expect(used).toBe(4);
  });

  it('decodes from random combinations only (late joiner), typically within k + 3', () => {
    const rng = new Rng(2);
    const overheads: number[] = [];
    for (let t = 0; t < 200; t++) {
      const m = msgOf(1 + rng.int(3000), t);
      const k = makeSource(m, 129).k;
      const seeds = Array.from({ length: k + 40 }, (_, i) => k + ((t * 977 + i) % (0x10000 - k)));
      const { decoded, used } = decodeWith(m, 129, seeds);
      expect(decoded).toEqual(m);
      overheads.push(used - k);
    }
    const within3 = overheads.filter((o) => o <= 3).length / overheads.length;
    expect(within3).toBeGreaterThan(0.85);
  });

  it('survives random loss, duplicates and reordering', () => {
    const rng = new Rng(3);
    const m = msgOf(2000);
    const src = makeSource(m, 129);
    const dec = new FountainDecoder(src.k, src.b);
    const gen = seedSequence(src.k, 777);
    const sent: number[] = [];
    for (let i = 0; i < src.k * 3; i++) sent.push(gen.next().value as number);
    const received = sent.filter(() => rng.next() > 0.3); // 30% loss
    received.push(...received.slice(0, 5)); // duplicates
    for (let i = received.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [received[i], received[j]] = [received[j], received[i]];
    }
    for (const s of received) dec.add(s, encodeBlock(src, s));
    expect(dec.message()).toEqual(m);
  });

  it('reports non-innovative blocks', () => {
    const src = makeSource(msgOf(300), 129);
    const dec = new FountainDecoder(src.k, src.b);
    expect(dec.add(0, encodeBlock(src, 0))).toBe(true);
    expect(dec.add(0, encodeBlock(src, 0))).toBe(false);
    expect(dec.rank).toBe(1);
  });

  it('returns null when the CRC does not match', () => {
    const src = makeSource(msgOf(300), 129);
    const dec = new FountainDecoder(src.k, src.b);
    for (let s = 0; s < src.k; s++) {
      const blk = encodeBlock(src, s);
      if (s === 1) blk[10] ^= 1;
      dec.add(s, blk);
    }
    expect(dec.message()).toBeNull();
  });

  it('ignores blocks of the wrong size', () => {
    const dec = new FountainDecoder(3, 50);
    expect(dec.add(0, new Uint8Array(49))).toBe(false);
  });
});

describe('fountain packet', () => {
  it('round-trips and rejects k = 0 or empty blocks', () => {
    const p = { msgId: 0xabcd, k: 7, seed: 0x1234, block: new Uint8Array([9, 8, 7]) };
    expect(decodePacket(encodePacket(p))).toEqual(p);
    expect(decodePacket(encodePacket({ ...p, k: 0 }))).toBeNull();
    expect(decodePacket(new Uint8Array(5))).toBeNull();
  });
});
