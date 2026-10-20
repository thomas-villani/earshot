import { describe, expect, it } from 'vitest';
import { crc16, crc32 } from '../src/framing/crc';
import { decodeFrame, encodeFrame, FRAME_HEADER_BYTES, FrameKind } from '../src/framing/frame';
import { Codec, decodeMessage, detectMessage, encodeMessage, formatWifi, MessageType, parseWifi, type Message } from '../src/framing/message';
import { Rng } from './sim/rng';
import { toVCard } from '../src/ui/vcard';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('crc', () => {
  it('matches standard check values for "123456789"', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
    expect(crc16(utf8('123456789'))).toBe(0x29b1);
  });
});

describe('frame', () => {
  const frame = { kind: FrameKind.Single, nonce: 0xbeef, body: utf8('hello') };

  it('round-trips', () => {
    const bytes = encodeFrame(frame);
    expect(bytes.length).toBe(FRAME_HEADER_BYTES + 5);
    expect(bytes[0]).toBe(0xe1);
    expect(decodeFrame(bytes)).toEqual(frame);
  });

  it('round-trips an empty body and a fountain kind', () => {
    const f = { kind: FrameKind.Fountain, nonce: 0, body: new Uint8Array(0) };
    expect(decodeFrame(encodeFrame(f))).toEqual(f);
  });

  it('rejects every single-bit corruption', () => {
    const bytes = encodeFrame(frame);
    for (let i = 0; i < bytes.length * 8; i++) {
      const bad = bytes.slice();
      bad[i >> 3] ^= 1 << (i & 7);
      expect(decodeFrame(bad)).toBeNull();
    }
  });

  it('rejects truncation, wrong magic, unknown kind, and too-short input', () => {
    const bytes = encodeFrame(frame);
    expect(decodeFrame(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(decodeFrame(new Uint8Array([0xe1, 0, 0, 0, 0]))).toBeNull();
    const kind9 = encodeFrame({ ...frame, kind: 9 as FrameKind });
    expect(decodeFrame(kind9)).toBeNull();
  });
});

describe('message', () => {
  const cases: Message[] = [
    { type: 'text', text: 'hello 👋 earshot' },
    { type: 'url', url: 'https://thomas-villani.github.io/earshot/' },
    { type: 'contact', contact: { n: 'Ada Lovelace', p: '+44 20 7946 0000', e: 'ada@example.com', o: 'Analytical Engines' } },
    { type: 'contact', contact: { n: 'Just A Name' } },
    { type: 'wifi', wifi: { auth: 'WPA', ssid: 'My;Net:"x"', password: 'p\\a,ss' } },
    { type: 'wifi', wifi: { auth: 'nopass', ssid: 'Cafe', password: '', hidden: true } },
    { type: 'prompt', prompt: 'Summarize this', context: 'some context' },
    { type: 'prompt', prompt: 'Just a prompt' },
    { type: 'unknown', code: 0x7f, payload: new Uint8Array([1, 2, 3]) },
  ];

  it.each(cases)('round-trips $type', async (m) => {
    expect(await decodeMessage(await encodeMessage(m))).toEqual(m);
  });

  it('picks the smallest codec: raw for tiny payloads, the text model for English, deflate for repetition', async () => {
    const tiny = await encodeMessage({ type: 'text', text: 'x' });
    expect(tiny[1]).toBe(Codec.None);
    expect(tiny.length).toBe(3);

    const sentence = 'Can you grab some milk on the way home?';
    const enc = await encodeMessage({ type: 'text', text: sentence });
    expect(enc[1]).toBe(Codec.TextModelV1);
    expect(enc.length - 2).toBeLessThan(sentence.length * 0.6);
    expect(await decodeMessage(enc)).toEqual({ type: 'text', text: sentence });

    const repetitive = 'ab'.repeat(300);
    const rep = await encodeMessage({ type: 'text', text: repetitive });
    expect(rep[1]).toBe(Codec.Deflate);
    expect(await decodeMessage(rep)).toEqual({ type: 'text', text: repetitive });
  });

  it('round-trips random Unicode through whichever codec wins', async () => {
    const rng = new Rng(11);
    const alphabet = ['a', 'e', ' ', 'the ', 'Z', '7', '\n', 'é', '中', '🎉', '\x1e', '"'];
    for (let t = 0; t < 40; t++) {
      const text = Array.from({ length: 1 + rng.int(120) }, () => alphabet[rng.int(alphabet.length)]).join('');
      expect(await decodeMessage(await encodeMessage({ type: 'text', text }))).toEqual({ type: 'text', text });
    }
  });

  it('never turns a non-http(s) URL into a URL card', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://exa mple.com']) {
      const bytes = new Uint8Array([MessageType.Url, 0, ...utf8(url)]);
      expect(await decodeMessage(bytes)).toEqual({ type: 'text', text: url });
    }
  });

  it('returns null for malformed payloads', async () => {
    const msg = (code: number, s: string | Uint8Array) => new Uint8Array([code, 0, ...(typeof s === 'string' ? utf8(s) : s)]);
    expect(await decodeMessage(new Uint8Array([1]))).toBeNull();
    expect(await decodeMessage(msg(MessageType.Text, new Uint8Array([0xff, 0xfe])))).toBeNull(); // bad UTF-8
    expect(await decodeMessage(msg(MessageType.Contact, '\x1e555-1234'))).toBeNull(); // no name
    expect(await decodeMessage(msg(MessageType.AssistantPrompt, ''))).toBeNull();
    expect(await decodeMessage(msg(MessageType.Wifi, 'X\x1eHome\x1epw'))).toBeNull(); // unknown auth
    expect(await decodeMessage(msg(MessageType.Wifi, 'W'))).toBeNull(); // no SSID
    expect(await decodeMessage(new Uint8Array([MessageType.Text, Codec.Deflate, 0xde, 0xad, 0xbe, 0xef]))).toBeNull();
    expect(await decodeMessage(new Uint8Array([MessageType.Text, 0x0f, 0x41]))).toBeNull(); // codec from the future
  });

  it('ignores extra fields and strips separators from values', async () => {
    const bytes = new Uint8Array([MessageType.Contact, 0, ...utf8('A\x1e555\x1ea@b.c\x1eOrg\x1e<script>')]);
    expect(await decodeMessage(bytes)).toEqual({ type: 'contact', contact: { n: 'A', p: '555', e: 'a@b.c', o: 'Org' } });
    const sneaky = await encodeMessage({ type: 'contact', contact: { n: 'Eve\x1e+1 666' } });
    expect(await decodeMessage(sneaky)).toEqual({ type: 'contact', contact: { n: 'Eve +1 666' } });
  });

  it('survives garbage in the text-model codec without hanging', async () => {
    const rng = new Rng(12);
    for (let t = 0; t < 50; t++) {
      await decodeMessage(new Uint8Array([MessageType.Text, Codec.TextModelV1, ...rng.bytes(rng.int(30))]));
    }
  });

  it('refuses decompression bombs', async () => {
    const zeros = new Blob([new Uint8Array(200_000)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bomb = new Uint8Array(await new Response(zeros).arrayBuffer());
    expect(bomb.length).toBeLessThan(1000);
    expect(await decodeMessage(new Uint8Array([MessageType.Text, 1, ...bomb]))).toBeNull();
  });
});

describe('wifi string', () => {
  it('formats and parses with escaping', () => {
    const w = { auth: 'WPA' as const, ssid: 'a;b', password: 'c:d\\e' };
    expect(formatWifi(w)).toBe('WIFI:T:WPA;S:a\\;b;P:c\\:d\\\\e;;');
    expect(parseWifi(formatWifi(w))).toEqual(w);
  });

  it('parses real-world variants', () => {
    expect(parseWifi('WIFI:S:Home;T:WPA2;P:secret;;')).toEqual({ auth: 'WPA', ssid: 'Home', password: 'secret' });
    expect(parseWifi('WIFI:S:Open;;')).toEqual({ auth: 'nopass', ssid: 'Open', password: '' });
    expect(parseWifi('WIFI:T:WPA;P:nossid;;')).toBeNull();
  });
});

describe('detectMessage', () => {
  it('detects URLs, Wi-Fi strings, and falls back to text', () => {
    expect(detectMessage('  https://example.com/x?y=1 ')).toEqual({ type: 'url', url: 'https://example.com/x?y=1' });
    expect(detectMessage('WIFI:T:WPA;S:Home;P:pw;;').type).toBe('wifi');
    expect(detectMessage('check https://example.com')).toEqual({ type: 'text', text: 'check https://example.com' });
    expect(detectMessage('javascript:alert(1)').type).toBe('text');
  });
});

describe('vcard', () => {
  it('escapes values and strips line breaks so a field cannot inject vCard properties', () => {
    const v = toVCard({ n: 'Eve\r\nTEL:666', p: '+1 555', o: 'A;B,C' });
    expect(v).toContain('FN:Eve TEL:666\r\n');
    expect(v).toContain('TEL;TYPE=CELL:+1 555\r\n');
    expect(v).toContain('ORG:A\\;B\\,C\r\n');
    expect(v.match(/^TEL/gm)).toHaveLength(1);
  });
});
