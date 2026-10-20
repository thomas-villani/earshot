// Receiver cards. All content is untrusted: rendered as text, and every action needs an explicit tap.
import type { Message } from '../framing/message';
import { compact, flash, h } from './dom';
import { toVCard } from './vcard';

const canShare = () => typeof navigator.share === 'function';

function copyButton(label: string, text: string): HTMLButtonElement {
  const btn: HTMLButtonElement = h('button', {
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        flash(btn, 'Copied ✓');
      } catch {
        flash(btn, 'Copy failed');
      }
    },
  }, label);
  return btn;
}

function shareButton(label: string, data: ShareData): HTMLButtonElement | null {
  if (!canShare()) return null;
  return h('button', {
    onclick: async () => {
      try {
        await navigator.share(data);
      } catch {
        // user cancelled the share sheet
      }
    },
  }, label);
}

function contactActions(c: Extract<Message, { type: 'contact' }>['contact']): HTMLElement[] {
  const vcf = toVCard(c);
  const filename = (c.n.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'contact') + '.vcf';
  const file = new File([vcf], filename, { type: 'text/vcard' });
  const actions: HTMLElement[] = [
    // Android offers "Import to Contacts" on the downloaded file; iOS shows a contact preview.
    h('a', { class: 'button', href: URL.createObjectURL(file), download: filename }, 'Add to contacts'),
  ];
  if (navigator.canShare?.({ files: [file] })) {
    const share = shareButton('Share', { files: [file] });
    if (share) actions.push(share);
  }
  actions.push(copyButton('Copy', [c.n, c.p, c.e, c.o].filter(Boolean).join('\n')));
  return actions;
}

function body(msg: Message): { label: string; content: HTMLElement[]; actions: (HTMLElement | null)[] } {
  switch (msg.type) {
    case 'text':
      return {
        label: 'Text',
        content: [h('p', { class: 'text' }, msg.text)],
        actions: [copyButton('Copy', msg.text), shareButton('Share', { text: msg.text })],
      };
    case 'url':
      return {
        label: 'Link',
        content: [h('p', { class: 'url' }, msg.url)],
        actions: [
          // decodeMessage only produces URL cards for http(s), so this can't be javascript: etc.
          h('a', { class: 'button primary', href: msg.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open'),
          copyButton('Copy', msg.url),
          shareButton('Share', { url: msg.url }),
        ],
      };
    case 'contact': {
      const c = msg.contact;
      return {
        label: 'Contact',
        content: [
          h('p', { class: 'name' }, c.n),
          ...[c.p, c.e, c.o].filter((v): v is string => !!v).map((v) => h('p', { class: 'detail' }, v)),
        ],
        actions: contactActions(c),
      };
    }
    case 'wifi': {
      const w = msg.wifi;
      const pw = h('span', { class: 'secret' }, '•'.repeat(Math.min(w.password.length, 12)));
      const reveal: HTMLButtonElement = h('button', {
        class: 'small',
        onclick: () => {
          pw.textContent = w.password;
          reveal.remove();
        },
      }, 'Show');
      return {
        label: 'Wi-Fi',
        content: compact<HTMLElement>([
          h('p', { class: 'name' }, w.ssid),
          h('p', { class: 'detail' }, `${w.auth === 'nopass' ? 'Open network' : w.auth}${w.hidden ? ' · hidden' : ''}`),
          w.auth !== 'nopass' ? h('p', { class: 'detail' }, 'Password: ', pw, ' ', reveal) : null,
        ]),
        actions: [w.auth !== 'nopass' ? copyButton('Copy password', w.password) : null, copyButton('Copy name', w.ssid)],
      };
    }
    case 'prompt': {
      const full = msg.context ? `${msg.prompt}\n\n${msg.context}` : msg.prompt;
      return {
        label: 'Assistant prompt',
        content: compact<HTMLElement>([h('p', { class: 'text' }, msg.prompt), msg.context ? h('p', { class: 'detail' }, msg.context) : null]),
        // The share sheet lists the assistant apps installed on the device.
        actions: [shareButton('Send to assistant…', { text: full }), copyButton('Copy', full)],
      };
    }
    case 'unknown':
      return {
        label: `Unknown type 0x${msg.code.toString(16).padStart(2, '0')}`,
        content: [h('p', { class: 'hex' }, Array.from(msg.payload, (b) => b.toString(16).padStart(2, '0')).join(' '))],
        actions: [],
      };
  }
}

export interface CardHandle {
  el: HTMLElement;
  setCount(n: number): void;
}

export function renderCard(msg: Message, nonce: number): CardHandle {
  const { label, content, actions } = body(msg);
  const meta = h('span', { class: 'meta' });
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sender = `#${nonce.toString(16).padStart(4, '0')}`;
  const setCount = (n: number) => (meta.textContent = `${time} · from ${sender}${n > 1 ? ` · heard ${n}×` : ''}`);
  setCount(1);
  const el = h(
    'article',
    { class: `card card-${msg.type}` },
    h('header', {}, h('span', { class: 'label' }, label), meta),
    ...content,
    h('div', { class: 'actions' }, ...actions),
  );
  return { el, setCount };
}
