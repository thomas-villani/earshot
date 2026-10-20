/** Small seeded PRNG (mulberry32) so simulator runs are reproducible. */
export class Rng {
  private s: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  bytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => this.int(256));
  }

  /** Standard normal (Box-Muller). */
  gaussian(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    const th = 2 * Math.PI * this.next();
    this.spare = r * Math.sin(th);
    return r * Math.cos(th);
  }
}
