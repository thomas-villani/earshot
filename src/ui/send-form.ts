import { detectMessage, isWebUrl, type Message, type Wifi } from '../framing/message';
import { compact, h } from './dom';

export type SendType = 'auto' | 'text' | 'url' | 'contact' | 'wifi' | 'prompt';

export const SEND_TYPES: [SendType, string][] = [
  ['auto', 'Auto'],
  ['text', 'Text'],
  ['url', 'Link'],
  ['contact', 'Contact'],
  ['wifi', 'Wi-Fi'],
  ['prompt', 'Prompt'],
];

const TYPE_NAMES: Record<Message['type'], string> = {
  text: 'text',
  url: 'link',
  contact: 'contact',
  wifi: 'Wi-Fi',
  prompt: 'prompt',
  unknown: 'unknown',
};

// Contact Picker API (Android Chrome); not in lib.dom yet
interface ContactsManager {
  select(props: string[], opts?: { multiple?: boolean }): Promise<{ name?: string[]; tel?: string[]; email?: string[] }[]>;
}
const contactsApi = (navigator as Navigator & { contacts?: ContactsManager }).contacts;

export type FormResult = { message: Message; detected?: string } | { error: string };

export class SendForm {
  type: SendType = 'auto';
  private fields: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {};

  constructor(
    private container: HTMLElement,
    private onChange: () => void,
  ) {
    this.render();
  }

  setType(t: SendType): void {
    // carry free text across the text-like types
    const carry = (this.fields.body as HTMLTextAreaElement | undefined)?.value;
    this.type = t;
    this.render();
    if (carry && this.fields.body) this.fields.body.value = carry;
    this.onChange();
  }

  read(): FormResult {
    const v = (k: string) => this.fields[k]?.value ?? '';
    switch (this.type) {
      case 'auto': {
        if (!v('body').trim()) return { error: '' };
        const message = detectMessage(v('body'));
        return { message, detected: TYPE_NAMES[message.type] };
      }
      case 'text':
        return v('body') ? { message: { type: 'text', text: v('body') } } : { error: '' };
      case 'url': {
        const url = v('body').trim();
        if (!url) return { error: '' };
        return isWebUrl(url) ? { message: { type: 'url', url } } : { error: 'Links must start with http:// or https://' };
      }
      case 'contact': {
        const n = v('n').trim();
        if (!n) return { error: v('p') || v('e') ? 'A name is required' : '' };
        return { message: { type: 'contact', contact: { n, p: v('p').trim() || undefined, e: v('e').trim() || undefined, o: v('o').trim() || undefined } } };
      }
      case 'wifi': {
        const ssid = v('ssid');
        if (!ssid) return { error: '' };
        const auth = v('auth') as Wifi['auth'];
        const wifi: Wifi = { auth, ssid, password: auth === 'nopass' ? '' : v('password') };
        if ((this.fields.hidden as HTMLInputElement).checked) wifi.hidden = true;
        return { message: { type: 'wifi', wifi } };
      }
      case 'prompt': {
        const prompt = v('body').trim();
        if (!prompt) return { error: '' };
        const context = v('context').trim();
        return { message: context ? { type: 'prompt', prompt, context } : { type: 'prompt', prompt } };
      }
    }
  }

  private render(): void {
    this.fields = {};
    const input = (key: string, label: string, attrs: Record<string, unknown> = {}) => {
      const el = h('input', { oninput: this.onChange, ...attrs });
      this.fields[key] = el;
      return h('label', {}, h('span', {}, label), el);
    };
    const area = (key: string, placeholder: string, rows = 4) => {
      const el = h('textarea', { rows, placeholder, oninput: this.onChange });
      this.fields[key] = el;
      return el;
    };

    let content: HTMLElement[];
    switch (this.type) {
      case 'auto':
        content = [area('body', 'Type a message or paste a link…')];
        break;
      case 'text':
        content = [area('body', 'Message')];
        break;
      case 'url':
        content = [area('body', 'https://…', 2)];
        break;
      case 'prompt':
        content = [area('body', 'Prompt for an AI assistant'), area('context', 'Optional context', 2)];
        break;
      case 'contact':
        content = compact<HTMLElement>([
          contactsApi ? h('button', { type: 'button', onclick: () => this.pickContact() }, 'Pick from my contacts') : null,
          input('n', 'Name', { autocomplete: 'name' }),
          input('p', 'Phone', { type: 'tel', autocomplete: 'tel' }),
          input('e', 'Email', { type: 'email', autocomplete: 'email' }),
          input('o', 'Organization', { autocomplete: 'organization' }),
        ]);
        break;
      case 'wifi': {
        const auth = h('select', { onchange: this.onChange }, new Option('WPA/WPA2/WPA3', 'WPA'), new Option('WEP', 'WEP'), new Option('None (open)', 'nopass'));
        this.fields.auth = auth;
        const hidden = h('input', { type: 'checkbox', onchange: this.onChange });
        this.fields.hidden = hidden;
        content = [
          input('ssid', 'Network name'),
          input('password', 'Password', { autocomplete: 'off' }),
          h('label', {}, h('span', {}, 'Security'), auth),
          h('label', { class: 'check' }, hidden, h('span', {}, 'Hidden network')),
        ];
        break;
      }
    }
    this.container.replaceChildren(...content);
  }

  private async pickContact(): Promise<void> {
    try {
      const [c] = await contactsApi!.select(['name', 'tel', 'email'], { multiple: false });
      if (!c) return;
      if (c.name?.[0]) this.fields.n.value = c.name[0];
      if (c.tel?.[0]) this.fields.p.value = c.tel[0];
      if (c.email?.[0]) this.fields.e.value = c.email[0];
      this.onChange();
    } catch {
      // picker dismissed
    }
  }
}
