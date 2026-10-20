// Static-model text compressor: optimal tokenization + arithmetic coding with fixed token frequencies.
// Built for short messages, where deflate can't win because it must learn everything from the message itself.
import { ArithDecoder, ArithEncoder, FreqTable } from './arith';
import { BYTE_BASE, EOF_TOKEN, Vocab } from './tokenizer';

/** Serialized model, as written by tools/train-compressor.ts. */
export interface ModelData {
  version: number;
  /** base64 of all multi-byte tokens concatenated */
  tokens: string;
  /** byte length of each multi-byte token */
  lens: number[];
  /** frequency per token id (EOF, 256 bytes, then multi-byte tokens); total <= 2^16 */
  freqs: number[];
}

export class TextCodec {
  readonly table: FreqTable;
  private cost: Float64Array;

  constructor(
    readonly vocab: Vocab,
    freqs: ArrayLike<number>,
  ) {
    if (freqs.length !== vocab.size) throw new Error(`model has ${freqs.length} frequencies for ${vocab.size} tokens`);
    this.table = new FreqTable(freqs);
    this.cost = Float64Array.from({ length: vocab.size }, (_, i) => this.table.bits(i));
  }

  static fromData(d: ModelData): TextCodec {
    const all = Uint8Array.from(atob(d.tokens), (c) => c.charCodeAt(0));
    const tokens: Uint8Array[] = [];
    let off = 0;
    for (const len of d.lens) {
      tokens.push(all.slice(off, off + len));
      off += len;
    }
    return new TextCodec(new Vocab(tokens), d.freqs);
  }

  encode(data: Uint8Array): Uint8Array {
    const enc = new ArithEncoder();
    for (const id of this.vocab.segment(data, this.cost)) enc.encode(this.table, id);
    enc.encode(this.table, EOF_TOKEN);
    return enc.finish();
  }

  /** Returns null for corrupt input or if the output would exceed `maxBytes`. */
  decode(data: Uint8Array, maxBytes: number): Uint8Array | null {
    const dec = new ArithDecoder(data);
    const out: number[] = [];
    for (;;) {
      if (dec.overrun) return null;
      const id = dec.decode(this.table);
      if (id === EOF_TOKEN) return Uint8Array.from(out);
      const tok = this.vocab.tokens[id];
      if (out.length + tok.length > maxBytes) return null;
      for (const b of tok) out.push(b);
    }
  }

  /** Estimated compressed size in bits (without arithmetic coder rounding). */
  bits(data: Uint8Array): number {
    let total = this.cost[EOF_TOKEN];
    for (const id of this.vocab.segment(data, this.cost)) total += this.cost[id];
    return total;
  }
}

export { BYTE_BASE };
