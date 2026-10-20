// Acoustic channel simulator: models what happens between one device's speaker and another's mic.
import { convolve } from './fft';
import type { Rng } from './rng';

export const SAMPLE_RATE = 48000;

/** Speaker+mic frequency response, as a low-pass corner. Phones roll off hard near the top of the band. */
export type DeviceProfile = 'flat' | 'good' | 'phone' | 'cheap';
const LOWPASS_HZ: Record<DeviceProfile, number | null> = { flat: null, good: 19500, phone: 17500, cheap: 14000 };

export interface ChannelConfig {
  device: DeviceProfile;
  /** Room reverb time in seconds; 0 disables reverb. */
  rt60: number;
  /** Direct-to-reverberant energy ratio in dB (higher = closer to the speaker). */
  drrDb: number;
  /** Broadband SNR in dB of the *transmitted* signal vs ambient noise; Infinity disables noise. */
  snrDb: number;
  noise: 'white' | 'pink';
  /** Gain applied at the mic before clipping to [-1, 1]. */
  gainDb: number;
  /** Receiver clock offset relative to the sender, in parts per million. */
  driftPpm: number;
}

export const CLEAN: ChannelConfig = { device: 'flat', rt60: 0, drrDb: 0, snrDb: Infinity, noise: 'white', gainDb: 0, driftPpm: 0 };

export function power(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s / x.length;
}

/** RBJ cookbook biquad, applied in place. */
function biquad(x: Float32Array, type: 'lowpass' | 'highpass', f0: number, q = Math.SQRT1_2): void {
  const w = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  const b0 = type === 'lowpass' ? (1 - c) / 2 : (1 + c) / 2;
  const b1 = type === 'lowpass' ? 1 - c : -(1 + c);
  const a0 = 1 + alpha;
  const nb0 = b0 / a0, nb1 = b1 / a0, nb2 = b0 / a0, na1 = (-2 * c) / a0, na2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = nb0 * x[i] + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/** 4th-order Butterworth low-pass (two cascaded biquads): ~24 dB/octave past the corner. */
export function lowpass(x: Float32Array, f0: number): Float32Array {
  const y = Float32Array.from(x);
  biquad(y, 'lowpass', f0, 0.5412);
  biquad(y, 'lowpass', f0, 1.3066);
  return y;
}

export function highpass(x: Float32Array, f0: number): Float32Array {
  const y = Float32Array.from(x);
  biquad(y, 'highpass', f0);
  return y;
}

/** Synthetic room impulse response: unit direct path plus an exponentially decaying noise tail. */
export function roomImpulse(rt60: number, drrDb: number, rng: Rng): Float32Array {
  const len = Math.ceil(rt60 * SAMPLE_RATE);
  const h = new Float32Array(len);
  const predelay = Math.round(0.003 * SAMPLE_RATE); // first reflections arrive a few ms after the direct sound
  const decay = Math.log(1000) / (rt60 * SAMPLE_RATE); // amplitude falls 60 dB over rt60
  let tailEnergy = 0;
  for (let i = predelay; i < len; i++) {
    h[i] = rng.gaussian() * Math.exp(-decay * i);
    tailEnergy += h[i] * h[i];
  }
  const scale = Math.sqrt(10 ** (-drrDb / 10) / tailEnergy);
  for (let i = predelay; i < len; i++) h[i] *= scale;
  h[0] = 1;
  return h;
}

export function noise(n: number, kind: 'white' | 'pink', rng: Rng): Float32Array {
  const out = new Float32Array(n);
  // Paul Kellet's refined pink filter
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.gaussian();
    if (kind === 'white') {
      out[i] = w;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return out;
}

/** Resample by `ratio` output samples per input sample (linear interpolation). */
export function resample(x: Float32Array, ratio: number): Float32Array {
  const n = Math.floor(x.length * ratio);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ratio, i0 = Math.floor(t), f = t - i0;
    y[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f;
  }
  return y;
}

/**
 * Run a transmitted waveform through the channel. The result includes `leadIn` seconds of
 * (noisy) silence before and `tail` seconds after, as a listening mic would capture.
 */
export function applyChannel(wave: Float32Array, cfg: ChannelConfig, rng: Rng, leadIn = 0.3, tail = 1.0): Float32Array {
  let x = wave;
  const lp = LOWPASS_HZ[cfg.device];
  if (lp) x = lowpass(x, lp);
  if (cfg.rt60 > 0) x = convolve(x, roomImpulse(cfg.rt60, cfg.drrDb, rng));

  const pre = Math.round(leadIn * SAMPLE_RATE);
  const total = pre + x.length + Math.round(tail * SAMPLE_RATE);
  let y = new Float32Array(total);
  y.set(x, pre);

  if (Number.isFinite(cfg.snrDb)) {
    // SNR is relative to the transmitted signal, so a speaker that can't reproduce the band
    // (or a lossy room) costs SNR, as it would against real ambient noise.
    const n = noise(total, cfg.noise, rng);
    const scale = Math.sqrt(power(wave) / 10 ** (cfg.snrDb / 10) / power(n));
    for (let i = 0; i < total; i++) y[i] += n[i] * scale;
  }

  if (cfg.device !== 'flat') y = highpass(y, 200); // small mics don't hear much low end

  const g = 10 ** (cfg.gainDb / 20);
  for (let i = 0; i < total; i++) y[i] = Math.max(-1, Math.min(1, y[i] * g));

  if (cfg.driftPpm !== 0) y = resample(y, 1 + cfg.driftPpm * 1e-6);
  return y;
}
