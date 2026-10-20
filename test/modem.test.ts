import { beforeAll, describe, expect, it } from 'vitest';
import { GgwaveModem } from '../src/modem/ggwave-modem';
import { PROTOCOLS } from '../src/modem/modem';

let modem: GgwaveModem;
beforeAll(async () => {
  modem = await GgwaveModem.create();
});

function roundTrip(frame: Uint8Array, chunk: number, protocol = 'audible-fastest' as const): Uint8Array[] {
  const wave = modem.encode(frame, protocol);
  const padded = new Float32Array(wave.length + 48000);
  padded.set(wave, 4800);
  const out: Uint8Array[] = [];
  for (let i = 0; i < padded.length; i += chunk) out.push(...modem.pushSamples(padded.subarray(i, i + chunk)));
  return out;
}

describe('GgwaveModem', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const frame of [all.subarray(0, 140), all.subarray(116), new Uint8Array(8)]) {
      expect(roundTrip(frame, 128)).toEqual([frame]);
    }
  });

  it.each([128, 300, 1024, 4096])('decodes from %i-sample chunks', (chunk) => {
    const frame = new TextEncoder().encode('hello earshot');
    expect(roundTrip(frame, chunk)).toEqual([frame]);
  });

  it.each(PROTOCOLS)('round-trips with %s', (protocol) => {
    const frame = new TextEncoder().encode('proto');
    expect(roundTrip(frame, 128, protocol as any)).toEqual([frame]);
  });

  it('decodes simultaneous audible + ultrasound frames from one mixed waveform', () => {
    const a = new TextEncoder().encode('audible lane frame');
    const u = new TextEncoder().encode('ultrasound lane frame');
    const wave = modem.encodeParallel([
      { frame: a, protocol: 'audible-fast' },
      { frame: u, protocol: 'ultrasound-fast' },
    ]);
    const padded = new Float32Array(wave.length + 48000);
    padded.set(wave, 2000);
    const got = modem.pushSamples(padded).map((f) => new TextDecoder().decode(f));
    expect(got.sort()).toEqual(['audible lane frame', 'ultrasound lane frame']);
  });

  it('refuses to mix two frames in the same band', () => {
    expect(() =>
      modem.encodeParallel([
        { frame: new Uint8Array(8), protocol: 'audible-fast' },
        { frame: new Uint8Array(8), protocol: 'dt-fast' },
      ]),
    ).toThrow();
  });

  it('rejects frames over 140 bytes rather than truncating', () => {
    expect(() => modem.encode(new Uint8Array(141), 'audible-fast')).toThrow(RangeError);
    expect(() => modem.encode(new Uint8Array(0), 'audible-fast')).toThrow(RangeError);
  });

  it('survives repeated setSampleRate without exhausting ggwave instances', () => {
    for (let i = 0; i < 10; i++) modem.setSampleRate(48000);
    // 2-3 byte payloads are unreliable in ggwave even on clean loopback (see NOTES.md); real frames are >= 8 bytes
    const frame = new TextEncoder().encode('re-init ok');
    expect(roundTrip(frame, 128)).toEqual([frame]);
  });
});
