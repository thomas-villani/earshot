import { describe, expect, it } from 'vitest';
import {
  buildSdp,
  decodeCompactSdp,
  encodeCompactSdp,
  encodedSize,
  formatIpv6,
  ONE_FRAME_BYTES,
  packIceChars,
  parseCandidate,
  parseIpv6,
  parseSdp,
  selectCandidates,
  unpackIceChars,
} from '../src/rtc/sdp-compact';
import { chromeAnswerMdns, chromeOfferMdns, chromeOfferWithMic, firefoxStyleOffer } from './fixtures/sdp';
import { Rng } from './sim/rng';

const roundTrip = (sdp: string, id = 0xdeadbeef) => {
  const c = selectCandidates(parseSdp(sdp, id), ONE_FRAME_BYTES);
  const bytes = encodeCompactSdp(c);
  return { c, bytes, back: decodeCompactSdp(bytes)! };
};

describe('ice-char packing', () => {
  it('round-trips every length up to 40 at 6 bits per char', () => {
    const rng = new Rng(1);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let n = 1; n <= 40; n++) {
      const s = Array.from({ length: n }, () => alphabet[Math.floor(rng.next() * 64)]).join('');
      const packed = packIceChars(s);
      expect(packed.length).toBe(Math.ceil((n * 6) / 8));
      expect(unpackIceChars(packed, n)).toBe(s);
    }
  });

  it('rejects characters outside the ice-char set', () => {
    expect(() => packIceChars('ab-c')).toThrow();
    expect(() => packIceChars('')).toThrow();
  });
});

