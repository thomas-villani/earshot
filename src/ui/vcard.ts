import type { Contact } from '../framing/message';

/** vCard 3.0 text for a contact. Values come from the air, so they're escaped and stripped of line breaks. */
export function toVCard(c: Contact): string {
  const esc = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/([\\;,])/g, '\\$1');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.n)}`, `N:${esc(c.n)};;;;`];
  if (c.p) lines.push(`TEL;TYPE=CELL:${esc(c.p)}`);
  if (c.e) lines.push(`EMAIL:${esc(c.e)}`);
  if (c.o) lines.push(`ORG:${esc(c.o)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}
