// Acoustic channel simulator: frame success rates per protocol/payload under noise, reverb and device band-limits.
// Usage: npm run sim -- [--trials N] [--only A,B,...]
import { GgwaveModem } from '../src/modem/ggwave-modem';
import { PROTOCOLS, type ProtocolId } from '../src/modem/modem';
import { applyChannel, CLEAN, SAMPLE_RATE, type ChannelConfig, type DeviceProfile } from './sim/channel';
import { Rng } from './sim/rng';

const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const TRIALS = Number(argVal('--trials') ?? 12);
const ONLY = argVal('--only')?.split(',');

/** Peak level of the transmitted waveform as it arrives at the mic, before channel gain. */
const MIC_PEAK = 0.25;
/** Captured audio is fed to the modem in chunks this size, like the AudioWorklet batches. */
const CHUNK = 2048;

const modem = await GgwaveModem.create({ sampleRate: SAMPLE_RATE });

interface CellResult {
  ok: number;
  wrong: number;
  none: number;
  airtime: number;
  /** Mean seconds from end of transmission to decode, over successful trials. */
  latency: number;
}

function runCell(protocol: ProtocolId, len: number, cfg: ChannelConfig, seed: number): CellResult {
  const rng = new Rng(seed);
  let ok = 0, wrong = 0, none = 0, airtime = 0, latencySum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const payload = rng.bytes(len);
    const wave = modem.encode(payload, protocol);
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    const scaled = wave.map((v) => (v / peak) * MIC_PEAK);
    airtime = wave.length / SAMPLE_RATE;

    const leadIn = 0.3 + rng.next() * 0.1; // random alignment against ggwave's frame grid
    const captured = applyChannel(scaled, cfg, rng, leadIn, 2.0);

    modem.setSampleRate(SAMPLE_RATE); // fresh decoder state so a failed trial can't leak into the next
    let result: 'ok' | 'wrong' | 'none' = 'none';
    for (let i = 0; i < captured.length && result === 'none'; i += CHUNK) {
      const frames = modem.pushSamples(captured.subarray(i, i + CHUNK));
      if (frames.length === 0) continue;
      const match = frames.some((f) => f.length === len && f.every((b, k) => b === payload[k]));
      result = match ? 'ok' : 'wrong';
      if (match) latencySum += (i + CHUNK) / SAMPLE_RATE - leadIn - airtime;
    }
    if (result === 'ok') ok++;
    else if (result === 'wrong') wrong++;
    else none++;
  }
  return { ok, wrong, none, airtime, latency: ok ? latencySum / ok : NaN };
}

const pct = (r: CellResult) => {
  const s = `${Math.round((100 * r.ok) / TRIALS)}%`;
  return r.wrong ? `${s} (${r.wrong}w)` : s;
};

function table(title: string, note: string, colHeader: string, cols: string[], rows: [string, CellResult[]][]): void {
  console.log(`\n### ${title}\n\n${note}\n`);
  console.log(`| ${colHeader} | ${cols.join(' | ')} |`);
  console.log(`|---|${cols.map(() => '---').join('|')}|`);
  for (const [name, cells] of rows) console.log(`| ${name} | ${cells.map(pct).join(' | ')} |`);
}

const LIVING_ROOM: ChannelConfig = { device: 'phone', rt60: 0.4, drrDb: 0, snrDb: 10, noise: 'pink', gainDb: 0, driftPpm: 50 };
const SNRS = [10, 0, -5, -10, -15, -20];
const t0 = performance.now();
let seed = 1;
const run = (id: string) => !ONLY || ONLY.includes(id);

console.log(`# Channel simulator results\n\n${TRIALS} trials per cell. Cells: frame success rate; "(Nw)" = N trials decoded *wrong* data without error.`);

if (run('A')) {
  table(
    'A. SNR sweep, white noise, ideal speaker/mic, no reverb',
    '32-byte payload. Broadband SNR in dB.',
    'protocol \\ SNR',
    SNRS.map(String),
    PROTOCOLS.map((p) => [p, SNRS.map((snr) => runCell(p, 32, { ...CLEAN, snrDb: snr }, seed++))]),
  );
}

if (run('B')) {
  table(
    'B. SNR sweep, "living room"',
    '32-byte payload. Phone speaker/mic (17.5 kHz roll-off), RT60 0.4 s, DRR 0 dB, pink noise, 50 ppm drift.',
    'protocol \\ SNR',
    SNRS.map(String),
    PROTOCOLS.map((p) => [p, SNRS.map((snr) => runCell(p, 32, { ...LIVING_ROOM, snrDb: snr }, seed++))]),
  );
}

if (run('C')) {
  const devices: DeviceProfile[] = ['flat', 'good', 'phone', 'cheap'];
  const protos: ProtocolId[] = ['audible-fast', 'audible-fastest', 'ultrasound-fast', 'ultrasound-fastest'];
  table(
    'C. Speaker/mic frequency response',
    '32-byte payload, living room at 10 dB SNR. Low-pass corner: good 19.5 kHz, phone 17.5 kHz, cheap 14 kHz.',
    'protocol \\ device',
    devices,
    protos.map((p) => [p, devices.map((d) => runCell(p, 32, { ...LIVING_ROOM, device: d }, seed++))]),
  );
}

if (run('D')) {
  const rooms: [string, number, number][] = [['0.2 s', 0.2, 3], ['0.4 s', 0.4, 0], ['0.8 s', 0.8, -3], ['0.8 s far', 0.8, -9]];
  const protos: ProtocolId[] = ['audible-normal', 'audible-fast', 'audible-fastest', 'ultrasound-fast'];
  table(
    'D. Reverb',
    '32-byte payload, phone device, 20 dB pink SNR. Columns: RT60 (DRR +3, 0, -3, -9 dB).',
    'protocol \\ RT60',
    rooms.map((r) => r[0]),
    protos.map((p) => [p, rooms.map(([, rt60, drr]) => runCell(p, 32, { ...LIVING_ROOM, snrDb: 20, rt60, drrDb: drr }, seed++))]),
  );
}

if (run('E')) {
  // Payload length: is a full 140-byte frame worth it, or are shorter frames more robust per byte?
  const lens = [16, 32, 64, 100, 140];
  for (const snr of [0, -10]) {
    console.log(`\n### E. Payload length, living room at ${snr} dB SNR\n`);
    console.log('Goodput = success rate × payload bytes / airtime.\n');
    console.log('| protocol | len | airtime | success | goodput (B/s) | decode − airtime |');
    console.log('|---|---|---|---|---|---|');
    for (const p of ['audible-fast', 'audible-fastest'] as ProtocolId[]) {
      for (const len of lens) {
        const r = runCell(p, len, { ...LIVING_ROOM, snrDb: snr }, seed++);
        const goodput = ((r.ok / TRIALS) * len) / r.airtime;
        console.log(`| ${p} | ${len} | ${r.airtime.toFixed(2)} s | ${pct(r)} | ${goodput.toFixed(1)} | ${Number.isNaN(r.latency) ? '–' : r.latency.toFixed(2) + ' s'} |`);
      }
    }
  }
}

console.log(`\n_${((performance.now() - t0) / 1000).toFixed(0)} s total_`);