describe('IPv6 text form', () => {
  it.each([
    ['2001:db8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::', '::'],
    ['::1', '::1'],
    ['fe80::', 'fe80::'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'], // first of two equal runs
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'], // a single zero group is not compressed
    ['2001:DB8:C880:DBE0:CCB8:A41B:B8A0:7B17', '2001:db8:c880:dbe0:ccb8:a41b:b8a0:7b17'],
  ])('%s → %s', (input, canonical) => {
    expect(formatIpv6(parseIpv6(input)!)).toBe(canonical);
  });

  it.each(['1::2::3', '1:2:3', '1:2:3:4:5:6:7:8:9', '12345::', 'g::1', '1.2.3.4'])('rejects %s', (s) => {
    expect(parseIpv6(s)).toBeNull();
  });
});

describe('parseCandidate', () => {
  it('keeps UDP host and srflx, drops TCP, relay, and other components', () => {
    expect(parseCandidate('candidate:1 1 udp 2122260223 192.168.1.50 58033 typ host generation 0')).toEqual({
      type: 'host',
      address: '192.168.1.50',
      port: 58033,
    });
    expect(parseCandidate('candidate:1 1 UDP 1686052863 203.0.113.9 50001 typ srflx raddr 0.0.0.0 rport 0')?.type).toBe('srflx');
    expect(parseCandidate('candidate:1 1 tcp 1518280447 192.168.1.50 9 typ host tcptype active')).toBeNull();
    expect(parseCandidate('candidate:1 1 udp 41885439 203.0.113.9 3478 typ relay raddr 0.0.0.0 rport 0')).toBeNull();
    expect(parseCandidate('candidate:1 2 udp 2122260222 192.168.1.50 58034 typ host')).toBeNull();
    expect(parseCandidate('candidate:1 1 udp 2122260223 some-host.example 58033 typ host')).toBeNull();
  });
});

describe('compact SDP', () => {
  it('round-trips a Chrome offer with mDNS host candidates in one frame', () => {
    const { c, bytes, back } = roundTrip(chromeOfferMdns);
    expect(bytes.length).toBeLessThanOrEqual(ONE_FRAME_BYTES);
    expect(back).toEqual(c);
    expect(back.setup).toBe('actpass');
    expect(back.ufrag).toBe('r6HL');
    expect(back.pwd).toBe('SPCjCeFfMHR4lg+icm4IdmRy');
    // budget-limited: public IPv4 first, then as many mDNS/IPv6 as fit
    expect(back.candidates[0]).toEqual({ type: 'srflx', address: '203.0.113.7', port: 61001 });
    expect(back.candidates.map((x) => x.address)).toContain('77471497-2ff8-4b82-aabc-2e67252fea82.local');
  });

  it('round-trips a Chrome answer', () => {
    const { bytes, back } = roundTrip(chromeAnswerMdns, 7);
    expect(back.setup).toBe('active');
    expect(back.sessionId).toBe(7);
    expect(back.candidates).toHaveLength(2);
    expect(bytes.length).toBe(61 + 2 * 19);
  });

  it('prefers LAN IPv4, then public IPv4, then IPv6, and skips TCP (mic-permission offer)', () => {
    const { bytes, back } = roundTrip(chromeOfferWithMic);
    expect(bytes.length).toBeLessThanOrEqual(ONE_FRAME_BYTES);
    const addrs = back.candidates.map((x) => `${x.type} ${x.address}`);
    expect(addrs.slice(0, 3)).toEqual(['host 172.20.0.1', 'host 192.168.1.50', 'srflx 203.0.113.7']);
    expect(addrs.slice(3).every((a) => a.startsWith('host 2001:db8'))).toBe(true);
    expect(addrs.length).toBe(5); // 61 base + 3×7 + 2×19 = 120; a third IPv6 would need 139
  });

  it('handles Firefox-style credentials and attribute order', () => {
    const { back } = roundTrip(firefoxStyleOffer);
    expect(back.ufrag).toBe('9a8b7c6d');
    expect(back.pwd).toBe('2f1d6c1e0b0a4e8f9c7d6b5a4e3f2a1b');
    expect(back.candidates).toEqual([
      { type: 'host', address: '192.168.1.60', port: 50001 },
      { type: 'srflx', address: '203.0.113.9', port: 50001 },
    ]);
  });

  it('honors a tight budget and drops duplicates', () => {
    const c = parseSdp(chromeOfferWithMic, 1);
    c.candidates.push({ ...c.candidates[1] });
    const small = selectCandidates(c, 80);
    expect(encodedSize(small)).toBeLessThanOrEqual(80);
    expect(small.candidates.map((x) => x.address)).toEqual(['172.20.0.1', '192.168.1.50']);
    expect(selectCandidates(c, 61).candidates).toEqual([]);
  });

  it('can carry no candidates at all (answerer found as peer-reflexive)', () => {
    const c = { ...parseSdp(chromeAnswerMdns, 3), candidates: [] };
    const bytes = encodeCompactSdp(c);
    expect(bytes.length).toBe(61);
    expect(decodeCompactSdp(bytes)).toEqual(c);
  });

  it('rejects SDP it cannot represent', () => {
    expect(() => parseSdp(chromeOfferMdns.replace('sha-256', 'sha-1'), 1)).toThrow(/algorithm/);
    expect(() => parseSdp(chromeOfferMdns.replace(/a=ice-pwd:.*\r\n/, ''), 1)).toThrow();
  });
});

describe('decodeCompactSdp on untrusted bytes', () => {
  const good = roundTrip(chromeOfferWithMic).bytes;

  it('returns null for every truncation and for trailing junk', () => {
    for (let n = 0; n < good.length; n++) expect(decodeCompactSdp(good.subarray(0, n))).toBeNull();
    expect(decodeCompactSdp(new Uint8Array([...good, 0]))).toBeNull();
  });

  it('returns null for a wrong version, setup, or candidate kind', () => {
    const bad = (i: number, v: number) => {
      const b = good.slice();
      b[i] = v;
      return decodeCompactSdp(b);
    };
    expect(bad(0, 0x20)).toBeNull();
    expect(bad(0, 0x13)).toBeNull();
    const firstKind = good.length - (7 * 3 + 19 * 2); // count byte is just before this
    expect(bad(firstKind, 9)).toBeNull();
  });

  it('never throws on random bytes', () => {
    const rng = new Rng(2);
    for (let t = 0; t < 2000; t++) {
      const b = new Uint8Array(Math.floor(rng.next() * 140));
      for (let i = 0; i < b.length; i++) b[i] = Math.floor(rng.next() * 256);
      if (t % 2) b[0] = 0x10; // valid header half the time, to get deeper
      expect(() => decodeCompactSdp(b)).not.toThrow();
    }
  });
});

describe('buildSdp', () => {
  it('rebuilds an SDP that compacts back to the same thing', () => {
    for (const sdp of [chromeOfferMdns, chromeAnswerMdns, chromeOfferWithMic, firefoxStyleOffer]) {
      const { back } = roundTrip(sdp, 42);
      const rebuilt = buildSdp(back);
      expect(parseSdp(rebuilt, 42)).toEqual(back);
      expect(rebuilt).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
      expect(rebuilt.endsWith('\r\n')).toBe(true);
    }
  });

  it('gives candidates decreasing priority in the order carried, host above srflx', () => {
    const { back } = roundTrip(chromeOfferWithMic);
    const priorities = buildSdp(back)
      .split('\r\n')
      .filter((l) => l.startsWith('a=candidate'))
      .map((l) => Number(l.split(' ')[3]));
    const hosts = priorities.filter((_, i) => back.candidates[i].type === 'host');
    const srflx = priorities.filter((_, i) => back.candidates[i].type === 'srflx');
    expect(Math.min(...hosts)).toBeGreaterThan(Math.max(...srflx));
    expect(hosts).toEqual([...hosts].sort((a, b) => b - a));
  });
});
