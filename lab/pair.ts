// v2 milestone 2: pair two real devices with the compact SDP, signaling by copy and paste.
// Logs ICE/connection state with timestamps, RTT, and throughput, and builds a report that can be
// shared with public addresses masked.
import { acceptOffer, applyAnswer, createOffer, RTC_CONFIG, type GatherOptions, type LocalSide } from '../src/rtc/peer';
import { decodeCompactSdp, type CompactSdp } from '../src/rtc/sdp-compact';
import { candidatePairs, ChannelTools, describe, selectedPath } from './rtc-tools';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const checked = (id: string) => $<HTMLInputElement>(id).checked;
const t0 = performance.now();
const lines: string[] = [];
let local: LocalSide | undefined;
let remote: CompactSdp | undefined;
let role = '?';
let tools: ChannelTools | undefined;
const CHUNK = Number(new URLSearchParams(location.search).get('chunk') ?? 16) * 1024;

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
  pc.addEventListener('iceconnectionstatechange', async () => {
    log(`ice: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') (await candidatePairs(pc)).forEach(log);
  });
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
  tools = new ChannelTools(side.channel, log, CHUNK);
}

// ---- once open: path, RTT, throughput ----

async function afterOpen(side: LocalSide): Promise<void> {
  log(`path: ${await selectedPath(side.pc)}`);
  if (role === 'A') await tools!.rtt();
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
$('throughput').onclick = () => void tools!.throughput().catch((e) => log(`throughput error: ${e}`));
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
