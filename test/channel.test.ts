import { describe, expect, it } from 'vitest';
import { applyChannel, CLEAN, highpass, lowpass, noise, power, resample, roomImpulse, SAMPLE_RATE } from './sim/channel';
import { convolve } from './sim/fft';
import { Rng } from './sim/rng';

const tone = (hz: number, seconds = 0.5) =>
  Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));
const db = (ratio: number) => 10 * Math.log10(ratio);

describe('fft convolve', () => {
  it('matches direct convolution', () => {
    const rng = new Rng(1);
    const x = Float32Array.from({ length: 300 }, () => rng.gaussian());
    const h = Float32Array.from({ length: 77 }, () => rng.gaussian());
    const y = convolve(x, h);
    expect(y.length).toBe(376);
    for (const k of [0, 50, 200, 375]) {
      let s = 0;
      for (let j = 0; j < h.length; j++) if (k - j >= 0 && k - j < x.length) s += x[k - j] * h[j];
      expect(y[k]).toBeCloseTo(s, 3);
    }
  });
});

describe('filters', () => {
  it('low-pass keeps the passband and attenuates an octave above the corner by >20 dB', () => {
    expect(db(power(lowpass(tone(4000), 16000)) / power(tone(4000)))).toBeGreaterThan(-0.5);
    expect(db(power(lowpass(tone(16000), 8000)) / power(tone(16000)))).toBeLessThan(-20);
  });

  it('high-pass removes low rumble', () => {
    expect(db(power(highpass(tone(50), 200)) / power(tone(50)))).toBeLessThan(-20);
    expect(db(power(highpass(tone(2000), 200)) / power(tone(2000)))).toBeGreaterThan(-0.5);
  });
});

describe('noise', () => {
  it('hits the target SNR', () => {
    const rng = new Rng(2);
    const sig = tone(3000, 1).map((v) => v * 0.1); // quiet enough that noise never clips
    for (const snr of [20, 0, -5]) {
      const out = applyChannel(sig, { ...CLEAN, snrDb: snr }, rng, 0, 0);
      const n = out.map((v, i) => v - sig[i]);
      expect(db(power(sig) / power(n))).toBeCloseTo(snr, 0);
    }
  });

  it('pink noise has more low-frequency energy than high', () => {
    const p = noise(SAMPLE_RATE, 'pink', new Rng(3));
    // 1/f: ~ln(500/20) vs ln(24000/8000), so roughly 3x
    expect(power(lowpass(p, 500))).toBeGreaterThan(2 * power(highpass(p, 8000)));
  });
});

describe('room impulse', () => {
  it('has a unit direct path, the requested DRR, and decays ~60 dB over rt60', () => {
    const h = roomImpulse(0.5, 3, new Rng(4));
    expect(h[0]).toBe(1);
    const tail = h.subarray(1);
    expect(db(1 / (power(tail) * tail.length))).toBeCloseTo(3, 1);
    const seg = (a: number, b: number) => power(h.subarray(Math.round(a * SAMPLE_RATE), Math.round(b * SAMPLE_RATE)));
    expect(db(seg(0.01, 0.06) / seg(0.44, 0.49))).toBeGreaterThan(45);
  });
});

describe('resample', () => {
  it('stretches by the given ratio', () => {
    expect(resample(tone(1000, 1), 44100 / 48000).length).toBe(44100);
  });
});

describe('applyChannel', () => {
  it('is reproducible for a given seed', () => {
    const cfg = { ...CLEAN, device: 'phone' as const, rt60: 0.3, snrDb: 10, noise: 'pink' as const, driftPpm: 100 };
    expect(applyChannel(tone(3000), cfg, new Rng(9))).toEqual(applyChannel(tone(3000), cfg, new Rng(9)));
  });

  it('clips at full scale', () => {
    const out = applyChannel(tone(1000), { ...CLEAN, gainDb: 20 }, new Rng(5));
    expect(out.every((v) => v >= -1 && v <= 1)).toBe(true);
  });
});
