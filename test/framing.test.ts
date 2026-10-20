import { describe, expect, it } from 'vitest';
import { crc16, crc32 } from '../src/framing/crc';
import { decodeFrame, encodeFrame, FRAME_HEADER_BYTES, FrameKind } from '../src/framing/frame';
import { decodeMessage, detectMessage, encodeMessage, formatWifi, MessageType, parseWifi, type Message } from '../src/framing/message';
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

  it('keeps short text uncompressed and compresses repetitive text', async () => {
    const short = await encodeMessage({ type: 'text', text: 'hi there' });
    expect(short[1]).toBe(0);
    expect(short.length).toBe(2 + 8);
    const long = 'the quick brown fox jumps over the lazy dog. '.repeat(6);
    const enc = await encodeMessage({ type: 'text', text: long });
    expect(enc[1]).toBe(1);
    expect(enc.length).toBeLessThan(long.length);
    expect(await decodeMessage(enc)).toEqual({ type: 'text', text: long });
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
    expect(await decodeMessage(msg(MessageType.Contact, '{"n":'))).toBeNull();
    expect(await decodeMessage(msg(MessageType.Contact, '{"p":"123"}'))).toBeNull();
    expect(await decodeMessage(msg(MessageType.AssistantPrompt, '[1,2]'))).toBeNull();
    expect(await decodeMessage(msg(MessageType.Wifi, 'not wifi'))).toBeNull();
    expect(await decodeMessage(new Uint8Array([MessageType.Text, 1, 0xde, 0xad, 0xbe, 0xef]))).toBeNull(); // corrupt deflate
  });

  it('drops unexpected fields from contacts', async () => {
    const bytes = new Uint8Array([MessageType.Contact, 0, ...utf8('{"n":"A","p":5,"x":"<script>"}')]);
    expect(await decodeMessage(bytes)).toEqual({ type: 'contact', contact: { n: 'A' } });
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
