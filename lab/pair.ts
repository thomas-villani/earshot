// v2 milestone 2: pair two real devices with the compact SDP, signaling by copy and paste.
// Logs ICE/connection state with timestamps, RTT, and throughput, and builds a report that can be
// shared with public addresses masked.
import { acceptOffer, applyAnswer, createOffer, RTC_CONFIG, type GatherOptions, type LocalSide } from '../src/rtc/peer';
import { decodeCompactSdp, type CompactSdp } from '../src/rtc/sdp-compact';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const t0 = performance.now();
const lines: string[] = [];
let local: LocalSide | undefined;
let remote: CompactSdp | undefined;
let role = '?';

function log(msg: string): void {
  const line = `${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${msg}`;
  lines.push(line);
  $('log').textContent = lines.join('\n');
}

// Switching to a chat app to paste backgrounds the page; log it so a stall can be lined up with it.
document.addEventListener('visibilitychange', () => log(`page ${document.visibilityState}`));

// ---- text form: "ES1O" / "ES1A" + base64url, so a pasted blob says what it is ----

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
function unwrap(text: string, kind: 'O' | 'A'): Uint8Array | null {
  const m = new RegExp(`ES1${kind}([A-Za-z0-9_-]+)`).exec(text.replace(/\s+/g, ''));
  return m ? fromB64(m[1]) : null;
}

// ---- masking for the shareable report ----

function maskAddress(a: string): string {
  if (a.endsWith('.local')) return 'mdns';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) return a; // private LAN: useful, not identifying
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return 'cgnat4'; // 100.64/10 carrier NAT
  if (a.includes('.')) return 'public4';
  if (/^fe80:/i.test(a)) return 'linklocal6';
  if (/^f[cd]/i.test(a)) return 'ula6';
  return a.includes(':') ? 'public6' : '?';
}
const describe = (c: CompactSdp) => c.candidates.map((x) => `${x.type}:${maskAddress(x.address)}`).join(', ') || '(none)';

function options(): GatherOptions {
  return { config: checked('opt-nostun') ? { iceServers: [] } : RTC_CONFIG, timeoutMs: 3000 };
}

async function maybeGrantMic(): Promise<void> {
  if (!checked('opt-mic')) return;
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
  log('mic granted');
}

function watch(side: LocalSide): void {
  const pc = side.pc;
  pc.addEventListener('iceconnectionstatechange', () => log(`ice: ${pc.iceConnectionState}`));
  pc.addEventListener('signalingstatechange', () => log(`signaling: ${pc.signalingState}`));
  pc.addEventListener('icecandidateerror', (e) => log(`ice candidate error ${(e as RTCPeerConnectionIceErrorEvent).errorCode} on ${(e as RTCPeerConnectionIceErrorEvent).url}`));
  pc.addEventListener('connectionstatechange', () => {
    log(`connection: ${pc.connectionState}`);
    $('state').textContent = pc.connectionState;
  });
  side.channel.addEventListener('open', () => {
    log('data channel open');
    $<HTMLButtonElement>('throughput').disabled = false;
    void afterOpen(side);
  });
  side.channel.addEventListener('close', () => log('data channel closed'));
  side.channel.binaryType = 'arraybuffer';
  side.channel.addEventListener('message', onMessage);
}

// ---- once open: path, RTT, throughput ----

async function afterOpen(side: LocalSide): Promise<void> {
  const stats = await side.pc.getStats();
  stats.forEach((s) => {
    if (s.type !== 'transport' || !s.selectedCandidatePairId) return;
    const pair = stats.get(s.selectedCandidatePairId);
    const l = stats.get(pair.localCandidateId);
    const r = stats.get(pair.remoteCandidateId);
    log(`path: ${l?.candidateType} ${maskAddress(l?.address ?? '')} → ${r?.candidateType} ${maskAddress(r?.address ?? '')} (${l?.protocol})`);
  });
  if (role === 'A') {
    const rtts: number[] = [];
    for (let i = 0; i < 5; i++) rtts.push(await ping(side.channel));
    rtts.sort((a, b) => a - b);
    log(`rtt ms: median ${rtts[2].toFixed(1)} (min ${rtts[0].toFixed(1)}, max ${rtts[4].toFixed(1)})`);
  }
}

let pongWaiter: ((t: number) => void) | undefined;
function ping(ch: RTCDataChannel): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    pongWaiter = () => resolve(performance.now() - start);
    ch.send('ping');
  });
}

const CHUNK = Number(new URLSearchParams(location.search).get('chunk') ?? 16) * 1024;
let tpExpect = 0;
let tpGot = 0;
let tpFirst = 0;
let tpDone: ((ms: number) => void) | undefined;

