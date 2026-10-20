import './style.css';
import { AudioIO, SAMPLE_RATE } from './audio/audio-io';
import { encodeMessage } from './framing/message';
import { maxSingleMessageBytes, randomNonce, Receiver, toFrames } from './framing/pipeline';
import { GgwaveModem } from './modem/ggwave-modem';
import type { ProtocolId } from './modem/modem';
import { renderCard, type CardHandle } from './ui/cards';
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

const PROTOCOL_GROUPS: [string, [ProtocolId, string][]][] = [
  ['Audible', [['audible-normal', 'Normal'], ['audible-fast', 'Fast (default)'], ['audible-fastest', 'Fastest (fragile)']]],
  ['Ultrasound (inaudible)', [['ultrasound-normal', 'Normal'], ['ultrasound-fast', 'Fast'], ['ultrasound-fastest', 'Fastest (fragile)']]],
  ['Low tones (unreliable)', [['dt-fast', 'DT Fast'], ['dt-fastest', 'DT Fastest']]],
];

const protocolEl = $<HTMLSelectElement>('protocol');
for (const [group, items] of PROTOCOL_GROUPS) {
  protocolEl.append(h('optgroup', { label: group }, ...items.map(([id, name]) => new Option(name, id))));
}
protocolEl.value = store.get('protocol') ?? 'audible-fast';
if (!protocolEl.value) protocolEl.value = 'audible-fast';

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

// --- core

const nonce = randomNonce();
const receiver = new Receiver(nonce);
const modemReady = GgwaveModem.create({ sampleRate: SAMPLE_RATE, volume: Number(volumeEl.value) });
let audio: AudioIO | undefined;
/** Ignore the mic until this time (ms) so we don't decode our own transmission. */
let deafUntil = 0;
log(`session nonce #${nonce.toString(16).padStart(4, '0')}`);

function getAudio(): AudioIO {
  if (!audio) {
    audio = new AudioIO();
    log(`AudioContext sampleRate=${audio.ctx.sampleRate}`);
  }
  return audio;
}

protocolEl.onchange = () => {
  store.set('protocol', protocolEl.value);
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
const sizeEl = $<HTMLSpanElement>('size');
const detectedEl = $<HTMLSpanElement>('detected');
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

/** Frames ready to transmit for the current form contents, or null. */
let pending: Uint8Array[] | null = null;
let meterGen = 0;

async function updateMeter(): Promise<void> {
  // Only touch the UI once the result is known, so the button doesn't flicker on every keystroke.
  const gen = ++meterGen;
  const modem = await modemReady;
  const result = form.read();
  const bytes = 'error' in result ? null : await encodeMessage(result.message);
  if (gen !== meterGen) return; // superseded by a newer keystroke
  if (!bytes || 'error' in result) {
    pending = null;
    sendBtn.disabled = true;
    detectedEl.textContent = 'error' in result ? result.error : '';
    sizeEl.textContent = '';
    return;
  }
  detectedEl.textContent = result.detected ? `Detected: ${result.detected}` : '';
  const max = maxSingleMessageBytes(modem.maxFrameBytes);
  if (bytes.length > max) {
    pending = null;
    sendBtn.disabled = true;
    sizeEl.replaceChildren(h('span', { class: 'over' }, `${bytes.length} / ${max} bytes, too long for now`));
    return;
  }
  pending = toFrames(bytes, nonce, modem.maxFrameBytes);
  const samples = pending.reduce((n, f) => n + modem.encode(f, protocolEl.value as ProtocolId).length, 0);
  sizeEl.textContent = `${bytes.length} / ${max} bytes · ~${(samples / SAMPLE_RATE).toFixed(1)} s`;
  sendBtn.disabled = false;
}

sendBtn.onclick = async () => {
  if (!pending) return;
  const modem = await modemReady;
  const io = getAudio();
  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  try {
    for (const frame of pending) {
      const wave = modem.encode(frame, protocolEl.value as ProtocolId);
      log(`TX ${frame.length}B ${protocolEl.value} ${(wave.length / SAMPLE_RATE).toFixed(2)}s: ${hex(frame)}`);
      deafUntil = Infinity;
      await io.play(wave);
      deafUntil = performance.now() + 300; // let the room's echo die down
    }
  } finally {
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
  }
};

// --- listen

const listenBtn = $<HTMLButtonElement>('listen-btn');
const cardsEl = $<HTMLDivElement>('cards');
const listenHint = $<HTMLParagraphElement>('listen-hint');
const spectrogram = new Spectrogram($<HTMLCanvasElement>('spectrogram'));
const cards = new Map<string, CardHandle>();

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
  if (ev.kind === 'echo') return log(`RX own echo, ignored`);
  if (ev.kind === 'rejected') return log(`RX rejected (${ev.reason}): ${hex(raw)}`);
  log(`RX ${raw.length}B ${ev.message.type} from #${ev.nonce.toString(16).padStart(4, '0')}`);
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

void updateMeter();
showTab(location.hash.startsWith('#listen') ? 'listen' : 'send');

if (import.meta.env.DEV && location.hash.includes('demo')) {
  // dev-only: sample cards for UI work without needing a second device
  void import('./ui/demo').then(({ demoMessages }) => {
    demoMessages.forEach((m, i) => cardsEl.append(renderCard(m, 0x1000 + i).el));
  });
}
