// v2 milestone 1: connect two RTCPeerConnections in one page using only the compact SDP bytes.
// Results also land on window.labResults so a headless browser can read them.
import { acceptOffer, applyAnswer, createOffer, waitForOpen, type GatherOptions } from '../src/rtc/peer';
import { buildSdp } from '../src/rtc/sdp-compact';

interface Result {
  scenario: string;
  ok: boolean;
  offerBytes: number;
  answerBytes: number;
  offerGatherMs: number;
  answerGatherMs: number;
  connectMs: number;
  echo: string;
  path: string;
  offerCandidates: string[];
  answerCandidates: string[];
}

const scenarios: { name: string; offer: GatherOptions; answer: GatherOptions }[] = [
  { name: 'full (both sides carry candidates)', offer: {}, answer: {} },
  { name: 'answer without candidates (peer-reflexive)', offer: {}, answer: { omitCandidates: true } },
  { name: 'tight budget: 80 B per side', offer: { maxBytes: 80 }, answer: { maxBytes: 80 } },
];

const $ = (id: string) => document.getElementById(id)!;
const results: Result[] = [];
(window as unknown as { labResults: Result[] }).labResults = results;

async function selectedPath(pc: RTCPeerConnection): Promise<string> {
  const stats = await pc.getStats();
  let pair: any;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair) return '?';
  const l = stats.get(pair.localCandidateId);
  const r = stats.get(pair.remoteCandidateId);
  return `${l?.candidateType} ${l?.address ?? ''} → ${r?.candidateType} ${r?.address ?? ''}`;
}

async function run(name: string, offerOpts: GatherOptions, answerOpts: GatherOptions): Promise<Result> {
  const sessionId = crypto.getRandomValues(new Uint32Array(1))[0];
  const a = await createOffer(sessionId, offerOpts);
  // Only these bytes cross over, exactly as they would through the air.
  const b = await acceptOffer(a.bytes.slice(), answerOpts);
  if (!b) throw new Error('offer did not decode');
  const t0 = performance.now();
  if (!(await applyAnswer(a, b.bytes.slice()))) throw new Error('answer rejected');
  const open = (await Promise.all([waitForOpen(a.channel, 10000), waitForOpen(b.channel, 10000)])).every(Boolean);
  const connectMs = performance.now() - t0;
  let echo = 'channel never opened';
  if (open) {
    echo = await new Promise<string>((resolve) => {
      b.channel.onmessage = (e) => b.channel.send(`echo:${e.data}`);
      a.channel.onmessage = (e) => resolve(String(e.data));
      a.channel.send('hello from A');
      setTimeout(() => resolve('no echo'), 3000);
    });
  }
  const path = open ? await selectedPath(a.pc) : '-';
  $('detail').textContent = `compact offer (${a.bytes.length} B): ${Array.from(a.bytes, (x) => x.toString(16).padStart(2, '0')).join(' ')}\n\nrebuilt:\n${buildSdp(a.compact)}`;
  const fmt = (c: typeof a.compact) => c.candidates.map((x) => `${x.type} ${x.address}:${x.port}`);
  const r: Result = {
    scenario: name,
    ok: open && echo === 'echo:hello from A',
    offerBytes: a.bytes.length,
    answerBytes: b.bytes.length,
    offerGatherMs: Math.round(a.gatherMs),
    answerGatherMs: Math.round(b.gatherMs),
    connectMs: Math.round(connectMs),
    echo,
    path,
    offerCandidates: fmt(a.compact),
    answerCandidates: fmt(b.compact),
  };
  a.pc.close();
  b.pc.close();
  return r;
}

function show(r: Result): void {
  const row = document.createElement('tr');
  const cells = [r.scenario, r.offerBytes, r.answerBytes, `${r.offerGatherMs} / ${r.answerGatherMs}`, r.connectMs, r.echo, r.path];
  for (const c of cells) row.append(Object.assign(document.createElement('td'), { textContent: String(c) }));
  row.firstElementChild!.className = r.ok ? 'ok' : 'bad';
  $('results').querySelector('tbody')!.append(row);
}

async function runAll(): Promise<Result[]> {
  for (const s of scenarios) {
    const r = await run(s.name, s.offer, s.answer).catch((e) => ({ scenario: s.name, ok: false, echo: String(e) }) as Result);
    results.push(r);
    show(r);
  }
  return results;
}

$('run').onclick = () => void runAll();
$('mic').onclick = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
  $('mic').textContent = 'Mic granted';
};
(window as unknown as { runAll: typeof runAll }).runAll = runAll;
