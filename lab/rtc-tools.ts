// Helpers shared by the RTC lab pages: address masking for shareable reports, the selected path,
// and ping / throughput / chat over an open data channel.
import type { CompactSdp } from '../src/rtc/sdp-compact';

export function maskAddress(a: string): string {
  if (a.endsWith('.local')) return 'mdns';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) return a; // private LAN: useful, not identifying
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return 'cgnat4'; // 100.64/10 carrier NAT
  if (a.includes('.')) return 'public4';
  if (/^fe80:/i.test(a)) return 'linklocal6';
  if (/^f[cd]/i.test(a)) return 'ula6';
  return a.includes(':') ? 'public6' : '?';
}

export const describe = (c: CompactSdp) => c.candidates.map((x) => `${x.type}:${maskAddress(x.address)}`).join(', ') || '(none)';

export async function selectedPath(pc: RTCPeerConnection): Promise<string> {
  const stats = await pc.getStats();
  let path = '?';
  stats.forEach((s) => {
    if (s.type !== 'transport' || !s.selectedCandidatePairId) return;
    const pair = stats.get(s.selectedCandidatePairId);
    const l = stats.get(pair.localCandidateId);
    const r = stats.get(pair.remoteCandidateId);
    path = `${l?.candidateType} ${maskAddress(l?.address ?? '')} → ${r?.candidateType} ${maskAddress(r?.address ?? '')} (${l?.protocol})`;
  });
  return path;
}

const TOTAL = 8 * 1024 * 1024;

/** Protocol on the channel: "ping"/"pong", "tp-start:N" + binary + "tp-done:ms", "chat:text". */
export class ChannelTools {
  onChat: (text: string) => void = () => {};
  private pongWaiter?: () => void;
  private tpExpect = 0;
  private tpGot = 0;
  private tpFirst = 0;
  private tpDone?: (ms: number) => void;

  constructor(
    private ch: RTCDataChannel,
    private log: (msg: string) => void,
    private chunkBytes = 16 * 1024,
  ) {
    ch.binaryType = 'arraybuffer';
    ch.addEventListener('message', (e) => this.onMessage(e));
  }

  async rtt(): Promise<void> {
    const rtts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      await new Promise<void>((resolve) => {
        this.pongWaiter = resolve;
        this.ch.send('ping');
      });
      rtts.push(performance.now() - start);
    }
    rtts.sort((a, b) => a - b);
    this.log(`rtt ms: median ${rtts[2].toFixed(1)} (min ${rtts[0].toFixed(1)}, max ${rtts[4].toFixed(1)})`);
  }

  chat(text: string): void {
    this.ch.send(`chat:${text}`);
  }

  /** Sends 8 MB with backpressure and logs the rate once the other side confirms it all arrived. */
  async throughput(): Promise<void> {
    const ch = this.ch;
    const chunk = new Uint8Array(this.chunkBytes);
    crypto.getRandomValues(chunk);
    ch.bufferedAmountLowThreshold = 1024 * 1024;
    const done = new Promise<number>((r) => (this.tpDone = r));
    ch.send(`tp-start:${TOTAL}`);
    const start = performance.now();
    for (let sent = 0; sent < TOTAL; sent += chunk.length) {
      if (ch.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => ch.addEventListener('bufferedamountlow', r, { once: true }));
      ch.send(chunk);
    }
    await done;
    const ms = performance.now() - start;
    this.log(`sent 8 MB in ${(ms / 1000).toFixed(2)} s = ${(TOTAL / 1e6 / (ms / 1000)).toFixed(1)} MB/s`);
  }

  private onMessage(e: MessageEvent): void {
    if (typeof e.data === 'string') {
      if (e.data === 'ping') this.ch.send('pong');
      else if (e.data === 'pong') this.pongWaiter?.();
      else if (e.data.startsWith('chat:')) this.onChat(e.data.slice(5));
      else if (e.data.startsWith('tp-start:')) {
        this.tpExpect = Number(e.data.slice(9));
        this.tpGot = 0;
        this.tpFirst = 0;
      } else if (e.data.startsWith('tp-done:')) this.tpDone?.(Number(e.data.slice(8)));
      return;
    }
    if (!this.tpFirst) this.tpFirst = performance.now();
    this.tpGot += (e.data as ArrayBuffer).byteLength;
    if (this.tpGot >= this.tpExpect) {
      const ms = performance.now() - this.tpFirst;
      this.log(`received ${(this.tpGot / 1e6).toFixed(1)} MB at ${(this.tpGot / 1e6 / (ms / 1000)).toFixed(1)} MB/s`);
      this.ch.send(`tp-done:${ms}`);
    }
  }
}

/**
 * Every candidate pair ICE tried, with its STUN counters. Tells a blocked network (nothing
 * received from the other side) apart from a credentials problem (requests in, no responses).
 */
export async function candidatePairs(pc: RTCPeerConnection): Promise<string[]> {
  const stats = await pc.getStats();
  const out: string[] = [];
  stats.forEach((s) => {
    if (s.type !== 'candidate-pair') return;
    const l = stats.get(s.localCandidateId);
    const r = stats.get(s.remoteCandidateId);
    const end = (c: any) => `${c?.candidateType} ${maskAddress(c?.address ?? '')}`;
    out.push(`pair ${end(l)} → ${end(r)}: ${s.state}, requests sent ${s.requestsSent ?? 0} / received ${s.requestsReceived ?? 0}, responses received ${s.responsesReceived ?? 0} / sent ${s.responsesSent ?? 0}`);
  });
  return out.length ? out : ['no candidate pairs'];
}
