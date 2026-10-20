import './style.css';
import { AudioIO, SAMPLE_RATE } from './audio/audio-io';
import { encodeMessage } from './framing/message';
import { randomNonce, Receiver, Transmission } from './framing/pipeline';
import { GgwaveModem } from './modem/ggwave-modem';
import type { ProtocolId } from './modem/modem';
import { renderCard, renderProgress, type CardHandle, type ProgressHandle } from './ui/cards';
import { h } from './ui/dom';
import { SEND_TYPES, SendForm, type SendType } from './ui/send-form';
import { Spectrogram } from './ui/spectrogram';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- settings (localStorage is a convenience only; it may be unavailable)

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`earshot.${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`earshot.${key}`, value);
    } catch {
      // ignore
    }
  },
};

/** Transmit modes: one protocol per lane; lanes in different bands play simultaneously. */
const MODES: [string, [string, string, ProtocolId[]][]][] = [
  [
    'Dual band (audible + ultrasound, 2× speed)',
    [
      ['dual-normal', 'Dual Normal', ['audible-normal', 'ultrasound-normal']],
      ['dual-fast', 'Dual Fast (default)', ['audible-fast', 'ultrasound-fast']],
      ['dual-fastest', 'Dual Fastest (fragile)', ['audible-fastest', 'ultrasound-fastest']],
    ],
  ],
  [
    'Audible',
    [
      ['audible-normal', 'Normal', ['audible-normal']],
      ['audible-fast', 'Fast', ['audible-fast']],
      ['audible-fastest', 'Fastest (fragile)', ['audible-fastest']],
    ],
  ],
  [
    'Ultrasound (inaudible)',
    [
      ['ultrasound-normal', 'Normal', ['ultrasound-normal']],
      ['ultrasound-fast', 'Fast', ['ultrasound-fast']],
      ['ultrasound-fastest', 'Fastest (fragile)', ['ultrasound-fastest']],
    ],
  ],
  [
    'Low tones (unreliable)',
    [
      ['dt-fast', 'DT Fast', ['dt-fast']],
      ['dt-fastest', 'DT Fastest', ['dt-fastest']],
    ],
  ],
];
const LANES = new Map(MODES.flatMap(([, items]) => items.map(([id, , lanes]) => [id, lanes] as const)));
const DEFAULT_MODE = 'dual-fast';

const modeEl = $<HTMLSelectElement>('mode');
for (const [group, items] of MODES) {
  modeEl.append(h('optgroup', { label: group }, ...items.map(([id, name]) => new Option(name, id))));
}
// single-band mode ids match the protocol ids stored by earlier versions
modeEl.value = store.get('mode') ?? store.get('protocol') ?? DEFAULT_MODE;
if (!modeEl.value) modeEl.value = DEFAULT_MODE;
const currentLanes = () => LANES.get(modeEl.value) ?? LANES.get(DEFAULT_MODE)!;

const volumeEl = $<HTMLInputElement>('volume');
const volumeOut = $<HTMLOutputElement>('volume-out');
volumeEl.value = store.get('volume') ?? '25';
volumeOut.textContent = volumeEl.value;

// --- debug log

const debugEl = $<HTMLPreElement>('debug');
const debugLines: string[] = [];
function log(s: string): void {
  debugLines.unshift(`${new Date().toLocaleTimeString()} ${s}`);
  debugLines.length = Math.min(debugLines.length, 200);
  debugEl.textContent = debugLines.join('\n');
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const nonceTag = (n: number) => `#${n.toString(16).padStart(4, '0')}`;

// --- core

/** Silence between rounds, so each frame's end marker is clearly separated from the next start. */
const GAP_MS = 200;

const nonce = randomNonce();
const receiver = new Receiver(nonce);
const modemReady = GgwaveModem.create({ sampleRate: SAMPLE_RATE, volume: Number(volumeEl.value) });
let audio: AudioIO | undefined;
/** Ignore the mic until this time (ms) so we don't decode our own transmission. */
let deafUntil = 0;
log(`session nonce ${nonceTag(nonce)}`);

function getAudio(): AudioIO {
  if (!audio) {
    audio = new AudioIO();
    log(`AudioContext sampleRate=${audio.ctx.sampleRate}`);
  }
  return audio;
}

