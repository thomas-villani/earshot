// How much does deflate-raw save on realistic short messages?
const samples: [string, string][] = [
  ['short text', 'meet you at the front door in 5'],
  ['url', 'https://thomas-villani.github.io/earshot/'],
  ['long url', 'https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2944813,17z/data=!3m1!4b1'],
  ['contact json', JSON.stringify({ n: 'Ada Lovelace', p: '+44 20 7946 0000', e: 'ada.lovelace@example.com', o: 'Analytical Engines Ltd' })],
  ['wifi', 'WIFI:T:WPA;S:Villani-Home-5G;P:correct horse battery staple;;'],
  ['prompt', JSON.stringify({ prompt: 'Summarize the key points of this meeting and draft a follow-up email to the team.' })],
  ['paragraph', 'Earshot sends data between nearby phones using sound. No app, no install, no server. Open the page on two phones, tap listen on one and send on the other. It works best with the volume turned up and the phones within a few meters of each other.'],
];
for (const [name, s] of samples) {
  const raw = new TextEncoder().encode(s);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  console.log(`${name.padEnd(14)} ${String(raw.length).padStart(4)} B -> deflate ${String(z.length).padStart(4)} B (${z.length < raw.length ? '-' : '+'}${Math.abs(Math.round(100 * (1 - z.length / raw.length)))}%)`);
}
export {};
