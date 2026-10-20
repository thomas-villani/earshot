export type ProtocolId =
  | 'audible-normal'
  | 'audible-fast'
  | 'audible-fastest'
  | 'ultrasound-normal'
  | 'ultrasound-fast'
  | 'ultrasound-fastest'
  | 'dt-fast'
  | 'dt-fastest';

export const PROTOCOLS: readonly ProtocolId[] = [
  'audible-normal',
  'audible-fast',
  'audible-fastest',
  'ultrasound-normal',
  'ultrasound-fast',
  'ultrasound-fastest',
  'dt-fast',
  'dt-fastest',
];

/** Protocols in different bands can transmit simultaneously (see NOTES.md, dual-band spike). DT overlaps audible. */
export const BAND_OF: Record<ProtocolId, 'audible' | 'ultrasound'> = {
  'audible-normal': 'audible',
  'audible-fast': 'audible',
  'audible-fastest': 'audible',
  'ultrasound-normal': 'ultrasound',
  'ultrasound-fast': 'ultrasound',
  'ultrasound-fastest': 'ultrasound',
  'dt-fast': 'audible',
  'dt-fastest': 'audible',
};

export interface Modem {
  readonly maxFrameBytes: number;
  readonly sampleRate: number;
  encode(frame: Uint8Array, protocol: ProtocolId): Float32Array;
  /** Encode frames on different bands into one waveform that plays them simultaneously. */
  encodeParallel(items: { frame: Uint8Array; protocol: ProtocolId }[]): Float32Array;
  /** Feed captured samples of any length; returns any frames decoded so far (from every band). */
  pushSamples(samples: Float32Array): Uint8Array[];
  setSampleRate(rate: number): void;
}