modeEl.onchange = () => {
  store.set('mode', modeEl.value);
  void updateMeter();
};
volumeEl.oninput = async () => {
  volumeOut.textContent = volumeEl.value;
  store.set('volume', volumeEl.value);
  (await modemReady).volume = Number(volumeEl.value);
};

// --- tabs

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=tab]'));
let unseen = 0;
function showTab(name: string): void {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    $(`tab-${t.dataset.tab}`).hidden = !on;
  }
  if (name === 'listen') setUnseen(0);
}
function setUnseen(n: number): void {
  unseen = n;
  tabs.find((t) => t.dataset.tab === 'listen')!.textContent = n ? `Listen (${n})` : 'Listen';
}
for (const t of tabs) t.onclick = () => showTab(t.dataset.tab!);

// --- send

const sendBtn = $<HTMLButtonElement>('send-btn');
const broadcastBtn = $<HTMLButtonElement>('broadcast-btn');
const sizeEl = $<HTMLSpanElement>('size');
const detectedEl = $<HTMLSpanElement>('detected');
const txStatus = $<HTMLParagraphElement>('tx-status');
const form = new SendForm($('send-fields'), () => void updateMeter());
$<HTMLFormElement>('send-form').onsubmit = (e) => e.preventDefault();

const picker = $('type-picker');
const typeButtons = SEND_TYPES.map(([type, label]) =>
  h('button', { type: 'button', 'aria-pressed': String(type === 'auto'), onclick: () => selectType(type) }, label),
);
picker.append(...typeButtons);
function selectType(type: SendType): void {
  typeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(SEND_TYPES[i][0] === type)));
  form.setType(type);
}

/** Encoded message for the current form contents, if it can be sent. */
let pending: Uint8Array | null = null;
let meterGen = 0;
/** Set while transmitting; aborting it stops playback. */
let active: AbortController | null = null;

function setSendable(ok: boolean): void {
  if (active) return; // buttons are Stop/disabled during a transmission
  sendBtn.disabled = broadcastBtn.disabled = !ok;
}

async function updateMeter(): Promise<void> {
  // Only touch the UI once the result is known, so the buttons don't flicker on every keystroke.
  const gen = ++meterGen;
  const modem = await modemReady;
  const result = form.read();
  const bytes = 'error' in result ? null : await encodeMessage(result.message);
  if (gen !== meterGen) return; // superseded by a newer keystroke
  if (!bytes || 'error' in result) {
    pending = null;
    setSendable(false);
    detectedEl.textContent = 'error' in result ? result.error : '';
    sizeEl.textContent = '';
    return;
  }
  detectedEl.textContent = result.detected ? `Detected: ${result.detected}` : '';
  let tx: Transmission;
  try {
    tx = new Transmission(bytes, nonce, modem.maxFrameBytes, currentLanes().length);
  } catch {
    pending = null;
    setSendable(false);
    sizeEl.replaceChildren(h('span', { class: 'over' }, `${bytes.length} bytes, too long`));
    return;
  }
  pending = bytes;
  const lanes = currentLanes();
  const round = modem.encodeParallel(tx.nextRound().map((frame, i) => ({ frame, protocol: lanes[i] })));
  const secs = tx.onceRounds * (round.length / SAMPLE_RATE + GAP_MS / 1000);
  const blocks = tx.single ? '' : ` · ${tx.k} blocks`;
  sizeEl.textContent = `${bytes.length} bytes${blocks} · ~${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`;
  setSendable(true);
}

async function requestWakeLock(): Promise<WakeLockSentinel | undefined> {
  try {
    return await navigator.wakeLock?.request('screen');
  } catch {
    return undefined;
  }
}

