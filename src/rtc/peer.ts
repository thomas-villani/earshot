// RTCPeerConnection setup around the compact SDP format. Signaling is whatever carries the bytes
// (in-page for the loopback lab, sound in milestone 3). See SPEC.md "Handshake flow".
import { buildSdp, decodeCompactSdp, encodeCompactSdp, ONE_FRAME_BYTES, parseSdp, selectCandidates, type CompactSdp } from './sdp-compact';

/** Public STUN only (no TURN): the one network dependency the ground rules allow. */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
};

/**
 * Both ends create the same pre-negotiated channel, so neither has to wait for `ondatachannel`
 * and the SDP stays identical in shape whichever side opens it.
 */
const CHANNEL: RTCDataChannelInit = { negotiated: true, id: 0, ordered: true };

export interface GatherOptions {
  /** Give up waiting for slow STUN after this long and use what has been gathered. */
  timeoutMs?: number;
  /** Byte budget for the compact blob (default: one frame). */
  maxBytes?: number;
  /**
   * Leave candidates out (the answerer can be found as peer-reflexive from its checks). Lab only:
   * if the offerer is backgrounded for ~15 s the answerer stops checking and nothing recovers.
   */
  omitCandidates?: boolean;
  /** Override RTC_CONFIG (e.g. no STUN, for testing host-only paths). */
  config?: RTCConfiguration;
}

export interface LocalSide {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  /** What actually goes over the air. */
  compact: CompactSdp;
  bytes: Uint8Array;
  gatherMs: number;
}

/** Once a public IPv4 (srflx) candidate is in, stop after this long without a new candidate. */
const SETTLE_MS = 300;

/**
 * Resolve once ICE gathering is complete, or `timeoutMs` passes, or a srflx IPv4 candidate has
 * arrived and nothing new has come in for SETTLE_MS. The last case matters: with mic permission,
 * Chrome gathers on every interface and STUN on the unreachable ones (VM adapters, some IPv6)
 * never answers, so "complete" can take the full timeout.
 */
export function waitForGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let haveSrflx = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(settle);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate?.type === 'srflx' && e.candidate.address?.includes('.')) haveSrflx = true;
      if (haveSrflx) {
        clearTimeout(settle);
        settle = setTimeout(done, SETTLE_MS);
      }
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

async function finishLocal(pc: RTCPeerConnection, channel: RTCDataChannel, sessionId: number, opts: GatherOptions, t0: number): Promise<LocalSide> {
  await waitForGathering(pc, opts.timeoutMs ?? 3000);
  const gatherMs = performance.now() - t0;
  let compact = selectCandidates(parseSdp(pc.localDescription!.sdp, sessionId), opts.maxBytes ?? ONE_FRAME_BYTES);
  if (opts.omitCandidates) compact = { ...compact, candidates: [] };
  return { pc, channel, compact, bytes: encodeCompactSdp(compact), gatherMs };
}

/** Sender side: new connection, gathered offer, compacted. */
export async function createOffer(sessionId: number, opts: GatherOptions = {}): Promise<LocalSide> {
  const t0 = performance.now();
  const pc = new RTCPeerConnection(opts.config ?? RTC_CONFIG);
  const channel = pc.createDataChannel('earshot', CHANNEL);
  await pc.setLocalDescription(await pc.createOffer());
  return finishLocal(pc, channel, sessionId, opts, t0);
}

/** Receiver side: take a compact offer off the air, answer it. Null if the bytes aren't an offer. */
export async function acceptOffer(offerBytes: Uint8Array, opts: GatherOptions = {}): Promise<LocalSide | null> {
  const offer = decodeCompactSdp(offerBytes);
  if (!offer || offer.setup !== 'actpass') return null;
  const t0 = performance.now();
  const pc = new RTCPeerConnection(opts.config ?? RTC_CONFIG);
  const channel = pc.createDataChannel('earshot', CHANNEL);
  await pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(offer) });
  await pc.setLocalDescription(await pc.createAnswer());
  return finishLocal(pc, channel, offer.sessionId, opts, t0);
}

/** Sender side: apply a compact answer. False if it isn't an answer to this session. */
export async function applyAnswer(local: LocalSide, answerBytes: Uint8Array): Promise<boolean> {
  const answer = decodeCompactSdp(answerBytes);
  if (!answer || answer.sessionId !== local.compact.sessionId || answer.setup === 'actpass') return false;
  await local.pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(answer) });
  return true;
}

export function waitForOpen(channel: RTCDataChannel, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (channel.readyState === 'open') return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    channel.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
}
