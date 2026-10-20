// Train the static text-compression model (src/compress/model-data.json).
//
//   npx tsx tools/train-compressor.ts [--vocab 4096] [--sweep]
//
// Inputs (downloaded into data/, git-ignored; see NOTES.md for sources and licenses):
//   data/gpt2/vocab.bpe                 GPT-2 BPE merges (OpenAI, modified MIT): candidate tokens in rough frequency order
//   data/tatoeba/eng_sentences.tsv      Tatoeba English sentences (CC-BY 2.0 FR): everyday short text
//   data/gutenberg/pg1661.txt           Project Gutenberg (public domain): longer prose
// plus synthetic URLs, emails, contacts and Wi-Fi payloads generated below.
//
// Training: start every token at a flat cost, then repeat {segment the corpus optimally; set each token's
// cost to -log2 of its usage frequency}. Prune to the N most-used multi-byte tokens and repeat.
import { readFileSync, writeFileSync } from 'node:fs';
import { TextCodec, type ModelData } from '../src/compress/text-codec';
import { FIRST_MULTI, Vocab } from '../src/compress/tokenizer';
import { Rng } from '../test/sim/rng';

const args = process.argv.slice(2);
const VOCAB = Number(args[args.indexOf('--vocab') + 1] || 4096);
const SWEEP = args.includes('--sweep');
const CANDIDATES = 30000; // GPT-2 merges considered before pruning
const RS = '\x1e';
const utf8 = (s: string) => new TextEncoder().encode(s);

// --- GPT-2 byte-level BPE: merges are written in a printable remapping of bytes

function gpt2ByteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  return new Map(bs.map((b, i) => [String.fromCharCode(cs[i]), b]));
}

function loadMergedTokens(limit: number): Uint8Array[] {
  const dec = gpt2ByteDecoder();
  const lines = readFileSync('data/gpt2/vocab.bpe', 'utf8').split('\n').slice(1, limit + 1);
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const line of lines) {
    const [a, b] = line.split(' ');
    if (!a || !b) continue;
    const tok = a + b;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(Uint8Array.from([...tok], (ch) => dec.get(ch)!));
  }
  return out;
}

// --- corpus

function shuffle<T>(xs: T[], rng: Rng): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

function tatoeba(): string[] {
  return readFileSync('data/tatoeba/eng_sentences.tsv', 'utf8')
    .split('\n')
    .map((l) => l.split('\t')[2])
    .filter((s): s is string => !!s && s.length > 1);
}

function gutenberg(): string[] {
  const text = readFileSync('data/gutenberg/pg1661.txt', 'utf8');
  const body = text.slice(text.indexOf('*** START OF'), text.indexOf('*** END OF'));
  return body
    .split(/\r?\n\s*\r?\n/)
    .slice(1)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 20);
}

