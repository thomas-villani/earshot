// Typed messages. See SPEC.md "Message model".
//   [type: u8][flags: u8][payload...]   flags bit0: payload is deflate-raw compressed
// Everything decoded here came from the air: treat it as untrusted.

export const MessageType = {
  Text: 0x01,
  Url: 0x02,
  Contact: 0x03,
  Wifi: 0x04,
  AssistantPrompt: 0x05,
  RtcOffer: 0x10,
  RtcAnswer: 0x11,
  GameInvite: 0x20,
} as const;

const FLAG_DEFLATE = 0x01;

/** Upper bound on a decoded message; matches the fountain's u16 length field and caps decompression bombs. */
export const MAX_MESSAGE_BYTES = 65535;

export interface Contact {
  /** name */
  n: string;
  /** phone */
  p?: string;
  /** email */
  e?: string;
  /** organization */
  o?: string;
}

export interface Wifi {
  auth: 'WPA' | 'WEP' | 'nopass';
  ssid: string;
  password: string;
  hidden?: boolean;
}

export type Message =
  | { type: 'text'; text: string }
  | { type: 'url'; url: string }
  | { type: 'contact'; contact: Contact }
  | { type: 'wifi'; wifi: Wifi }
  | { type: 'prompt'; prompt: string; context?: string }
  | { type: 'unknown'; code: number; payload: Uint8Array };

const utf8 = new TextEncoder();
const fromUtf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);

export async function encodeMessage(msg: Message): Promise<Uint8Array> {
  let code: number;
  let payload: Uint8Array;
  switch (msg.type) {
    case 'text':
      [code, payload] = [MessageType.Text, utf8.encode(msg.text)];
      break;
    case 'url':
      [code, payload] = [MessageType.Url, utf8.encode(msg.url)];
      break;
    case 'contact':
      [code, payload] = [MessageType.Contact, utf8.encode(JSON.stringify(compactContact(msg.contact)))];
      break;
    case 'wifi':
      [code, payload] = [MessageType.Wifi, utf8.encode(formatWifi(msg.wifi))];
      break;
    case 'prompt': {
      const body = msg.context ? { prompt: msg.prompt, context: msg.context } : { prompt: msg.prompt };
      [code, payload] = [MessageType.AssistantPrompt, utf8.encode(JSON.stringify(body))];
      break;
    }
    case 'unknown':
      [code, payload] = [msg.code, msg.payload];
      break;
  }
  // compress only if it actually shrinks the payload (short strings usually grow)
  const deflated = await deflate(payload);
  const useDeflate = deflated.length < payload.length;
  const body = useDeflate ? deflated : payload;
  const out = new Uint8Array(2 + body.length);
  out[0] = code;
  out[1] = useDeflate ? FLAG_DEFLATE : 0;
  out.set(body, 2);
  return out;
}

/** Returns null for malformed input (bad UTF-8, bad JSON, failed decompression, oversized). */
export async function decodeMessage(bytes: Uint8Array): Promise<Message | null> {
  if (bytes.length < 2) return null;
  const [code, flags] = [bytes[0], bytes[1]];
  let payload = bytes.subarray(2);
  if (flags & FLAG_DEFLATE) {
    const inflated = await inflate(payload, MAX_MESSAGE_BYTES);
    if (!inflated) return null;
    payload = inflated;
  }
  try {
    switch (code) {
      case MessageType.Text:
        return { type: 'text', text: fromUtf8(payload) };
      case MessageType.Url: {
        const url = fromUtf8(payload);
        // Only http(s) gets a URL card (and its Open button); anything else, e.g. javascript:, is shown as text.
        return isWebUrl(url) ? { type: 'url', url } : { type: 'text', text: url };
      }
      case MessageType.Contact: {
        const c = JSON.parse(fromUtf8(payload));
        if (typeof c !== 'object' || c === null || typeof c.n !== 'string') return null;
        const contact: Contact = { n: c.n };
        for (const k of ['p', 'e', 'o'] as const) if (typeof c[k] === 'string') contact[k] = c[k];
        return { type: 'contact', contact };
      }
      case MessageType.Wifi: {
        const wifi = parseWifi(fromUtf8(payload));
        return wifi ? { type: 'wifi', wifi } : null;
      }
      case MessageType.AssistantPrompt: {
        const p = JSON.parse(fromUtf8(payload));
        if (typeof p !== 'object' || p === null || typeof p.prompt !== 'string') return null;
        return typeof p.context === 'string' ? { type: 'prompt', prompt: p.prompt, context: p.context } : { type: 'prompt', prompt: p.prompt };
      }
      default:
        return { type: 'unknown', code, payload: payload.slice() };
    }
  } catch {
    return null;
  }
}

export function isWebUrl(s: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Guess the message type for free text typed into the Send box. */
export function detectMessage(input: string): Message {
  const s = input.trim();
  if (isWebUrl(s)) return { type: 'url', url: s };
  const wifi = s.startsWith('WIFI:') ? parseWifi(s) : null;
  if (wifi) return { type: 'wifi', wifi };
  return { type: 'text', text: input };
}

function compactContact(c: Contact): Contact {
  const out: Contact = { n: c.n };
  for (const k of ['p', 'e', 'o'] as const) if (c[k]) out[k] = c[k];
  return out;
}

// --- Wi-Fi QR format: WIFI:T:WPA;S:<ssid>;P:<password>;H:true;;  (\ ; , : " are backslash-escaped)

const escapeWifi = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');

export function formatWifi(w: Wifi): string {
  let s = `WIFI:T:${w.auth};S:${escapeWifi(w.ssid)};`;
  if (w.auth !== 'nopass') s += `P:${escapeWifi(w.password)};`;
  if (w.hidden) s += 'H:true;';
  return s + ';';
}

export function parseWifi(s: string): Wifi | null {
  if (!s.startsWith('WIFI:')) return null;
  const fields: Record<string, string> = {};
  let key = '', val = '', inKey = true;
  for (let i = 5; i < s.length; i++) {
    const ch = s[i];
    if (!inKey && ch === '\\' && i + 1 < s.length) {
      val += s[++i];
    } else if (inKey && ch === ':') {
      inKey = false;
    } else if (ch === ';') {
      if (key) fields[key.toUpperCase()] = val;
      key = '';
      val = '';
      inKey = true;
    } else if (inKey) {
      key += ch;
    } else {
      val += ch;
    }
  }
  if (fields.S === undefined) return null;
  const t = (fields.T ?? 'nopass').toUpperCase();
  const auth = t === 'WPA' || t === 'WPA2' || t === 'SAE' ? 'WPA' : t === 'WEP' ? 'WEP' : 'nopass';
  const wifi: Wifi = { auth, ssid: fields.S, password: fields.P ?? '' };
  if (fields.H?.toLowerCase() === 'true') wifi.hidden = true;
  return wifi;
}

// --- compression (built-in CompressionStream; no dependencies)

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate, giving up (null) on corrupt input or if output would exceed `limit` bytes. */
async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  try {
    const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  } catch {
    return null;
  }
}
