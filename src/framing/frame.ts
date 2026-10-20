// Frame = one ggwave transmission. See SPEC.md "Frames".
//   [magic+version: u8 = 0xE1][kind: u8][nonce: u16][crc16: u16][body...]
// The CRC covers every byte except the CRC field itself.
import { crc16 } from './crc';

export const FRAME_MAGIC = 0xe1;
export const FRAME_HEADER_BYTES = 6;

export const FrameKind = { Single: 0, Fountain: 1 } as const;
export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

export interface Frame {
  kind: FrameKind;
  /** Random per sender session; used for self-echo filtering and dedupe. */
  nonce: number;
  body: Uint8Array;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.body.length);
  out[0] = FRAME_MAGIC;
  out[1] = frame.kind;
  out[2] = frame.nonce >> 8;
  out[3] = frame.nonce & 0xff;
  out.set(frame.body, FRAME_HEADER_BYTES);
  const crc = crc16(withoutCrc(out));
  out[4] = crc >> 8;
  out[5] = crc & 0xff;
  return out;
}

/** Returns null for anything that isn't a well-formed v1 frame with a valid CRC. */
export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < FRAME_HEADER_BYTES || bytes[0] !== FRAME_MAGIC) return null;
  const kind = bytes[1];
  if (kind !== FrameKind.Single && kind !== FrameKind.Fountain) return null;
  if (((bytes[4] << 8) | bytes[5]) !== crc16(withoutCrc(bytes))) return null;
  return { kind: kind as FrameKind, nonce: (bytes[2] << 8) | bytes[3], body: bytes.slice(FRAME_HEADER_BYTES) };
}

function withoutCrc(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length - 2);
  out.set(frame.subarray(0, 4));
  out.set(frame.subarray(FRAME_HEADER_BYTES), 4);
  return out;
}
