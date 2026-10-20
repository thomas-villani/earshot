// 32-bit integer arithmetic coder (Witten–Neal–Cleary) with static cumulative frequencies.
// Symbol probabilities come from a frequency table whose total must be <= 2^16, so
// range × cumulative stays below 2^48 and is exact in a JS double.

const TOP = 0xffffffff;
const HALF = 0x80000000;
const QUARTER = 0x40000000;

export class FreqTable {
  /** cum[s] = sum of freq[0..s-1]; cum[n] = total */
  readonly cum: Uint32Array;

  constructor(freqs: ArrayLike<number>) {
    this.cum = new Uint32Array(freqs.length + 1);
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] < 1) throw new RangeError(`symbol ${i} has zero frequency`);
      this.cum[i + 1] = this.cum[i] + freqs[i];
    }
    if (this.total > 0x10000) throw new RangeError(`frequency total ${this.total} exceeds 2^16`);
  }

  get total(): number {
    return this.cum[this.cum.length - 1];
  }

  get size(): number {
    return this.cum.length - 1;
  }

  /** Symbol whose cumulative interval contains `target` (binary search). */
  find(target: number): number {
    let lo = 0, hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= target) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Cost of a symbol in bits. */
  bits(s: number): number {
    return Math.log2(this.total / (this.cum[s + 1] - this.cum[s]));
  }
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private n = 0;

  bit(b: number): void {
    this.cur = (this.cur << 1) | b;
    if (++this.n === 8) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.n = 0;
    }
  }

  finish(): Uint8Array {
    if (this.n) this.bytes.push(this.cur << (8 - this.n));
    return Uint8Array.from(this.bytes);
  }
}

export class ArithEncoder {
  private low = 0;
  private high = TOP;
  private pending = 0;
  private out = new BitWriter();

  encode(table: FreqTable, s: number): void {
    const range = this.high - this.low + 1;
    const total = table.total;
    this.high = this.low + Math.floor((range * table.cum[s + 1]) / total) - 1;
    this.low = this.low + Math.floor((range * table.cum[s]) / total);
    for (;;) {
      if (this.high < HALF) {
        this.emit(0);
      } else if (this.low >= HALF) {
        this.emit(1);
        this.low -= HALF;
        this.high -= HALF;
      } else if (this.low >= QUARTER && this.high < HALF + QUARTER) {
        this.pending++;
        this.low -= QUARTER;
        this.high -= QUARTER;
      } else {
        break;
      }
      this.low *= 2;
      this.high = this.high * 2 + 1;
    }
  }

  finish(): Uint8Array {
    this.pending++;
    this.emit(this.low < QUARTER ? 0 : 1);
    return this.out.finish();
  }

  private emit(b: number): void {
    this.out.bit(b);
    for (; this.pending > 0; this.pending--) this.out.bit(b ^ 1);
  }
}

export class ArithDecoder {
  private low = 0;
  private high = TOP;
  private value = 0;
  private pos = 0;

  constructor(private data: Uint8Array) {
    for (let i = 0; i < 32; i++) this.value = this.value * 2 + this.nextBit();
  }

  /** True once we've read well past the end of the input: the stream is corrupt or truncated. */
  get overrun(): boolean {
    return this.pos > this.data.length * 8 + 64;
  }

  decode(table: FreqTable): number {
    const range = this.high - this.low + 1;
    const total = table.total;
    const target = Math.floor(((this.value - this.low + 1) * total - 1) / range);
    const s = table.find(Math.min(target, total - 1));
    this.high = this.low + Math.floor((range * table.cum[s + 1]) / total) - 1;
    this.low = this.low + Math.floor((range * table.cum[s]) / total);
    for (;;) {
      if (this.high < HALF) {
        // nothing to subtract
      } else if (this.low >= HALF) {
        this.low -= HALF;
        this.high -= HALF;
        this.value -= HALF;
      } else if (this.low >= QUARTER && this.high < HALF + QUARTER) {
        this.low -= QUARTER;
        this.high -= QUARTER;
        this.value -= QUARTER;
      } else {
        break;
      }
      this.low *= 2;
      this.high = this.high * 2 + 1;
      this.value = this.value * 2 + this.nextBit();
    }
    return s;
  }

  private nextBit(): number {
    const i = this.pos++;
    return i < this.data.length * 8 ? (this.data[i >> 3] >> (7 - (i & 7))) & 1 : 0;
  }
}
