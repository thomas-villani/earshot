// The acoustic handshake: compact offer/answer as typed messages, and the verification code.
// See SPEC.md "Handshake flow".
import { FOUNTAIN_HEADER_BYTES } from '../fountain/fountain';
import { FRAME_HEADER_BYTES } from '../framing/frame';
import { Codec, MessageType, type Message } from '../framing/message';

export type HandshakeKind = 'offer' | 'answer';

/** Compact SDP bytes as a message. Sent raw: SDP is mostly random bytes, so no codec helps. */
export function encodeHandshake(kind: HandshakeKind, compact: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + compact.length);
  out[0] = kind === 'offer' ? MessageType.RtcOffer : MessageType.RtcAnswer;
  out[1] = Codec.None;
  out.set(compact, 2);
  return out;
}

/** The compact SDP bytes, if this decoded message is an offer or answer. Not yet validated. */
export function parseHandshake(msg: Message): { kind: HandshakeKind; bytes: Uint8Array } | null {
  if (msg.type !== 'unknown') return null;
  if (msg.code === MessageType.RtcOffer) return { kind: 'offer', bytes: msg.payload };
  if (msg.code === MessageType.RtcAnswer) return { kind: 'answer', bytes: msg.payload };
  return null;
}

/** fountain.ts prefixes the message with u16 length + crc32 before splitting it into blocks. */
const SOURCE_HEADER_BYTES = 6;

/**
 * Frame size that splits a message into exactly one fountain block per lane, so a dual-band round
 * carries the whole message in about half the airtime of one full frame (5.3 s instead of 8.5 s
 * for a 122 B offer on Fast). One lane only: a full SINGLE frame.
 */
export function splitFrameBytes(messageBytes: number, lanes: number, maxFrameBytes: number): number {
  if (lanes <= 1) return maxFrameBytes;
  return FRAME_HEADER_BYTES + FOUNTAIN_HEADER_BYTES + Math.ceil((messageBytes + SOURCE_HEADER_BYTES) / lanes);
}

/**
 * Four digits both screens show, from the two DTLS fingerprints. A third device that slipped in its
 * own answer would have a different fingerprint, so the codes would not match.
 */
export async function verificationCode(offerFingerprint: Uint8Array, answerFingerprint: Uint8Array): Promise<string> {
  const both = new Uint8Array(offerFingerprint.length + answerFingerprint.length);
  both.set(offerFingerprint);
  both.set(answerFingerprint, offerFingerprint.length);
  const hash = new DataView(await crypto.subtle.digest('SHA-256', both));
  return String(hash.getUint32(0) % 10000).padStart(4, '0');
}
