// v2 milestone 3: the WebRTC offer and answer travel by sound. See SPEC.md "Handshake flow".
//
// Half duplex: Phone A loops the offer, listening for an answer between rounds. Phone B hears the
// offer and asks before answering. B answers right away if it still fits in A's listening window,
// otherwise just after A's next offer ends (plus a random 0–800 ms, in case several phones answer).
// B answers every time it hears the offer again until the channel opens, so a lost answer only
// costs one round.
//
// ?bus replaces the speaker and mic with a BroadcastChannel between two tabs of this page (still
// through the real modem), for testing without two phones.
import { AudioIO, SAMPLE_RATE } from '../src/audio/audio-io';
import { randomNonce, Receiver, Transmission } from '../src/framing/pipeline';
import { GgwaveModem } from '../src/modem/ggwave-modem';
import type { ProtocolId } from '../src/modem/modem';
import { encodeHandshake, parseHandshake, splitFrameBytes, verificationCode, type HandshakeKind } from '../src/rtc/handshake';
import { acceptOffer, applyAnswer, createOffer, type LocalSide } from '../src/rtc/peer';
import { decodeCompactSdp, ONE_FRAME_BYTES, type CompactSdp } from '../src/rtc/sdp-compact';
import { Spectrogram } from '../src/ui/spectrogram';
import { candidatePairs, ChannelTools, describe, selectedPath } from './rtc-tools';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const t0 = performance.now();
const lines: string[] = [];
function log(msg: string): void {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${msg}`);
  $('log').textContent = lines.join('\n');
}
const status = (s: string) => ($('status').textContent = s);
const tag = (n: number) => `#${n.toString(16).padStart(4, '0')}`;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
document.addEventListener('visibilitychange', () => log(`page ${document.visibilityState}`));

const MODES: [string, ProtocolId[]][] = [
  ['Dual Fast', ['audible-fast', 'ultrasound-fast']],
  ['Dual Fastest (fragile)', ['audible-fastest', 'ultrasound-fastest']],
  ['Audible Fast', ['audible-fast']],
  ['Ultrasound Fast', ['ultrasound-fast']],
];
const modeEl = $<HTMLSelectElement>('mode');
MODES.forEach(([name], i) => modeEl.append(new Option(name, String(i))));
const lanes = () => MODES[Number(modeEl.value)][1];
const volumeEl = $<HTMLInputElement>('volume');
$('volume-out').textContent = volumeEl.value;

// ---- the air: real speaker + mic, or a BroadcastChannel between tabs ----

const BUS = new URLSearchParams(location.search).has('bus');
const modemReady = GgwaveModem.create({ sampleRate: SAMPLE_RATE, volume: Number(volumeEl.value) });
volumeEl.oninput = async () => {
  $('volume-out').textContent = volumeEl.value;
  (await modemReady).volume = Number(volumeEl.value);
};
let io: AudioIO | undefined;
const bus = BUS ? new BroadcastChannel('earshot-bus') : undefined;
/** Ignore the mic until this time, so we don't hear ourselves. */
let deafUntil = 0;

async function play(wave: Float32Array, signal: AbortSignal): Promise<void> {
  deafUntil = Infinity;
  try {
    if (bus) {
      await sleep((wave.length / SAMPLE_RATE) * 1000, signal);
      if (!signal.aborted) bus.postMessage(wave);
    } else {
      await io!.play(wave, signal);
    }
  } finally {
    deafUntil = performance.now() + 300; // let the room's echo die down
  }
}

function onSamples(samples: Float32Array, modem: GgwaveModem): void {
  if (performance.now() < deafUntil) return;
  for (const raw of modem.pushSamples(samples)) void onFrame(raw);
}

const nonce = randomNonce();
const receiver = new Receiver(nonce);

function waveFor(tx: Transmission, modem: GgwaveModem): Float32Array {
  const ls = lanes();
  return modem.encodeParallel(tx.nextRound().map((frame, i) => ({ frame, protocol: ls[i] })));
}

function handshakeTx(kind: HandshakeKind, compact: Uint8Array, modem: GgwaveModem): Transmission {
  const bytes = encodeHandshake(kind, compact);
  return new Transmission(bytes, nonce, splitFrameBytes(bytes.length, lanes().length, modem.maxFrameBytes), lanes().length);
}

/** Airtime of the largest possible answer in the current mode. */
function maxAnswerMs(modem: GgwaveModem): number {
  const tx = handshakeTx('answer', new Uint8Array(ONE_FRAME_BYTES), modem);
  return (waveFor(tx, modem).length / SAMPLE_RATE) * 1000;
}
/** A listens this long after each offer: room for a person to tap Accept (~5 s) and the longest answer. */
const LISTEN_SLACK_MS = 6000;
const listenWindowMs = (modem: GgwaveModem) => maxAnswerMs(modem) + LISTEN_SLACK_MS;

// ---- what we hear ----

/** Handshake messages heard, by receiver key, so a repeat can be recognized. */
const heard = new Map<string, { kind: HandshakeKind; compact: CompactSdp; bytes: Uint8Array }>();
const lastRepeat = new Map<string, number>();

async function onFrame(raw: Uint8Array): Promise<void> {
  const ev = await receiver.push(raw);
  if (ev.kind === 'rejected') return log(`heard junk (${ev.reason})`);
  if (ev.kind === 'progress') return log(`heard part of a message from ${tag(ev.nonce)} (${ev.have}/${ev.need})`);
  if (ev.kind === 'echo') return;
  const known = heard.get(ev.key);
  if (known) {
    // Both lanes of one round end together; count a round once.
    const now = performance.now();
    if (now - (lastRepeat.get(ev.key) ?? 0) > 1500) {
      lastRepeat.set(ev.key, now);
      onRepeat(known.kind, known.compact);
    }
    return;
  }
  if (ev.kind !== 'message') return;
  const hs = parseHandshake(ev.message);
  if (!hs) return log(`heard a ${ev.message.type} message from ${tag(ev.nonce)}; not a handshake`);
  const compact = decodeCompactSdp(hs.bytes);
  if (!compact) return log(`heard a malformed ${hs.kind} from ${tag(ev.nonce)}`);
  heard.set(ev.key, { kind: hs.kind, compact, bytes: hs.bytes });
  lastRepeat.set(ev.key, performance.now());
  log(`heard ${hs.kind} from ${tag(ev.nonce)}: ${hs.bytes.length} B, session ${compact.sessionId.toString(16)}; candidates: ${describe(compact)}`);
  if (hs.kind === 'offer') onOffer(compact, hs.bytes, ev.nonce);
  else void onAnswer(compact, hs.bytes);
}

// ---- shared connection state ----

let role: 'A' | 'B' | undefined;
let local: LocalSide | undefined;
let tools: ChannelTools | undefined;
let open = false;
let tStart = 0;

function watch(side: LocalSide): void {
  const pc = side.pc;
  pc.addEventListener('iceconnectionstatechange', async () => {
    log(`ice: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') (await candidatePairs(pc)).forEach(log);
  });
  pc.addEventListener('connectionstatechange', () => log(`connection: ${pc.connectionState}`));
  tools = new ChannelTools(side.channel, log);
  tools.onChat = (text) => ($('chat-log').textContent += `them: ${text}\n`);
  side.channel.addEventListener('open', async () => {
    open = true;
    log(`data channel open, ${((performance.now() - tStart) / 1000).toFixed(1)} s after ${role === 'A' ? 'the first offer' : 'Accept'}`);
    status('Connected');
    stopLoop?.abort();
    $('connected').hidden = false;
    $('cancel').hidden = true;
    log(`path: ${await selectedPath(pc)}`);
    if (role === 'A') await tools!.rtt();
  });
  side.channel.addEventListener('close', () => {
    log('data channel closed');
    status('Disconnected');
  });
}

async function showCode(offer: CompactSdp, answer: CompactSdp): Promise<void> {
  $('code').textContent = await verificationCode(offer.fingerprint, answer.fingerprint);
  $('code-box').hidden = false;
  log(`verification code ${$('code').textContent}`);
}

// ---- Phone A: loop the offer until an answer arrives ----

let stopLoop: AbortController | undefined;
let answered = false;
let gotAnswer: (() => void) | undefined;
const MAX_ROUNDS = 12;

$('offer').onclick = async () => {
  if (role) return;
  role = 'A';
  $<HTMLButtonElement>('offer').disabled = true;
  $('incoming').replaceChildren();
  const modem = await modemReady;
  tStart = performance.now();
  status('Preparing the offer…');
  local = await createOffer(crypto.getRandomValues(new Uint32Array(1))[0]);
  watch(local);
  log(`offer: ${local.bytes.length} B, session ${local.compact.sessionId.toString(16)}, gathered in ${Math.round(local.gatherMs)} ms; candidates: ${describe(local.compact)}`);
  const tx = handshakeTx('offer', local.bytes, modem);
  const window = listenWindowMs(modem);
  const ctl = (stopLoop = new AbortController());
  $('cancel').hidden = false;
  for (let round = 1; round <= MAX_ROUNDS && !answered && !ctl.signal.aborted; round++) {
    const wave = waveFor(tx, modem);
    status(`Sending the offer (round ${round})…`);
    log(`offer round ${round}: ${(wave.length / SAMPLE_RATE).toFixed(1)} s on ${lanes().join(' + ')}`);
    await play(wave, ctl.signal);
    if (answered || ctl.signal.aborted) break;
    status('Listening for an answer…');
    await Promise.race([sleep(window, ctl.signal), new Promise<void>((r) => (gotAnswer = r))]);
  }
  if (!answered && !open) status(ctl.signal.aborted ? 'Stopped' : 'No answer. Reload to try again.');
  $('cancel').hidden = true;
};

async function onAnswer(answer: CompactSdp, bytes: Uint8Array): Promise<void> {
  if (role !== 'A' || !local || answered) return;
  if (answer.sessionId !== local.compact.sessionId) return log('answer for a different session; ignored');
  answered = true;
  gotAnswer?.();
  stopLoop?.abort();
  if (!(await applyAnswer(local, bytes))) return log('answer rejected');
  log(`answer applied, ${((performance.now() - tStart) / 1000).toFixed(1)} s after the first offer`);
  status('Connecting…');
  await showCode(local.compact, answer);
}

$('cancel').onclick = () => {
  stopLoop?.abort();
  log('stopped');
};

// ---- Phone B: ask, then answer in A's listening window ----

let accepted: { offer: CompactSdp; tx: Transmission } | undefined;
let lastOfferEnd = 0;
let answering = false;

function onOffer(offer: CompactSdp, bytes: Uint8Array, from: number): void {
  lastOfferEnd = performance.now();
  if (role) return log('already busy; ignoring the offer');
  const box = document.createElement('div');
  box.className = 'incoming';
  const accept = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Accept' });
  box.append(Object.assign(document.createElement('p'), { textContent: `A nearby phone (${tag(from)}) wants to connect.` }), accept);
  $('incoming').replaceChildren(box);
  status('Incoming connection');
  accept.onclick = async () => {
    if (role) return;
    role = 'B';
    accept.disabled = true;
    $<HTMLButtonElement>('offer').disabled = true;
    tStart = performance.now();
    const modem = await modemReady;
    const side = await acceptOffer(bytes);
    if (!side) return log('offer rejected');
    local = side;
    watch(side);
    log(`answer: ${side.bytes.length} B, gathered in ${Math.round(side.gatherMs)} ms; candidates: ${describe(side.compact)}`);
    accepted = { offer, tx: handshakeTx('answer', side.bytes, modem) };
    await showCode(offer, side.compact);
    // A is still listening if its window has room for the whole answer; else wait for its next offer.
    const answerMs = (waveFor(handshakeTx('answer', side.bytes, modem), modem).length / SAMPLE_RATE) * 1000;
    const left = lastOfferEnd + listenWindowMs(modem) - performance.now();
    if (left > answerMs + 500) void sendAnswer(0);
    else {
      status('Waiting for the other phone to finish…');
      log(`A's listening window has ${Math.round(left)} ms left, answer needs ${Math.round(answerMs)} ms; answering after its next offer`);
    }
  };
}

function onRepeat(kind: HandshakeKind, compact: CompactSdp): void {
  if (kind !== 'offer') return;
  lastOfferEnd = performance.now();
  if (accepted && !open && compact.sessionId === accepted.offer.sessionId) void sendAnswer(Math.random() * 800);
}

async function sendAnswer(delayMs: number): Promise<void> {
  if (!accepted || answering || open) return;
  answering = true;
  try {
    await sleep(delayMs);
    const modem = await modemReady;
    status('Sending the answer…');
    const wave = waveFor(accepted.tx, modem);
    log(`answer: playing ${(wave.length / SAMPLE_RATE).toFixed(1)} s after ${Math.round(delayMs)} ms`);
    await play(wave, new AbortController().signal);
    if (!open) status('Connecting… (the answer repeats if the other phone sends its offer again)');
  } finally {
    answering = false;
  }
}

// ---- start, chat, report ----

$('start').onclick = async () => {
  const modem = await modemReady;
  try {
    io = new AudioIO();
    await io.startCapture();
    log(`mic settings: ${JSON.stringify(io.trackSettings)}`);
    if (bus) {
      io.stopCapture(); // permission granted (raw IPs, as in the app); the bus replaces the mic
      bus.onmessage = (e: MessageEvent<Float32Array>) => {
        const pad = new Float32Array(SAMPLE_RATE / 2);
        for (const s of [pad, e.data, pad, pad]) onSamples(s, modem);
      };
    } else {
      io.onSamples = (s) => onSamples(s, modem);
      new Spectrogram($<HTMLCanvasElement>('spectrogram')).start(io.analyser!);
    }
  } catch (e) {
    return log(`mic error: ${e}`);
  }
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // not fatal: the screen may sleep
  }
  $('start-box').hidden = true;
  $('main').hidden = false;
  log(`nonce ${tag(nonce)}, mode ${modeEl.selectedOptions[0].text}${bus ? ' (bus)' : ''}; A listens ${Math.round(listenWindowMs(modem))} ms between offers`);
};

$<HTMLFormElement>('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('chat-text');
  if (!input.value || !open) return;
  tools!.chat(input.value);
  $('chat-log').textContent += `me: ${input.value}\n`;
  input.value = '';
};
$('throughput').onclick = () => void tools?.throughput().catch((e) => log(`throughput error: ${e}`));
$('report-copy').onclick = async () => {
  const text = [`role ${role ?? '?'}; ${navigator.userAgent}`, `mode ${modeEl.selectedOptions[0].text}, volume ${volumeEl.value}`, ...lines].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('report copied (public addresses masked)');
  } catch {
    $('log').textContent = text;
  }
};

// for the headless test
Object.assign(window, { labState: () => ({ role, open, code: $('code').textContent, lines }) });
