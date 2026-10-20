import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameKind } from '../src/framing/frame';
import { encodeMessage } from '../src/framing/message';
import { maxSingleMessageBytes, Receiver, toFrames } from '../src/framing/pipeline';

describe('pipeline', () => {
  it('delivers a message, counts repeats, and ignores its own echo', async () => {
    const bytes = await encodeMessage({ type: 'text', text: 'hello' });
    const [frame] = toFrames(bytes, 0x1234, 140);
    const rx = new Receiver(0x9999);
    expect(await rx.push(frame)).toMatchObject({ kind: 'message', message: { type: 'text', text: 'hello' }, nonce: 0x1234, count: 1 });
    expect(await rx.push(frame)).toMatchObject({ kind: 'message', count: 2 });
    expect(await new Receiver(0x1234).push(frame)).toEqual({ kind: 'echo' });
  });

  it('treats the same text from two senders as distinct', async () => {
    const bytes = await encodeMessage({ type: 'text', text: 'hi' });
    const rx = new Receiver(1);
    await rx.push(toFrames(bytes, 10, 140)[0]);
    expect(await rx.push(toFrames(bytes, 11, 140)[0])).toMatchObject({ count: 1 });
  });

  it('rejects corrupt frames, malformed messages, and (for now) fountain frames', async () => {
    const rx = new Receiver(1);
    const [frame] = toFrames(await encodeMessage({ type: 'text', text: 'x' }), 2, 140);
    frame[frame.length - 1] ^= 0x40;
    expect(await rx.push(frame)).toMatchObject({ kind: 'rejected' });
    expect(await rx.push(encodeFrame({ kind: FrameKind.Single, nonce: 2, body: new Uint8Array([1]) }))).toMatchObject({ kind: 'rejected', reason: 'malformed message' });
    expect(await rx.push(encodeFrame({ kind: FrameKind.Fountain, nonce: 2, body: new Uint8Array(8) }))).toMatchObject({ kind: 'rejected' });
  });

  it('enforces the single-frame size limit', () => {
    expect(maxSingleMessageBytes(140)).toBe(134);
    expect(toFrames(new Uint8Array(134), 1, 140)[0].length).toBe(140);
    expect(() => toFrames(new Uint8Array(135), 1, 140)).toThrow(RangeError);
  });
});
