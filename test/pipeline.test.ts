import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameKind } from '../src/framing/frame';
import { encodeMessage } from '../src/framing/message';
import { maxBlockBytes, maxSingleMessageBytes, Receiver, Transmission, type ReceiveEvent } from '../src/framing/pipeline';
import { Rng } from './sim/rng';

/** A Receiver whose clock the test controls. */
function receiver(ownNonce = 0x9999) {
  let t = 0;
  const rx = new Receiver(ownNonce, () => t);
  return { rx, advance: (ms: number) => (t += ms) };
}

describe('single-frame messages', () => {
  it('delivers a message and ignores its own echo', async () => {
    const tx = new Transmission(await encodeMessage({ type: 'text', text: 'hello' }), 0x1234, 140, 1);
    expect(tx.single).toBe(true);
    const [frame] = tx.nextRound();
    const { rx } = receiver();
    expect(await rx.push(frame)).toMatchObject({ kind: 'message', message: { type: 'text', text: 'hello' }, nonce: 0x1234, count: 1 });
    expect(await new Receiver(0x1234).push(frame)).toEqual({ kind: 'echo' });
  });

  it('sends the same frame on every lane, and counts copies heard together once', async () => {
    const tx = new Transmission(await encodeMessage({ type: 'text', text: 'hi' }), 5, 140, 2);
    const [a, b] = tx.nextRound();
    expect(a).toEqual(b);
    const { rx, advance } = receiver();
    expect(await rx.push(a)).toMatchObject({ kind: 'message', count: 1 });
    expect(await rx.push(b)).toMatchObject({ kind: 'duplicate' });
    advance(5000);
    expect(await rx.push(a)).toMatchObject({ kind: 'message', count: 2 });
  });

  it('treats the same text from two senders as distinct', async () => {
    const bytes = await encodeMessage({ type: 'text', text: 'hi' });
    const { rx } = receiver(1);
    await rx.push(new Transmission(bytes, 10, 140, 1).nextRound()[0]);
    expect(await rx.push(new Transmission(bytes, 11, 140, 1).nextRound()[0])).toMatchObject({ kind: 'message', count: 1 });
  });

  it('rejects corrupt frames and malformed messages', async () => {
    const { rx } = receiver(1);
    const [frame] = new Transmission(await encodeMessage({ type: 'text', text: 'x' }), 2, 140, 1).nextRound();
    frame[frame.length - 1] ^= 0x40;
    expect(await rx.push(frame)).toMatchObject({ kind: 'rejected' });
    expect(await rx.push(encodeFrame({ kind: FrameKind.Single, nonce: 2, body: new Uint8Array([1]) }))).toMatchObject({
      kind: 'rejected',
      reason: 'malformed message',
    });
  });

  it('uses SINGLE up to 134 bytes and fountain beyond', () => {
    expect(maxSingleMessageBytes(140)).toBe(134);
    expect(maxBlockBytes(140)).toBe(129);
    expect(new Transmission(new Uint8Array(134), 1, 140, 1).single).toBe(true);
    expect(new Transmission(new Uint8Array(135), 1, 140, 1).single).toBe(false);
  });
});

describe('fountain messages', () => {
  const longText = (n: number) => new Rng(n).bytes(n).reduce((s, b) => s + String.fromCharCode(97 + (b % 26)), '');

  async function deliver(text: string, lanes: number, keep: (frameIndex: number) => boolean) {
    const tx = new Transmission(await encodeMessage({ type: 'text', text }), 0x4242, 140, lanes);
    const { rx } = receiver();
    const events: ReceiveEvent[] = [];
    let sent = 0;
    for (let round = 0; round < 200; round++) {
      for (const f of tx.nextRound()) {
        if (!keep(sent++)) continue;
        const ev = await rx.push(f);
        events.push(ev);
        if (ev.kind === 'message') return { tx, events, sent };
      }
    }
    throw new Error('never decoded');
  }

  it('decodes a long message from k frames with progress along the way', async () => {
    const text = longText(600);
    const { tx, events } = await deliver(text, 1, () => true);
    expect(tx.single).toBe(false);
    expect(events.length).toBe(tx.k);
    expect(events.slice(0, -1).every((e) => e.kind === 'progress')).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'progress', have: 1, need: tx.k });
    expect(events.at(-1)).toMatchObject({ kind: 'message', message: { type: 'text', text } });
  });

  it('decodes on two lanes in half the rounds', async () => {
    const text = longText(1000);
    const { tx, sent } = await deliver(text, 2, () => true);
    expect(sent).toBeLessThanOrEqual(tx.k + 1);
    expect(tx.onceRounds).toBe(Math.ceil((tx.k + Math.ceil(tx.k / 4)) / 2));
  });

  it('recovers when one lane is lost entirely (e.g. no ultrasound on this phone)', async () => {
    const text = longText(800);
    const { events } = await deliver(text, 2, (i) => i % 2 === 0);
    expect(events.at(-1)).toMatchObject({ kind: 'message', message: { text } });
  });

  it('lets a late joiner decode from repair frames only', async () => {
    const text = longText(700);
    const { events } = await deliver(text, 1, (i) => i >= 20);
    expect(events.at(-1)).toMatchObject({ kind: 'message', message: { text } });
  });

  it('reports duplicates after completion', async () => {
    const tx = new Transmission(await encodeMessage({ type: 'text', text: longText(300) }), 7, 140, 1);
    const { rx } = receiver();
    let ev: ReceiveEvent | undefined;
    for (let i = 0; i < tx.k; i++) ev = await rx.push(tx.nextRound()[0]);
    expect(ev?.kind).toBe('message');
    expect(await rx.push(tx.nextRound()[0])).toMatchObject({ kind: 'duplicate' });
  });
});
