// Compact SDP for data-channel-only sessions. See SPEC.md "Compact SDP".
//
// A full SDP is ~1 KB, but for one data channel only a few fields matter. We parse those out of a
// gathered (non-trickle) description, pack them into ~60–130 bytes, and rebuild a complete SDP from
// a fixed template on the other side.
//
//   [ver/setup: u8]       high nibble = format version (1), low nibble = setup (0 actpass, 1 active, 2 passive)
//   [sessionId: u32]
//   [ufrag: n u8][ceil(6n/8) bytes]   ice-chars are exactly the base64 alphabet, so 6 bits each
//   [pwd:   n u8][ceil(6n/8) bytes]
//   [fingerprint: 32 bytes]           SHA-256 DTLS fingerprint
//   [candCount: u8]
//   per candidate: [kind: u8][address: 4 | 16 bytes][port: u16]
//
// Decoded blobs came from the air: decodeCompactSdp validates everything and returns null on junk.

export type Setup = 'actpass' | 'active' | 'passive';
export type CandidateType = 'host' | 'srflx';

export interface CompactCandidate {
  type: CandidateType;
  /** IPv4, IPv6, or an mDNS name `<uuid>.local` (Chrome/Safari hide host IPs this way without media permission). */
  address: string;
  port: number;
}

export interface CompactSdp {
  sessionId: number;
  setup: Setup;
  ufrag: string;
  pwd: string;
  fingerprint: Uint8Array;
  candidates: CompactCandidate[];
}

/** Budget that fits one SINGLE frame: 140-byte ggwave frame − 6 frame header − 2 message header. */
export const ONE_FRAME_BYTES = 132;

const VERSION = 1;
const SETUPS: readonly Setup[] = ['actpass', 'active', 'passive'];
const ICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const FINGERPRINT_BYTES = 32;

const Kind = { HostV4: 0, HostV6: 1, HostMdns: 2, SrflxV4: 3, SrflxV6: 4 } as const;
const ADDRESS_BYTES = [4, 16, 16, 4, 16];

// ---- parsing a browser's SDP ----

/** Extract the fields we carry from a gathered SDP. Throws if it isn't a session we can compact. */
export function parseSdp(sdp: string, sessionId: number): CompactSdp {
  const lines = sdp.split(/\r?\n/);
  const attr = (name: string) => lines.find((l) => l.startsWith(`a=${name}:`))?.slice(name.length + 3).trim();
  const ufrag = attr('ice-ufrag');
  const pwd = attr('ice-pwd');
  const fp = attr('fingerprint');
  const setup = attr('setup') as Setup | undefined;
  if (!ufrag || !pwd || !fp || !setup) throw new Error('SDP is missing ICE credentials, fingerprint, or setup');
  if (!SETUPS.includes(setup)) throw new Error(`unsupported setup ${setup}`);
  const [algo, hex] = fp.split(/\s+/);
  if (algo.toLowerCase() !== 'sha-256') throw new Error(`unsupported fingerprint algorithm ${algo}`);
  const fingerprint = new Uint8Array(hex.split(':').map((h) => parseInt(h, 16)));
  if (fingerprint.length !== FINGERPRINT_BYTES || fingerprint.some(Number.isNaN)) throw new Error('bad fingerprint');
  const candidates = lines.flatMap((l) => {
    const c = l.startsWith('a=candidate:') ? parseCandidate(l.slice(2)) : null;
    return c ? [c] : [];
  });
  return { sessionId: sessionId >>> 0, setup, ufrag, pwd, fingerprint, candidates };
}

/** Parse one `candidate:` line; null for anything we don't carry (TCP, relay, prflx, odd addresses). */
export function parseCandidate(line: string): CompactCandidate | null {
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
  const f = line.replace(/^candidate:/, '').split(/\s+/);
  if (f.length < 8 || f[1] !== '1' || f[2].toLowerCase() !== 'udp' || f[6] !== 'typ') return null;
  const type = f[7];
  if (type !== 'host' && type !== 'srflx') return null;
  const port = Number(f[5]);
  if (!Number.isInteger(port) || port < 1 || port > 0xffff) return null;
  const c = { type, address: f[4].toLowerCase(), port } as CompactCandidate;
  return kindOf(c) === null ? null : c;
}

