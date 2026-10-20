import { AudioIO, SAMPLE_RATE } from './audio/audio-io';
import { GgwaveModem } from './modem/ggwave-modem';
import { PROTOCOLS, type ProtocolId } from './modem/modem';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const msgEl = $<HTMLTextAreaElement>('msg');
const protoEl = $<HTMLSelectElement>('protocol');
const sendBtn = $<HTMLButtonElement>('send');
const listenBtn = $<HTMLButtonElement>('listen');
const receivedEl = $<HTMLDivElement>('received');
const debugEl = $<HTMLPreElement>('debug');

const log = (s: string) => {
  debugEl.textContent = `${new Date().toLocaleTimeString()} ${s}\n` + debugEl.textContent;
};

for (const p of PROTOCOLS) protoEl.add(new Option(p, p, p === 'audible-fast', p === 'audible-fast'));

const modemReady = GgwaveModem.create({ sampleRate: SAMPLE_RATE });
let audio: AudioIO | undefined;
let transmitting = false;

function getAudio(): AudioIO {
  if (!audio) {
    audio = new AudioIO();
    log(`AudioContext sampleRate=${audio.ctx.sampleRate}`);
  }
  return audio;
}

sendBtn.onclick = async () => {
  const modem = await modemReady;
  const bytes = new TextEncoder().encode(msgEl.value);
  let wave: Float32Array;
  try {
    wave = modem.encode(bytes, protoEl.value as ProtocolId);
  } catch (e) {
    log(String(e));
    return;
  }
  log(`TX ${bytes.length}B ${protoEl.value} airtime ${(wave.length / SAMPLE_RATE).toFixed(2)}s`);
  sendBtn.disabled = true;
  transmitting = true;
  await getAudio().play(wave);
  transmitting = false;
  sendBtn.disabled = false;
};

listenBtn.onclick = async () => {
  const modem = await modemReady;
  const io = getAudio();
  try {
    await io.startCapture();
  } catch (e) {
    log(`mic error: ${e}`);
    return;
  }
  listenBtn.disabled = true;
  listenBtn.textContent = 'Listening…';
  log(`mic settings: ${JSON.stringify(io.trackSettings)}`);
  io.onSamples = (samples) => {
    // ignore our own transmissions
    if (transmitting) return;
    for (const frame of modem.pushSamples(samples)) {
      const hex = Array.from(frame, (b) => b.toString(16).padStart(2, '0')).join(' ');
      log(`RX ${frame.length}B: ${hex}`);
      const card = document.createElement('div');
      card.className = 'rx';
      // textContent, never innerHTML: decoded data is untrusted
      card.textContent = new TextDecoder().decode(frame);
      receivedEl.prepend(card);
    }
  };
};
