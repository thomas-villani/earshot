// Byte-level vocabulary with an optimal (minimum total bits) segmentation.
// Token ids: 0 = end of message, 1..256 = single bytes 0..255, 257+ = multi-byte tokens.
// Single bytes guarantee any input can be tokenized.

export const EOF_TOKEN = 0;
export const BYTE_BASE = 1;
export const FIRST_MULTI = 257;

interface TrieNode {
  next: Map<number, TrieNode>;
  /** token id ending at this node, or -1 */
  id: number;
}

export class Vocab {
  /** bytes for each token id (empty for EOF) */
  readonly tokens: Uint8Array[];
  private root: TrieNode = { next: new Map(), id: -1 };

  constructor(multiByte: Uint8Array[]) {
    this.tokens = [new Uint8Array(0)];
    for (let b = 0; b < 256; b++) this.tokens.push(Uint8Array.of(b));
    this.tokens.push(...multiByte);
    for (let id = BYTE_BASE; id < this.tokens.length; id++) {
      let node = this.root;
      for (const b of this.tokens[id]) {
        let child = node.next.get(b);
        if (!child) node.next.set(b, (child = { next: new Map(), id: -1 }));
        node = child;
      }
      node.id = id;
    }
  }

  get size(): number {
    return this.tokens.length;
  }

  /** Segment `data` into token ids minimizing total cost (cost[id] in bits). Does not append EOF. */
  segment(data: Uint8Array, cost: ArrayLike<number>): number[] {
    const n = data.length;
    const best = new Float64Array(n + 1).fill(Infinity);
    const via = new Int32Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === Infinity) continue;
      let node: TrieNode | undefined = this.root;
      for (let j = i; j < n; j++) {
        node = node.next.get(data[j]);
        if (!node) break;
        if (node.id < 0) continue;
        const c = best[i] + cost[node.id];
        if (c < best[j + 1]) {
          best[j + 1] = c;
          via[j + 1] = node.id;
        }
      }
    }
    const out: number[] = [];
    for (let i = n; i > 0; i -= this.tokens[via[i]].length) out.push(via[i]);
    return out.reverse();
  }
}