function kindOf(c: CompactCandidate): number | null {
  if (parseIpv4(c.address)) return c.type === 'host' ? Kind.HostV4 : Kind.SrflxV4;
  if (parseIpv6(c.address)) return c.type === 'host' ? Kind.HostV6 : Kind.SrflxV6;
  if (c.type === 'host' && parseMdns(c.address)) return Kind.HostMdns;
  return null;
}

// ---- choosing candidates to fit the frame ----

/** Smaller and more useful first: LAN IPv4, then public IPv4, then IPv6 / mDNS. */
const RANK = [0, 2, 3, 1, 4];

/**
 * Pick candidates to carry, best first, so that the encoded blob fits in `maxBytes`. Within a kind,
 * the browser's own order (its priority) is kept. Duplicates (same address and port) are dropped.
 */
export function selectCandidates(c: CompactSdp, maxBytes: number): CompactSdp {
  let budget = maxBytes - encodedSize({ ...c, candidates: [] });
  const seen = new Set<string>();
  const ranked = c.candidates
    .map((cand, i) => ({ cand, i, kind: kindOf(cand)! }))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.i - b.i);
  const picked: CompactCandidate[] = [];
  for (const { cand, kind } of ranked) {
    const key = `${cand.address} ${cand.port}`;
    const size = 3 + ADDRESS_BYTES[kind];
    if (seen.has(key) || size > budget || picked.length === 255) continue;
    seen.add(key);
    picked.push(cand);
    budget -= size;
  }
  return { ...c, candidates: picked };
}

// ---- binary ----

export function encodedSize(c: CompactSdp): number {
  return (
    1 + 4 + 1 + Math.ceil((c.ufrag.length * 6) / 8) + 1 + Math.ceil((c.pwd.length * 6) / 8) + FINGERPRINT_BYTES + 1 +
    c.candidates.reduce((n, cand) => n + 3 + ADDRESS_BYTES[kindOf(cand)!], 0)
  );
}

export function encodeCompactSdp(c: CompactSdp): Uint8Array {
  if (c.fingerprint.length !== FINGERPRINT_BYTES) throw new Error('fingerprint must be 32 bytes');
  if (c.candidates.length > 255) throw new Error('too many candidates');
  const out = new Uint8Array(encodedSize(c));
  const view = new DataView(out.buffer);
  let o = 0;
  out[o++] = (VERSION << 4) | SETUPS.indexOf(c.setup);
  view.setUint32(o, c.sessionId >>> 0);
  o += 4;
  for (const s of [c.ufrag, c.pwd]) {
    const packed = packIceChars(s);
    out[o++] = s.length;
    out.set(packed, o);
    o += packed.length;
  }
  out.set(c.fingerprint, o);
  o += FINGERPRINT_BYTES;
  out[o++] = c.candidates.length;
  for (const cand of c.candidates) {
    const kind = kindOf(cand);
    if (kind === null) throw new Error(`can't encode candidate ${cand.address}`);
    out[o++] = kind;
    const addr = kind === Kind.HostV4 || kind === Kind.SrflxV4 ? parseIpv4(cand.address)! : kind === Kind.HostMdns ? parseMdns(cand.address)! : parseIpv6(cand.address)!;
    out.set(addr, o);
    o += addr.length;
    view.setUint16(o, cand.port);
    o += 2;
  }
  return out;
}