async function transmit(broadcast: boolean): Promise<void> {
  if (active) {
    active.abort(); // the pressed button is acting as Stop
    return;
  }
  if (!pending) return;
  const modem = await modemReady;
  const io = getAudio();
  const lanes = currentLanes();
  const tx = new Transmission(pending, nonce, modem.maxFrameBytes, lanes.length);
  const ctl = (active = new AbortController());
  const [mine, other] = broadcast ? [broadcastBtn, sendBtn] : [sendBtn, broadcastBtn];
  mine.textContent = 'Stop';
  other.disabled = true;
  // keep the screen on during a long broadcast; mobile browsers suspend audio when it sleeps
  const wake = broadcast || tx.onceRounds > 2 ? await requestWakeLock() : undefined;
  try {
    for (let r = 0; (broadcast || r < tx.onceRounds) && !ctl.signal.aborted; r++) {
      const frames = tx.nextRound();
      const wave = modem.encodeParallel(frames.map((frame, i) => ({ frame, protocol: lanes[i] })));
      txStatus.textContent = broadcast ? `Broadcasting… round ${r + 1}` : `Sending ${r + 1} of ${tx.onceRounds}…`;
      log(`TX round ${r + 1} ${modeEl.value} ${(wave.length / SAMPLE_RATE).toFixed(2)}s: ${frames.map(hex).join(' | ')}`);
      deafUntil = Infinity;
      await io.play(wave, ctl.signal);
      await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    }
  } finally {
    deafUntil = performance.now() + 300; // let the room's echo die down
    active = null;
    void wake?.release();
    txStatus.textContent = '';
    sendBtn.textContent = 'Send';
    broadcastBtn.textContent = 'Broadcast';
    setSendable(!!pending);
  }
}

sendBtn.onclick = () => void transmit(false);
broadcastBtn.onclick = () => void transmit(true);

// --- listen

const listenBtn = $<HTMLButtonElement>('listen-btn');
const cardsEl = $<HTMLDivElement>('cards');
const listenHint = $<HTMLParagraphElement>('listen-hint');
const spectrogram = new Spectrogram($<HTMLCanvasElement>('spectrogram'));
const cards = new Map<string, CardHandle>();
const inProgress = new Map<string, ProgressHandle>();

listenBtn.onclick = async () => {
  const io = getAudio();
  if (io.capturing) {
    io.stopCapture();
    spectrogram.stop();
    listenBtn.textContent = 'Start listening';
    log('mic stopped');
    return;
  }
  const modem = await modemReady;
  try {
    await io.startCapture();
  } catch (e) {
    log(`mic error: ${e}`);
    listenHint.textContent = 'Microphone access was blocked. Allow it in your browser settings and try again.';
    return;
  }
  listenBtn.textContent = 'Stop listening';
  log(`mic settings: ${JSON.stringify(io.trackSettings)}`);
  spectrogram.start(io.analyser!);
  io.onSamples = (samples) => {
    if (performance.now() < deafUntil) return;
    for (const raw of modem.pushSamples(samples)) void handleFrame(raw);
  };
};

async function handleFrame(raw: Uint8Array): Promise<void> {
  const ev = await receiver.push(raw);
  switch (ev.kind) {
    case 'echo':
      return log('RX own echo, ignored');
    case 'duplicate':
      return;
    case 'rejected':
      return log(`RX rejected (${ev.reason}): ${hex(raw)}`);
    case 'progress': {
      log(`RX block ${ev.have}/${ev.need} from ${nonceTag(ev.nonce)}`);
      let p = inProgress.get(ev.key);
      if (!p) {
        p = renderProgress(ev.nonce);
        inProgress.set(ev.key, p);
        cardsEl.prepend(p.el);
      }
      p.update(ev.have, ev.need);
      return;
    }
    case 'message': {
      log(`RX ${ev.message.type} from ${nonceTag(ev.nonce)}`);
      inProgress.get(ev.key)?.el.remove();
      inProgress.delete(ev.key);
      const existing = cards.get(ev.key);
      if (existing) {
        existing.setCount(ev.count);
        cardsEl.prepend(existing.el);
      } else {
        const card = renderCard(ev.message, ev.nonce);
        cards.set(ev.key, card);
        cardsEl.prepend(card.el);
      }
      if ($('tab-listen').hidden) setUnseen(unseen + 1);
      navigator.vibrate?.(30);
    }
  }
}

void updateMeter();
showTab(location.hash.startsWith('#listen') ? 'listen' : 'send');

if (import.meta.env.DEV && location.hash.includes('demo')) {
  // dev-only: sample cards for UI work without needing a second device
  void import('./ui/demo').then(({ demoMessages }) => {
    const p = renderProgress(0x0abc);
    p.update(3, 7);
    cardsEl.append(p.el);
    demoMessages.forEach((m, i) => cardsEl.append(renderCard(m, 0x1000 + i).el));
  });
}
