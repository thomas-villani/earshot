import type { Message } from '../framing/message';

/** Sample received messages for UI work (dev server, URL hash #demo). */
export const demoMessages: Message[] = [
  { type: 'url', url: 'https://thomas-villani.github.io/earshot/' },
  { type: 'text', text: 'Meet you at the front door in 5 👋' },
  { type: 'contact', contact: { n: 'Ada Lovelace', p: '+44 20 7946 0000', e: 'ada@example.com', o: 'Analytical Engines' } },
  { type: 'wifi', wifi: { auth: 'WPA', ssid: 'Villani-Home-5G', password: 'correct horse battery staple' } },
  { type: 'prompt', prompt: 'Summarize the key points of this meeting and draft a follow-up email.' },
  { type: 'unknown', code: 0x7f, payload: new Uint8Array([1, 2, 3, 250]) },
];