function onMessage(e: MessageEvent): void {
  const ch = e.target as RTCDataChannel;
  if (typeof e.data === 'string') {
    if (e.data === 'ping') ch.send('pong');
    else if (e.data === 'pong') pongWaiter?.(0);
    else if (e.data.startsWith('tp-start:')) {
      tpExpect = Number(e.data.slice(9));
      tpGot = 0;
      tpFirst = 0;
    } else if (e.data.startsWith('tp-done:')) tpDone?.(Number(e.data.slice(8)));
    return;
  }
  if (!tpFirst) tpFirst = performance.now();
  tpGot += (e.data as ArrayBuffer).byteLength;
  if (tpGot >= tpExpect) {
    const ms = performance.now() - tpFirst;
    log(`received ${(tpGot / 1e6).toFixed(1)} MB at ${(tpGot / 1e6 / (ms / 1000)).toFixed(1)} MB/s`);
    ch.send(`tp-done:${ms}`);
  }
}

async function throughput(): Promise<void> {
  const ch = local!.channel;
  const total = 8 * 1024 * 1024;
  const chunk = new Uint8Array(CHUNK);
  crypto.getRandomValues(chunk);
  ch.bufferedAmountLowThreshold = 1024 * 1024;
  const done = new Promise<number>((r) => (tpDone = r));
  ch.send(`tp-start:${total}`);
  const start = performance.now();
  for (let sent = 0; sent < total; sent += chunk.length) {
    if (ch.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }));
    ch.send(chunk);
  }
  await done;
  const ms = performance.now() - start;
  log(`sent 8 MB in ${(ms / 1000).toFixed(2)} s = ${(total / 1e6 / (ms / 1000)).toFixed(1)} MB/s`);
}

// ---- roles ----

$('be-a').onclick = async () => {
  role = 'A';
  $<HTMLInputElement>('opt-omit').disabled = true; // only the answer can leave its candidates out
  $('pick').hidden = true;
  $('a').hidden = false;
  try {
    await maybeGrantMic();
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    local = await createOffer(id, options());
    watch(local);
    $<HTMLTextAreaElement>('offer-out').value = `ES1O${toB64(local.bytes)}`;
    log(`offer: ${local.bytes.length} B, session ${id.toString(16)}, gathered in ${Math.round(local.gatherMs)} ms; candidates: ${describe(local.compact)}`);
  } catch (e) {
    log(`error: ${e}`);
  }
};

$('answer-apply').onclick = async () => {
  const bytes = unwrap($<HTMLTextAreaElement>('answer-in').value, 'A');
  const answer = bytes && decodeCompactSdp(bytes);
  if (!local || !bytes || !answer) return log('that is not an answer (expected text starting ES1A)');
  remote = answer;
  log(`answer pasted: ${bytes.length} B; candidates: ${describe(answer)}`);
  if (local.pc.signalingState === 'stable') return log('an answer is already applied; reload both pages to start over');
  try {
    if (!(await applyAnswer(local, bytes))) return log('answer rejected (different session?)');
    log('answer applied; connecting…');
  } catch (e) {
    log(`answer failed: ${e}`);
  }
};

$('be-b').onclick = () => {
  role = 'B';
  $('pick').hidden = true;
  $('b').hidden = false;
};

$('offer-accept').onclick = async () => {
  const bytes = unwrap($<HTMLTextAreaElement>('offer-in').value, 'O');
  const offer = bytes && decodeCompactSdp(bytes);
  if (!bytes || !offer) return log('that is not an offer (expected text starting ES1O)');
  remote = offer;
  log(`offer pasted: ${bytes.length} B, session ${offer.sessionId.toString(16)}; candidates: ${describe(offer)}`);
  local?.pc.close(); // a second paste on the same page replaces the first attempt
  try {
    await maybeGrantMic();
    const side = await acceptOffer(bytes, { ...options(), omitCandidates: checked('opt-omit') });
    if (!side) return log('offer rejected');
    local = side;
    watch(side);
    $<HTMLTextAreaElement>('answer-out').value = `ES1A${toB64(side.bytes)}`;
    $('b-answer').hidden = false;
    log(`answer: ${side.bytes.length} B, gathered in ${Math.round(side.gatherMs)} ms; candidates: ${describe(side.compact)}`);
  } catch (e) {
    log(`error: ${e}`);
  }
};

// ---- copy / share ----

async function copy(id: string): Promise<void> {
  const text = $<HTMLTextAreaElement>(id).value;
  try {
    await navigator.clipboard.writeText(text);
    log('copied');
  } catch {
    $<HTMLTextAreaElement>(id).select();
    log('select-all done; copy manually');
  }
}
const share = (id: string) => void navigator.share?.({ text: $<HTMLTextAreaElement>(id).value }).catch(() => {});

$('offer-copy').onclick = () => void copy('offer-out');
$('offer-share').onclick = () => share('offer-out');
$('answer-copy').onclick = () => void copy('answer-out');
$('answer-share').onclick = () => share('answer-out');
$('throughput').onclick = () => void throughput().catch((e) => log(`throughput error: ${e}`));
$('report-copy').onclick = async () => {
  const head = [
    `role ${role}; ${navigator.userAgent}`,
    `options: mic=${checked('opt-mic')} omitAnswerCandidates=${checked('opt-omit')} noStun=${checked('opt-nostun')}`,
    remote ? `remote candidates: ${describe(remote)}` : '',
  ];
  const text = [...head, ...lines].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('report copied (public addresses masked)');
  } catch {
    $('log').textContent = text;
  }
};
