// Cards for the papers an answer names, set into the answer itself rather than
// under it. The answer is HTML drawn from Markdown, so the cards are placed in
// that HTML after it is drawn: either in place of a list item that is about one
// paper — the item's own words become the card's explanation — or as a row of
// cards after the section of the answer that named the papers. Their buttons
// carry the paper's title; the window listens for presses on them.

import { paperKey } from '../lib/assistant';
import type { Recommendation } from '../lib/assistant';

export type PaperLayout = 'inline' | 'sections' | 'end';

const LAYOUT_KEY = 'reader.assistant.paper-layout';

export function loadLayout(): PaperLayout {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === 'inline' || saved === 'sections' || saved === 'end') return saved;
  } catch {
    // Storage can be off; the default stands.
  }
  return 'inline';
}

export function saveLayout(layout: PaperLayout) {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Not kept, then; it still applies until the page is closed.
  }
}

const SEARCH_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M16.5 16.5 21 21"></path></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * One compact card: the number, who and when, and its two buttons on one
 * line; the title; then what it is for. `explain` is the answer's own words
 * about the paper, when it had some; `tag` is a short name it gave the paper.
 */
function card(paper: Recommendation, n: number, explain: Node[] | null, tag?: string): HTMLElement {
  const root = el('div', 'chat-card');
  root.dataset.paper = paper.title;
  const head = el('div', 'chat-card-head');
  head.append(el('span', 'chat-num', String(n)));
  const meta = [paper.authors ?? paper.label, paper.year, tag].filter(Boolean).join(' · ');
  head.append(el('span', 'chat-card-meta', meta));
  const find = el('button', 'btn sm chat-card-find');
  find.type = 'button';
  find.dataset.paper = paper.title;
  find.title = 'Find in Discover';
  find.innerHTML = `${SEARCH_SVG}<span>Find</span>`;
  const add = el('button', 'btn sm chat-card-add');
  add.type = 'button';
  add.dataset.paper = paper.title;
  head.append(find, add);
  root.append(head);

  const title = el('button', 'chat-card-title chat-card-find', paper.title);
  title.type = 'button';
  title.dataset.paper = paper.title;
  title.title = 'Find in Discover';
  root.append(title);

  if (explain?.length) {
    const why = el('div', 'chat-card-why');
    why.append(...explain);
    root.append(why);
  } else if (paper.why) {
    root.append(el('div', 'chat-card-why', paper.why));
  }
  return root;
}

/**
 * The words of a list item after the paper's name, without the dash that
 * joins them — and without a short name in brackets straight after it,
 * "(STAMP)", which is given back to go beside the authors.
 */
function after(mention: Element): { words: Node[]; tag?: string } {
  const nodes: Node[] = [];
  let node = mention.nextSibling;
  while (node) {
    if (node instanceof HTMLElement && /^(UL|OL)$/.test(node.tagName)) break;
    nodes.push(node);
    node = node.nextSibling;
  }
  const first = nodes[0];
  let tag: string | undefined;
  if (first?.nodeType === Node.TEXT_NODE) {
    let text = first.textContent ?? '';
    const named = /^\s*\(([^()]{1,24})\)/.exec(text);
    if (named) {
      tag = named[1].trim();
      text = text.slice(named[0].length);
    }
    first.textContent = text.replace(/^\s*[—–:,-]\s*/, '').replace(/^\s+/, '');
  }
  const text = nodes.map((part) => part.textContent ?? '').join('').trim();
  return { words: text ? nodes : [], tag };
}

/** Whether the item opens with the name: nothing but spaces before it. */
function opensWith(item: Element, mention: Element): boolean {
  for (const node of Array.from(item.childNodes)) {
    if (node === mention) return true;
    if ((node.textContent ?? '').trim()) return false;
  }
  return false;
}

/**
 * Set the cards into a drawn answer. Run after every draw: a container already
 * done for this layout is left alone, and one drawn afresh is done again.
 */
export function placeCards(container: HTMLElement, papers: Recommendation[], layout: PaperLayout) {
  if (layout === 'end' || !papers.length) return;
  const stamp = `${layout}:${papers.length}`;
  if (container.dataset.cards === stamp) return;
  container.dataset.cards = stamp;

  const index = new Map(papers.map((paper, i) => [paperKey(paper.title), i]));
  const lookup = (mention: Element) => {
    const i = index.get(paperKey((mention as HTMLElement).dataset.paper ?? ''));
    return i === undefined ? null : { paper: papers[i], n: i + 1 };
  };
  const shown = new Set<number>();
  const row = (mentions: Element[]) => {
    const group = el('div', 'chat-cards');
    for (const mention of mentions) {
      const found = lookup(mention);
      if (!found || shown.has(found.n)) continue;
      shown.add(found.n);
      group.append(card(found.paper, found.n, null));
    }
    return group.childElementCount ? group : null;
  };

  if (layout === 'inline') {
    for (const item of Array.from(container.querySelectorAll('li'))) {
      const mentions = Array.from(item.querySelectorAll(':scope > .chat-mention'));
      if (!mentions.length) continue;
      const found = mentions.length === 1 ? lookup(mentions[0]) : null;
      if (found && opensWith(item, mentions[0]) && !shown.has(found.n)) {
        // An item about one paper becomes that paper's card, in its words.
        shown.add(found.n);
        const { words, tag } = after(mentions[0]);
        const nested = Array.from(item.children).filter((child) => /^(UL|OL)$/.test(child.tagName));
        item.replaceChildren(card(found.paper, found.n, words, tag), ...nested);
        item.classList.add('chat-li-card');
        continue;
      }
      // Several papers in one item: the words stay, and their cards follow them.
      const group = row(mentions);
      if (group) item.append(group);
    }
    for (const paragraph of Array.from(container.querySelectorAll(':scope > p'))) {
      const group = row(Array.from(paragraph.querySelectorAll('.chat-mention')));
      if (group) paragraph.after(group);
    }
    return;
  }

  // After each section: the text as written, then the cards of the papers it named.
  for (const block of Array.from(container.children)) {
    if (block.classList.contains('chat-cards')) continue;
    const group = row(Array.from(block.querySelectorAll('.chat-mention')));
    if (group) block.after(group);
  }
}

/** Bring the cards' Add buttons up to date with what has been added. */
export function markAdds(container: HTMLElement, state: (title: string) => 'adding' | 'added' | 'missing' | undefined) {
  container.querySelectorAll<HTMLButtonElement>('.chat-card-add').forEach((button) => {
    const now = state(button.dataset.paper ?? '');
    const label = now === 'adding' ? 'Adding…' : now === 'added' ? 'In Reading list' : now === 'missing' ? 'Not found — try again' : 'Add';
    if (button.dataset.state === (now ?? '')) return;
    button.dataset.state = now ?? '';
    button.disabled = now === 'adding' || now === 'added';
    button.className = `btn sm chat-card-add ${now ? `is-${now}` : ''}`;
    button.title = now ? label : 'Add to Reading list';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = `<span aria-hidden="true">${now === 'added' ? '✓' : now === 'adding' ? '…' : '+'}</span>`;
  });
}
