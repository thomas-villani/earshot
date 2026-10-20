// Message <-> frame bytes. SINGLE frames only for now; fountain coding arrives in milestone 4.
import { decodeFrame, encodeFrame, FRAME_HEADER_BYTES, FrameKind } from './frame';
import { decodeMessage, type Message } from './message';

/** Largest encoded message that fits in one SINGLE frame of a 140-byte modem. */
export const maxSingleMessageBytes = (maxFrameBytes: number) => maxFrameBytes - FRAME_HEADER_BYTES;

export function randomNonce(): number {
  return crypto.getRandomValues(new Uint16Array(1))[0];
}

export function toFrames(encodedMessage: Uint8Array, nonce: number, maxFrameBytes: number): Uint8Array[] {
  if (encodedMessage.length > maxSingleMessageBytes(maxFrameBytes)) {
    throw new RangeError(`message is ${encodedMessage.length} bytes; max ${maxSingleMessageBytes(maxFrameBytes)} until fountain coding lands`);
  }
  return [encodeFrame({ kind: FrameKind.Single, nonce, body: encodedMessage })];
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
  | { kind: 'echo' }
  | { kind: 'rejected'; reason: string };

export class Receiver {
  private seen = new Map<string, number>();

  constructor(private ownNonce: number) {}

  async push(raw: Uint8Array): Promise<ReceiveEvent> {
    const frame = decodeFrame(raw);
    if (!frame) return { kind: 'rejected', reason: 'bad frame (magic, kind, or CRC)' };
    if (frame.nonce === this.ownNonce) return { kind: 'echo' };
    if (frame.kind !== FrameKind.Single) return { kind: 'rejected', reason: 'fountain frames not supported yet' };
    const message = await decodeMessage(frame.body);
    if (!message) return { kind: 'rejected', reason: 'malformed message' };
    const key = `${frame.nonce}:${Array.from(frame.body).join(',')}`;
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);
    return { kind: 'message', message, nonce: frame.nonce, key, count };
  }
}