const FIRST = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'David', 'Elizabeth', 'Wei', 'Fatima', 'Carlos', 'Aisha', 'Hiroshi', 'Olga', 'Raj', 'Chloe', 'Liam', 'Emma', 'Noah', 'Olivia', 'Mateo', 'Sofia', 'Yuki', 'Amara', 'Lucas', 'Isabella', 'Ethan', 'Mia', 'Ahmed', 'Zara', 'Daniel', 'Grace', 'Ben', 'Nina', 'Alex', 'Kate', 'Sam', 'Leo'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis', 'Wilson', 'Taylor', 'Anderson', 'Chen', 'Khan', 'Rodriguez', 'Nguyen', 'Kim', 'Patel', 'Silva', 'Müller', 'Rossi', 'Kowalski', 'Okafor', 'Haddad', 'Ivanova', 'Tanaka', 'Murphy', 'Clarke', 'Thompson', 'White', 'Martin', 'Lopez'];
const PROVIDERS = ['gmail.com', 'gmail.com', 'gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'hotmail.com', 'proton.me', 'company.com', 'work.co.uk', 'school.edu', 'agency.io'];
const ORGS = ['Acme Corp', 'Blue Sky Consulting', 'City Hospital', 'Northwind Traders', 'Green Leaf Cafe', 'Summit Partners LLC', 'Riverside High School', 'Bright Ideas Ltd', 'Department of Biology', 'Smith & Sons Plumbing'];
const DOMAINS = ['google.com', 'youtube.com', 'github.com', 'wikipedia.org', 'en.wikipedia.org', 'amazon.com', 'reddit.com', 'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'linkedin.com', 'netflix.com', 'spotify.com', 'open.spotify.com', 'maps.google.com', 'docs.google.com', 'drive.google.com', 'bbc.co.uk', 'cnn.com', 'medium.com', 'stackoverflow.com', 'apple.com', 'microsoft.com', 'zoom.us', 'example.com', 'etsy.com', 'airbnb.com', 'booking.com', 'imdb.com', 'nature.com', 'arxiv.org', 'npmjs.com', 'developer.mozilla.org', 'news.ycombinator.com', 'theguardian.com', 'twitch.tv', 'tiktok.com', 'pinterest.com', 'dropbox.com'];
const PATH_WORDS = ['watch', 'wiki', 'search', 'products', 'item', 'blog', 'news', 'article', 'docs', 'user', 'profile', 'p', 'dp', 'r', 'comments', 'playlist', 'track', 'album', 'en', 'us', 'shop', 'event', 'share', 'post', 'status', 'video', 'photos', 'edit', 'view', 'download', 'help', 'about', 'pricing', 'login', 'settings', '2025', '2026', 'index.html'];
const WORDS = ['happy', 'blue', 'tiger', 'garden', 'coffee', 'sunset', 'river', 'pizza', 'dragon', 'maple', 'ocean', 'rocket', 'silver', 'forest', 'lucky', 'purple', 'winter', 'summer', 'castle', 'falcon'];
const SSID_BRANDS = ['NETGEAR', 'TP-Link_', 'Linksys', 'xfinitywifi', 'BT-', 'SKY', 'Vodafone-', 'ASUS_', 'eero', 'Google Wifi', 'ATT', 'Spectrum'];

function synthetic(n: number, rng: Rng): string[] {
  const pick = <T>(xs: T[]) => xs[rng.int(xs.length)];
  const digits = (k: number) => Array.from({ length: k }, () => rng.int(10)).join('');
  const idChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const randId = (k: number) => Array.from({ length: k }, () => idChars[rng.int(idChars.length)]).join('');
  const phone = () =>
    pick([
      () => `+1 (${digits(3)}) ${digits(3)}-${digits(4)}`,
      () => `(${digits(3)}) ${digits(3)}-${digits(4)}`,
      () => `${digits(3)}-${digits(3)}-${digits(4)}`,
      () => `+44 ${digits(2)} ${digits(4)} ${digits(4)}`,
      () => `07${digits(3)} ${digits(6)}`,
      () => `+${digits(2)} ${digits(3)} ${digits(3)} ${digits(3)}`,
    ])();
  const email = (f: string, l: string) =>
    `${pick([`${f}.${l}`, `${f}${l}`, `${f[0]}${l}`, `${f}${digits(2)}`, f])}`.toLowerCase().replace('ü', 'u') + '@' + pick(PROVIDERS);
  const url = () => {
    const d = pick(DOMAINS);
    const host = rng.next() < 0.35 && d.split('.').length === 2 ? `www.${d}` : d;
    let path = '';
    for (let i = rng.int(4); i > 0; i--) path += '/' + (rng.next() < 0.6 ? pick(PATH_WORDS) : rng.next() < 0.5 ? randId(6 + rng.int(10)) : pick(WORDS) + '-' + pick(WORDS));
    if (rng.next() < 0.3) path += `?${pick(['v', 'id', 'q', 'ref', 'page', 'utm_source'])}=${randId(4 + rng.int(8))}`;
    return `${rng.next() < 0.93 ? 'https' : 'http'}://${host}${path || (rng.next() < 0.5 ? '/' : '')}`;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = pick(FIRST), l = pick(LAST);
    const r = rng.next();
    if (r < 0.45) out.push(url());
    else if (r < 0.6) out.push(email(f, l));
    else if (r < 0.85) {
      const fields = [rng.next() < 0.85 ? `${f} ${l}` : f, rng.next() < 0.8 ? phone() : '', rng.next() < 0.6 ? email(f, l) : '', rng.next() < 0.3 ? pick(ORGS) : ''];
      while (fields.length > 1 && !fields[fields.length - 1]) fields.pop();
      out.push(fields.join(RS));
    } else {
      const auth = rng.next() < 0.1 ? 'N' : rng.next() < 0.03 ? 'E' : 'W';
      const ssid = rng.next() < 0.5 ? `${pick(SSID_BRANDS)}${randId(4).toUpperCase()}` : `${pick(LAST)} ${pick(['Home', 'WiFi', 'Guest', '5G', 'Family'])}`;
      const pw = auth === 'N' ? '' : rng.next() < 0.5 ? `${pick(WORDS)}${pick(WORDS)}${digits(rng.int(4))}` : randId(10 + rng.int(6));
      out.push([auth, ssid, pw].join(RS) + (rng.next() < 0.05 ? RS + '1' : ''));
    }
  }
  return out;
}

// --- training

function train(corpus: Uint8Array[], candidates: Uint8Array[], keep: number): TextCodec {
  let vocab = new Vocab(candidates);
  let cost = new Float64Array(vocab.size).fill(10);
  for (let b = 1; b < FIRST_MULTI; b++) cost[b] = 12;
  let counts = new Float64Array(vocab.size);
  const iterate = (rounds: number, smoothing: number) => {
    for (let r = 0; r < rounds; r++) {
      counts = new Float64Array(vocab.size);
      for (const item of corpus) {
        for (const id of vocab.segment(item, cost)) counts[id]++;
        counts[0]++; // EOF
      }
      const total = counts.reduce((a, b) => a + b, 0) + smoothing * vocab.size;
      cost = Float64Array.from(counts, (c) => -Math.log2((c + smoothing) / total));
    }
  };
  iterate(3, 0.01);
  // prune to the most-used multi-byte tokens, then refine on the smaller vocabulary
  const ranked = candidates
    .map((tok, i) => ({ tok, n: counts[FIRST_MULTI + i] }))
    .sort((a, b) => b.n - a.n)
    .slice(0, keep - FIRST_MULTI)
    .map((x) => x.tok);
  vocab = new Vocab(ranked);
  cost = Float64Array.from({ length: vocab.size }, (_, i) => (i === 0 ? 8 : i < FIRST_MULTI ? 12 : 10));
  iterate(3, 0.5);
  return new TextCodec(vocab, quantize(counts, 0.5));
}

/** Scale counts to integer frequencies summing to at most 2^16, every symbol at least 1. */
function quantize(counts: Float64Array, smoothing: number): number[] {
  const total = counts.reduce((a, b) => a + b + smoothing, 0);
  const spare = 0x10000 - counts.length;
  return Array.from(counts, (c) => 1 + Math.floor(((c + smoothing) / total) * spare));
}

function serialize(codec: TextCodec): ModelData {
  const multi = codec.vocab.tokens.slice(FIRST_MULTI);
  const freqs = Array.from({ length: codec.vocab.size }, (_, i) => codec.table.cum[i + 1] - codec.table.cum[i]);
  return {
    version: 1,
    tokens: Buffer.from(Uint8Array.from(multi.flatMap((t) => Array.from(t)))).toString('base64'),
    lens: multi.map((t) => t.length),
    freqs,
  };
}

function evaluate(codec: TextCodec, items: Uint8Array[]): { raw: number; packed: number } {
  let raw = 0, packed = 0;
  for (const it of items) {
    raw += it.length;
    packed += codec.encode(it).length;
  }
  return { raw, packed };
}

// --- main

const t0 = performance.now();
const rng = new Rng(2026);
const sentences = shuffle(tatoeba(), rng);
const prose = shuffle(gutenberg(), rng);
const dev = [...sentences.slice(0, 3000), ...prose.slice(0, 150), ...synthetic(1500, new Rng(99))].map(utf8);
const corpus = [...sentences.slice(3000, 253000), ...prose.slice(150), ...synthetic(40000, new Rng(1))].map(utf8);
const candidates = loadMergedTokens(CANDIDATES);
console.log(`corpus ${corpus.length} items (${corpus.reduce((a, b) => a + b.length, 0)} bytes); dev ${dev.length}; ${candidates.length} candidate tokens; ${((performance.now() - t0) / 1000).toFixed(0)}s`);

for (const n of SWEEP ? [1024, 2048, 4096, 8192, 16384] : [VOCAB]) {
  const codec = train(corpus, candidates, n);
  const { raw, packed } = evaluate(codec, dev);
  const json = JSON.stringify(serialize(codec));
  console.log(`vocab ${String(n).padStart(5)}: dev ${raw} -> ${packed} bytes (${((100 * packed) / raw).toFixed(1)}%, ${((8 * packed) / raw).toFixed(2)} bits/byte); model JSON ${(json.length / 1024).toFixed(0)} KB; ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  if (!SWEEP) {
    writeFileSync('src/compress/model-data.json', json + '\n');
    console.log('wrote src/compress/model-data.json');
  }
}