export function decodeCompactSdp(bytes: Uint8Array): CompactSdp | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number) => o + n <= bytes.length;
  if (!need(5)) return null;
  const head = bytes[o++];
  if (head >> 4 !== VERSION || (head & 0x0f) >= SETUPS.length) return null;
  const setup = SETUPS[head & 0x0f];
  const sessionId = view.getUint32(o);
  o += 4;
  const creds: string[] = [];
  for (let i = 0; i < 2; i++) {
    if (!need(1)) return null;
    const n = bytes[o++];
    const len = Math.ceil((n * 6) / 8);
    if (n === 0 || !need(len)) return null;
    creds.push(unpackIceChars(bytes.subarray(o, o + len), n));
    o += len;
  }
  if (!need(FINGERPRINT_BYTES + 1)) return null;
  const fingerprint = bytes.slice(o, o + FINGERPRINT_BYTES);
  o += FINGERPRINT_BYTES;
  const count = bytes[o++];
  const candidates: CompactCandidate[] = [];
  for (let i = 0; i < count; i++) {
    if (!need(1)) return null;
    const kind = bytes[o++];
    if (kind >= ADDRESS_BYTES.length || !need(ADDRESS_BYTES[kind] + 2)) return null;
    const addr = bytes.subarray(o, o + ADDRESS_BYTES[kind]);
    o += addr.length;
    const port = view.getUint16(o);
    o += 2;
    if (port === 0) return null;
    const address = kind === Kind.HostV4 || kind === Kind.SrflxV4 ? formatIpv4(addr) : kind === Kind.HostMdns ? formatMdns(addr) : formatIpv6(addr);
    candidates.push({ type: kind === Kind.SrflxV4 || kind === Kind.SrflxV6 ? 'srflx' : 'host', address, port });
  }
  if (o !== bytes.length) return null;
  return { sessionId, setup, ufrag: creds[0], pwd: creds[1], fingerprint, candidates };
}

// ---- rebuilding a full SDP ----

/** A complete data-channel SDP that Chrome, Safari, and Firefox accept as a remote description. */
export function buildSdp(c: CompactSdp): string {
  const hex = Array.from(c.fingerprint, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const candidates = c.candidates.map((cand, i) => {
    // RFC 8445 priority: type preference, then the order we were given as local preference.
    const priority = (cand.type === 'host' ? 126 : 100) * 2 ** 24 + (65535 - i) * 2 ** 8 + 255;
    const raddr = cand.type === 'srflx' ? ` raddr ${parseIpv4(cand.address) ? '0.0.0.0' : '::'} rport 0` : '';
    return `a=candidate:${i + 1} 1 udp ${priority} ${cand.address} ${cand.port} typ ${cand.type}${raddr}`;
  });
  return [
    'v=0',
    `o=- ${c.sessionId} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...candidates,
    `a=ice-ufrag:${c.ufrag}`,
    `a=ice-pwd:${c.pwd}`,
    `a=fingerprint:sha-256 ${hex}`,
    `a=setup:${c.setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}

// ---- field packing ----

export function packIceChars(s: string): Uint8Array {
  if (s.length === 0 || s.length > 255) throw new Error('ICE credential must be 1–255 chars');
  const out = new Uint8Array(Math.ceil((s.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of s) {
    const v = ICE_CHARS.indexOf(ch);
    if (v < 0) throw new Error(`not an ice-char: ${ch}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0) out[o] = (acc << (8 - bits)) & 0xff;
  return out;
}

export function unpackIceChars(bytes: Uint8Array, n: number): string {
  let s = '';
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (s.length < n) {
    if (bits < 6) {
      acc = ((acc << 8) | bytes[i++]) & 0xffff;
      bits += 8;
    }
    bits -= 6;
    s += ICE_CHARS[(acc >> bits) & 0x3f];
  }
  return s;
}

export function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return new Uint8Array(parts.map(Number));
}

const formatIpv4 = (b: Uint8Array) => Array.from(b).join('.');

export function parseIpv6(s: string): Uint8Array | null {
  if (!/^[0-9a-f:]+$/i.test(s) || s.split('::').length > 2) return null;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const missing = 8 - h.length - t.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...h, ...Array(tail === undefined ? 0 : missing).fill('0'), ...t];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const out = new Uint8Array(16);
  all.forEach((g, i) => {
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

/** RFC 5952 text form: lowercase, no leading zeros, longest run (≥2) of zero groups as `::`. */
export function formatIpv6(b: Uint8Array): string {
  const g = Array.from({ length: 8 }, (_, i) => (b[i * 2] << 8) | b[i * 2 + 1]);
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  const hex = g.map((v) => v.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

function parseMdns(s: string): Uint8Array | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/.exec(s);
  if (!m) return null;
  const hex = m.slice(1).join('');
  return new Uint8Array(Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)));
}

function formatMdns(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
}
