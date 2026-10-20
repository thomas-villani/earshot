// Random linear fountain code over GF(2). See SPEC.md "Long messages & broadcast".
//
// Source = [len: u16][crc32: u32][message], zero-padded to k × B and split into k blocks.
// Each encoded block is the XOR of a subset of source blocks chosen by a 16-bit seed:
//   seed < k  → just source block `seed` (systematic: a lossless listener needs exactly k frames)
//   seed >= k → pseudo-random nonempty subset derived from (seed, k)
// The receiver runs incremental Gaussian elimination and decodes once it has k independent blocks.
import { crc32 } from '../framing/crc';

const SOURCE_HEADER_BYTES = 6;
export const MAX_BLOCKS = 255;

export interface Source {
  k: number;
  /** block size in bytes */
  b: number;
  blocks: Uint8Array[];
}

/** Split a message into k blocks of at most `maxBlockBytes`, sizing blocks evenly so the last isn't mostly padding. */
export function makeSource(message: Uint8Array, maxBlockBytes: number): Source {
  if (message.length > 0xffff) throw new RangeError('message too long for fountain coding');
  const total = SOURCE_HEADER_BYTES + message.length;
  const k = Math.ceil(total / maxBlockBytes);
  if (k > MAX_BLOCKS) throw new RangeError(`message needs ${k} blocks; max ${MAX_BLOCKS}`);
  const b = Math.ceil(total / k);
  const buf = new Uint8Array(k * b);
  const view = new DataView(buf.buffer);
  view.setUint16(0, message.length);
  view.setUint32(2, crc32(message));
  buf.set(message, SOURCE_HEADER_BYTES);
  return { k, b, blocks: Array.from({ length: k }, (_, i) => buf.subarray(i * b, (i + 1) * b)) };
}

/** Which source blocks seed `seed` combines, as a bitset of ceil(k/32) words. Must match on both ends. */
export function coefficients(seed: number, k: number): Uint32Array {
  const words = new Uint32Array(Math.ceil(k / 32));
  if (seed < k) {
    words[seed >> 5] = 1 << (seed & 31);
    return words;
  }
  // xorshift32 seeded from (seed, k); retry until the subset is nonempty
  let s = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b) ^ 0x5bd1e995) >>> 0 || 1;
  for (;;) {
    let any = 0;
    for (let w = 0; w < words.length; w++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      const bits = w === words.length - 1 && k % 32 ? s & ((1 << (k % 32)) - 1) : s;
      words[w] = bits;
      any |= bits;
    }
    if (any) return words;
  }
}

export function encodeBlock(src: Source, seed: number): Uint8Array {
  const coef = coefficients(seed, src.k);
  const out = new Uint8Array(src.b);
  for (let i = 0; i < src.k; i++) {
    if (coef[i >> 5] & (1 << (i & 31))) {
      const blk = src.blocks[i];
      for (let j = 0; j < src.b; j++) out[j] ^= blk[j];
    }
  }
  return out;
}

/** Seeds to transmit, in order: the k systematic blocks, then fresh random combinations forever. */
export function* seedSequence(k: number, start = Math.floor(Math.random() * 0x10000)): Generator<number> {
  for (let i = 0; i < k; i++) yield i;
  const span = 0x10000 - k;
  for (let i = 0; ; i++) yield k + ((start + i) % span);
}

interface Row {
  coef: Uint32Array;
  data: Uint8Array;
}

const lowestBit = (coef: Uint32Array): number => {
  for (let w = 0; w < coef.length; w++) if (coef[w]) return w * 32 + (31 - Math.clz32(coef[w] & -coef[w]));
  return -1;
};

export class FountainDecoder {
  /** pivot[c] = row whose lowest set coefficient is c */
  private pivot: (Row | undefined)[];
  private _rank = 0;
  private result: Uint8Array | null | undefined;

  constructor(
    readonly k: number,
    readonly b: number,
  ) {
    this.pivot = new Array(k);
  }

  get rank(): number {
    return this._rank;
  }

  get complete(): boolean {
    return this._rank === this.k;
  }

  /** Add an encoded block. Returns true if it was innovative (increased the rank). */
  add(seed: number, block: Uint8Array): boolean {
    if (block.length !== this.b || this.complete) return false;
    const coef = coefficients(seed, this.k);
    const data = block.slice();
    // eliminate against existing pivots in ascending order; each XOR only touches higher columns
    for (let c = 0; c < this.k; c++) {
      if (!(coef[c >> 5] & (1 << (c & 31)))) continue;
      const p = this.pivot[c];
      if (!p) continue;
      for (let w = 0; w < coef.length; w++) coef[w] ^= p.coef[w];
      for (let j = 0; j < this.b; j++) data[j] ^= p.data[j];
    }
    const lead = lowestBit(coef);
    if (lead < 0) return false;
    this.pivot[lead] = { coef, data };
    this._rank++;
    return true;
  }

  /**
   * The decoded message once complete: null if the length/CRC check fails (corrupt input),
   * undefined while still incomplete.
   */
  message(): Uint8Array | null | undefined {
    if (!this.complete) return undefined;
    if (this.result !== undefined) return this.result;
    // back-substitute from the highest column down so every row reduces to a single source block
    for (let c = this.k - 1; c >= 0; c--) {
      const row = this.pivot[c]!;
      for (let j = c + 1; j < this.k; j++) {
        if (!(row.coef[j >> 5] & (1 << (j & 31)))) continue;
        const p = this.pivot[j]!;
        for (let w = 0; w < row.coef.length; w++) row.coef[w] ^= p.coef[w];
        for (let x = 0; x < this.b; x++) row.data[x] ^= p.data[x];
      }
    }
    const buf = new Uint8Array(this.k * this.b);
    for (let c = 0; c < this.k; c++) buf.set(this.pivot[c]!.data, c * this.b);
    const view = new DataView(buf.buffer);
    const len = view.getUint16(0);
    const crc = view.getUint32(2);
    const msg = buf.slice(SOURCE_HEADER_BYTES, SOURCE_HEADER_BYTES + len);
    this.result = SOURCE_HEADER_BYTES + len <= buf.length && crc32(msg) === crc ? msg : null;
    return this.result;
  }
}

// --- fountain frame body: [msgId: u16][k: u8][seed: u16][block]

export const FOUNTAIN_HEADER_BYTES = 5;

export interface FountainPacket {
  msgId: number;
  k: number;
  seed: number;
  block: Uint8Array;
}

export function encodePacket(p: FountainPacket): Uint8Array {
  const out = new Uint8Array(FOUNTAIN_HEADER_BYTES + p.block.length);
  out[0] = p.msgId >> 8;
  out[1] = p.msgId & 0xff;
  out[2] = p.k;
  out[3] = p.seed >> 8;
  out[4] = p.seed & 0xff;
  out.set(p.block, FOUNTAIN_HEADER_BYTES);
  return out;
}

export function decodePacket(body: Uint8Array): FountainPacket | null {
  if (body.length <= FOUNTAIN_HEADER_BYTES || body[2] === 0) return null;
  return { msgId: (body[0] << 8) | body[1], k: body[2], seed: (body[3] << 8) | body[4], block: body.slice(FOUNTAIN_HEADER_BYTES) };
}
