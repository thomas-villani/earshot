type Child = Node | string | null | undefined | false;
type Props = { class?: string; [attr: string]: unknown };

/**
 * Tiny element builder. Strings become text nodes, never HTML, so decoded data can't inject markup.
 * Props starting with "on" are event listeners; everything else is set as a property if one exists, else an attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Brief "done" feedback on a button, then restore its label. */
export function flash(btn: HTMLElement, label: string): void {
  const orig = btn.textContent;
  btn.textContent = label;
  setTimeout(() => (btn.textContent = orig), 1500);
}

/** Drop null/undefined/false entries from a list of optional elements. */
export function compact<T>(items: (T | null | undefined | false)[]): T[] {
  return items.filter(Boolean) as T[];
}
