// Message <-> frames. Short messages go in one SINGLE frame; longer ones are fountain coded.
import { decodePacket, encodePacket, FOUNTAIN_HEADER_BYTES, FountainDecoder, makeSource, seedSequence, type Source, encodeBlock } from '../fountain/fountain';
import { crc32 } from './crc';
import { decodeFrame, encodeFrame, FRAME_HEADER_BYTES, FrameKind } from './frame';
import { decodeMessage, type Message } from './message';

/** Largest encoded message that fits in one SINGLE frame. */
export const maxSingleMessageBytes = (maxFrameBytes: number) => maxFrameBytes - FRAME_HEADER_BYTES;
/** Largest fountain block that fits in one frame. */
export const maxBlockBytes = (maxFrameBytes: number) => maxFrameBytes - FRAME_HEADER_BYTES - FOUNTAIN_HEADER_BYTES;

export function randomNonce(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0];
}

/**
 * Produces frames for one message, one round at a time. Each round has one frame per lane (band);
 * lanes play simultaneously. SINGLE messages repeat the same frame on every lane for diversity;
 * fountain messages give every lane a different block.
 */
export class Transmission {
  readonly single: boolean;
  /** Source blocks (1 for SINGLE). */
  readonly k: number;
  /** Rounds for a one-shot send: all blocks plus some repair margin. Broadcast just keeps going. */
  readonly onceRounds: number;
  private source?: Source;
  private seeds?: Generator<number>;
  private singleFrame?: Uint8Array;
  /** Derived from the content, so re-sending the same message tops up listeners instead of starting over. */
  private msgId: number;

  constructor(
    encodedMessage: Uint8Array,
    private nonce: number,
    maxFrameBytes: number,
    private lanes: number,
  ) {
    this.msgId = crc32(encodedMessage) & 0xffff;
    this.single = encodedMessage.length <= maxSingleMessageBytes(maxFrameBytes);
    if (this.single) {
      this.singleFrame = encodeFrame({ kind: FrameKind.Single, nonce, body: encodedMessage });
      this.k = 1;
      this.onceRounds = 1;
    } else {
      this.source = makeSource(encodedMessage, maxBlockBytes(maxFrameBytes));
      this.seeds = seedSequence(this.source.k);
      this.k = this.source.k;
      const repair = Math.max(1, Math.ceil(this.k / 4));
      this.onceRounds = Math.ceil((this.k + repair) / lanes);
    }
  }

  nextRound(): Uint8Array[] {
    if (this.singleFrame) return Array.from({ length: this.lanes }, () => this.singleFrame!);
    return Array.from({ length: this.lanes }, () => {
      const seed = this.seeds!.next().value as number;
      const body = encodePacket({ msgId: this.msgId, k: this.source!.k, seed, block: encodeBlock(this.source!, seed) });
      return encodeFrame({ kind: FrameKind.Fountain, nonce: this.nonce, body });
    });
  }
}

export type ReceiveEvent =
  | {
      kind: 'message';
      message: Message;
      nonce: number;
      /** stable id for this exact message from this sender */
      key: string;
      /** times it has been heard */
      count: number;
    }
  | { kind: 'progress'; key: string; nonce: number; have: number; need: number }
  | { kind: 'duplicate'; key: string }
  | { kind: 'echo' }
  | { kind: 'rejected'; reason: string };

/** Copies heard within this window (e.g. the same SINGLE frame on two bands) count once. */
const REPEAT_WINDOW_MS = 2000;
/** Forget partially received fountain messages after this long without a new frame. */
const STALE_MS = 5 * 60 * 1000;

interface InFlight {
  decoder: FountainDecoder;
  lastSeen: number;
  done: boolean;
}

export class Receiver {
  private seen = new Map<string, { count: number; last: number }>();
  private inFlight = new Map<string, InFlight>();

  constructor(
    private ownNonce: number,
    private now: () => number = () => Date.now(),
  ) {}

  async push(raw: Uint8Array): Promise<ReceiveEvent> {
    const frame = decodeFrame(raw);
    if (!frame) return { kind: 'rejected', reason: 'bad frame (magic, kind, or CRC)' };
    if (frame.nonce === this.ownNonce) return { kind: 'echo' };
    return frame.kind === FrameKind.Single ? this.single(frame.nonce, frame.body) : this.fountain(frame.nonce, frame.body);
  }

  private async single(nonce: number, body: Uint8Array): Promise<ReceiveEvent> {
    const message = await decodeMessage(body);
    if (!message) return { kind: 'rejected', reason: 'malformed message' };
    const key = `s:${nonce}:${Array.from(body).join(',')}`;
    const t = this.now();
    const prev = this.seen.get(key);
    if (prev && t - prev.last < REPEAT_WINDOW_MS) return { kind: 'duplicate', key };
    const count = (prev?.count ?? 0) + 1;
    this.seen.set(key, { count, last: t });
    return { kind: 'message', message, nonce, key, count };
  }

  private async fountain(nonce: number, body: Uint8Array): Promise<ReceiveEvent> {
    const p = decodePacket(body);
    if (!p) return { kind: 'rejected', reason: 'malformed fountain packet' };
    const t = this.now();
    for (const [k, v] of this.inFlight) if (!v.done && t - v.lastSeen > STALE_MS) this.inFlight.delete(k);

    const key = `f:${nonce}:${p.msgId}`;
    let entry = this.inFlight.get(key);
    if (entry?.done) return { kind: 'duplicate', key };
    if (!entry || entry.decoder.k !== p.k || entry.decoder.b !== p.block.length) {
      entry = { decoder: new FountainDecoder(p.k, p.block.length), lastSeen: t, done: false };
      this.inFlight.set(key, entry);
    }
    entry.lastSeen = t;
    entry.decoder.add(p.seed, p.block);
    const bytes = entry.decoder.message();
    if (bytes === undefined) return { kind: 'progress', key, nonce, have: entry.decoder.rank, need: p.k };
    if (bytes === null) {
      this.inFlight.delete(key);
      return { kind: 'rejected', reason: 'fountain message failed CRC; starting over' };
    }
    entry.done = true;
    const message = await decodeMessage(bytes);
    if (!message) return { kind: 'rejected', reason: 'malformed message' };
    return { kind: 'message', message, nonce, key, count: 1 };
  }
}
