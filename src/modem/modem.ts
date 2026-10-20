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

export interface Modem {
  readonly maxFrameBytes: number;
  readonly sampleRate: number;
  encode(frame: Uint8Array, protocol: ProtocolId): Float32Array;
  /** Feed captured samples of any length; returns any frames decoded so far. */
  pushSamples(samples: Float32Array): Uint8Array[];
  setSampleRate(rate: number): void;
}
