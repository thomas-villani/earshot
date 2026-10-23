import { describe, expect, it } from 'vitest';
import { decodeMessage } from '../src/framing/message';
import { maxSingleMessageBytes, Receiver, Transmission } from '../src/framing/pipeline';
import { encodeHandshake, parseHandshake, splitFrameBytes, verificationCode } from '../src/rtc/handshake';
import { decodeCompactSdp, encodeCompactSdp, ONE_FRAME_BYTES, parseSdp, selectCandidates } from '../src/rtc/sdp-compact';
import { chromeOfferWithMic } from './fixtures/sdp';

const compact = encodeCompactSdp(selectCandidates(parseSdp(chromeOfferWithMic, 0x1234), ONE_FRAME_BYTES));

describe('handshake messages', () => {
  it('round-trips an offer and an answer through the message layer', async () => {
    for (const kind of ['offer', 'answer'] as const) {
      const msg = await decodeMessage(encodeHandshake(kind, compact));
      const parsed = parseHandshake(msg!);
      expect(parsed?.kind).toBe(kind);
      expect(decodeCompactSdp(parsed!.bytes)?.sessionId).toBe(0x1234);
    }
  });

  it('a full-budget offer fits one SINGLE frame', () => {
    expect(2 + ONE_FRAME_BYTES).toBe(maxSingleMessageBytes(140));
  });

  it('ignores other message types', () => {
    expect(parseHandshake({ type: 'text', text: 'hi' })).toBeNull();
    expect(parseHandshake({ type: 'unknown', code: 0x20, payload: new Uint8Array(3) })).toBeNull();
  });
});

describe('splitting across lanes', () => {
  it('puts one block on each lane, and the first round alone decodes', async () => {
    const bytes = encodeHandshake('offer', compact);
    for (const lanes of [1, 2]) {
      const tx = new Transmission(bytes, 7, splitFrameBytes(bytes.length, lanes, 140), lanes);
      expect(tx.k).toBe(lanes);
      const frames = tx.nextRound();
      expect(frames).toHaveLength(lanes);
      if (lanes === 2) expect(Math.max(...frames.map((f) => f.length))).toBeLessThanOrEqual(76);
      const rx = new Receiver(8);
      const events = [];
      for (const f of frames) events.push(await rx.push(f));
      const done = events.find((e) => e.kind === 'message');
      expect(done && done.kind === 'message' && parseHandshake(done.message)?.kind).toBe('offer');
    }
  });

  it('a later round tops up a receiver that missed one lane', async () => {
    const bytes = encodeHandshake('answer', compact);
    const tx = new Transmission(bytes, 7, splitFrameBytes(bytes.length, 2, 140), 2);
    const rx = new Receiver(8);
    await rx.push(tx.nextRound()[0]); // second lane lost
    let got = false;
    for (let round = 0; round < 6 && !got; round++) {
      for (const f of tx.nextRound()) if ((await rx.push(f)).kind === 'message') got = true;
    }
    expect(got).toBe(true);
  });
});

describe('verificationCode', () => {
  const a = new Uint8Array(32).fill(1);
  const b = new Uint8Array(32).fill(2);

  it('is four digits, the same on both sides, and order-sensitive', async () => {
    const code = await verificationCode(a, b);
    expect(code).toMatch(/^\d{4}$/);
    expect(await verificationCode(a, b)).toBe(code);
    expect(await verificationCode(b, a)).not.toBe(code);
  });

  it('changes when either fingerprint does', async () => {
    const c = b.slice();
    c[31] = 3;
    expect(await verificationCode(a, c)).not.toBe(await verificationCode(a, b));
  });
});
