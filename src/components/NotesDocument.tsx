import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { TAG_NAMES, addClip, addText, copyOf, markText, removeNote, sourceName, updateNote, useNotes } from '../lib/notes';
import type { NoteBlock, NoteTag } from '../lib/notes';
import { drawnNote as drawn, toggleCheck } from '../lib/noteMarkdown';
import { typesetMath } from '../lib/typesetMath';
import { cleanClip } from '../lib/sanitize';
import { useStore } from '../lib/store';
import { showSource } from './NotesList';
import { FileIcon, ExplainIcon, TrashIcon } from './icons';

type Text = Extract<NoteBlock, { kind: 'text' }>;

interface Command {
  id: string;
  group: 'From the paper' | 'Write';
  icon: string;
  name: string;
  hint: string;
}

const COMMANDS: Command[] = [
  { id: 'highlight', group: 'From the paper', icon: '❝', name: 'Highlight', hint: 'Drop one of your highlights here' },
  { id: 'figure', group: 'From the paper', icon: '▦', name: 'Figure or table', hint: 'Figure 1, Table 1… from the reflowed paper' },
  { id: 'heading', group: 'Write', icon: 'H', name: 'Heading', hint: '' },
  { id: 'checklist', group: 'Write', icon: '☐', name: 'Checklist', hint: '' },
  { id: 'equation', group: 'Write', icon: 'Σ', name: 'Equation', hint: 'TeX between $$ … $$' },
  { id: 'question', group: 'Write', icon: '?', name: 'Mark as a question', hint: '' },
  { id: 'key', group: 'Write', icon: '★', name: 'Mark as a key point', hint: '' },
  { id: 'summary', group: 'Write', icon: '≡', name: 'Mark as a summary', hint: '' },
];

/** The figures and tables of the reflowed paper on the screen, each with a name to pick it by. */
function figuresOnPage(): { name: string; element: HTMLElement; section?: string }[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.main .paper-body figure, .main .paper-body table')).flatMap((element) => {
    if (element.tagName === 'TABLE' && element.closest('figure')) return [];
    const caption = (element.querySelector('figcaption, caption')?.textContent ?? element.previousElementSibling?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const name = /^(Figure|Fig\.|Table)\s*\d+/i.exec(caption)?.[0] ?? (element.tagName === 'TABLE' ? 'Table' : 'Figure');
    return [{ name: `${name}${caption ? ` — ${caption.slice(name.length, 70).replace(/^[:.\s]+/, '')}` : ''}`, element }];
  });
}

function Writing({ paperId, block, editing, onEdit, onDone }: { paperId: string; block: Text; editing: boolean; onEdit: () => void; onDone: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<HTMLDivElement>(null);
  const { highlights } = useStore();
  const [menu, setMenu] = useState<{ query: string; start: number; pick: number; sub?: 'highlight' | 'figure' } | null>(null);
  const html = useMemo(() => drawn(block.md), [block.md]);
  // The menu under the line being written — or over it, with no room below.
  const [menuAt, setMenuAt] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
  useLayoutEffect(() => {
    if (!menu || !area.current) return;
    const rect = area.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - 310, rect.left));
    setMenuAt(window.innerHeight - rect.bottom < 330 ? { left, bottom: window.innerHeight - rect.top + 4 } : { left, top: rect.bottom + 4 });
  }, [menu]);

  useLayoutEffect(() => {
    if (!editing || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(area.current.value.length, area.current.value.length);
    area.current.style.height = 'auto';
    area.current.style.height = `${area.current.scrollHeight + 2}px`;
  }, [editing]);
  useEffect(() => {
    if (!editing) void typesetMath(shown.current);
  }, [editing, html]);

  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !area.current) return;
    area.current.focus();
    area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [block.md]);

  const grow = () => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${area.current.scrollHeight + 2}px`;
  };

  // `/` at the start of a line opens the menu; what is typed after it narrows it.
  const look = (value: string, caret: number) => {
    const line = value.slice(value.lastIndexOf('\n', caret - 1) + 1, caret);
    const match = /^\/(\w*)$/.exec(line);
    setMenu((current) => (match ? { query: match[1].toLowerCase(), start: caret - line.length, pick: current?.sub ? current.pick : 0, sub: current?.sub } : null));
  };
  const commands = menu && !menu.sub ? COMMANDS.filter((command) => !menu.query || command.name.toLowerCase().includes(menu.query) || command.id.startsWith(menu.query)) : [];
  const mine = highlights.filter((highlight) => highlight.paperId === paperId);
  const figures = menu?.sub === 'figure' ? figuresOnPage() : [];
  const subItems = menu?.sub === 'highlight' ? mine.map((highlight) => ({ key: highlight.id, name: highlight.exact.slice(0, 90), hint: highlight.section ?? '' })) : figures.map((figure, index) => ({ key: String(index), name: figure.name, hint: '' }));
  const count = menu?.sub ? subItems.length : commands.length;

  /** The `/…` typed taken out, and `insert` put at the start of the line instead. */
  const replaceSlash = (insert = '', caretIn = insert.length) => {
    if (!menu) return;
    const value = block.md;
    const caret = area.current?.selectionStart ?? value.length;
    const next = value.slice(0, menu.start) + insert + value.slice(caret);
    // The caret is put where it belongs as the new text is drawn, before anything more is typed.
    pendingCaret.current = menu.start + caretIn;
    updateNote(paperId, block.id, { md: next });
    setMenu(null);
  };

  const choose = async (index: number) => {
    if (!menu) return;
    if (menu.sub === 'highlight') {
      const highlight = mine[index];
      if (!highlight) return;
      replaceSlash();
      const safe = highlight.exact.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      addClip(paperId, { label: 'Highlight', html: `<blockquote><p>${safe}</p></blockquote>`, text: highlight.exact, source: { from: 'paper', section: highlight.section, quote: highlight.exact.slice(0, 160) } }, block.id);
      return;
    }
    if (menu.sub === 'figure') {
      const figure = figures[index];
      if (!figure) return;
      replaceSlash();
      const section = figure.element.closest('section')?.querySelector('h1, h2, h3, h4')?.textContent?.trim();
      addClip(paperId, { label: figure.name.split(' — ')[0], html: await copyOf(figure.element), text: figure.element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? '', source: { from: 'paper', section, quote: figure.name.split(' — ')[1]?.slice(0, 60) } }, block.id);
      return;
    }
    const command = commands[index];
    if (!command) return;
    if (command.id === 'highlight' || command.id === 'figure') {
      setMenu({ ...menu, sub: command.id, pick: 0 });
      return;
    }
    if (command.id === 'heading') return replaceSlash('## ');
    if (command.id === 'checklist') return replaceSlash('- [ ] ');
    if (command.id === 'equation') return replaceSlash('$$  $$', 3);
    replaceSlash();
    markText(paperId, block.id, { tag: block.tag === command.id ? null : (command.id as NoteTag) });
  };

  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && count) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMenu({ ...menu, pick: (menu.pick + (event.key === 'ArrowDown' ? 1 : count - 1)) % count });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        void choose(menu.pick);
        return;
      }
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (menu) setMenu(null);
      else area.current?.blur();
    }
    // Enter on a checklist line starts the next box.
    if (event.key === 'Enter' && !event.shiftKey && area.current) {
      const caret = area.current.selectionStart;
      const line = block.md.slice(block.md.lastIndexOf('\n', caret - 1) + 1, caret);
      const bullet = /^(\s*[-*] (\[[ xX]\] )?)/.exec(line);
      if (bullet && line.trim() !== bullet[1].trim()) {
        event.preventDefault();
        const lead = bullet[1].replace(/\[[xX]\]/, '[ ]');
        pendingCaret.current = caret + 1 + lead.length;
        updateNote(paperId, block.id, { md: `${block.md.slice(0, caret)}\n${lead}${block.md.slice(caret)}` });
      }
    }
  };

  return (
    <div className={`doc-text${block.tag ? ` is-${block.tag}` : ''}${block.pin ? ' is-sticky' : ''}`}>
      {block.tag || block.pin ? (
        <span className="doc-tag">
          {block.pin ? `📌 Sticky · p. ${block.pin.page}` : TAG_NAMES[block.tag as NoteTag]}
          {block.tag ? (
            <button type="button" onClick={() => markText(paperId, block.id, { tag: null })} aria-label="Unmark it">
              ×
            </button>
          ) : null}
        </span>
      ) : null}
      {editing ? (
        <textarea
          ref={area}
          className="doc-write"
          value={block.md}
          placeholder="Write — / for headings, checklists, equations, highlights and figures"
          aria-label="Your notes"
          onChange={(event) => {
            updateNote(paperId, block.id, { md: event.target.value });
            look(event.target.value, event.target.selectionStart);
            grow();
          }}
          onKeyDown={onKey}
          onBlur={() => {
            window.setTimeout(() => {
              setMenu(null);
              onDone();
            }, 120);
          }}
        />
      ) : (
        <div
          ref={shown}
          className="doc-shown"
          tabIndex={0}
          onClick={(event) => {
            const box = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-check]') : null;
            if (box) updateNote(paperId, block.id, { md: toggleCheck(block.md, Number(box.dataset.check)) });
            else onEdit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onEdit();
            }
          }}
          dangerouslySetInnerHTML={{ __html: block.md.trim() ? html : '<p class="doc-placeholder">Write…</p>' }}
        />
      )}
      {editing && menu && (menu.sub ? true : commands.length > 0) ? (
        <div className="doc-menu" role="listbox" style={menuAt} onMouseDown={(event) => event.preventDefault()}>
          {menu.sub ? (
            <>
              <div className="doc-menu-group">{menu.sub === 'highlight' ? 'Your highlights' : 'Figures and tables on the page'}</div>
              {!subItems.length ? (
                <p className="doc-menu-none">{menu.sub === 'highlight' ? 'No highlights on this paper yet.' : 'Open the paper in Reflow to pick its figures and tables.'}</p>
              ) : (
                subItems.map((item, index) => (
                  <button key={item.key} type="button" role="option" aria-selected={index === menu.pick} onClick={() => void choose(index)}>
                    <span className="doc-menu-icon">{menu.sub === 'highlight' ? '❝' : '▦'}</span>
                    <span>
                      {item.name}
                      {item.hint ? <small>{item.hint}</small> : null}
                    </span>
                  </button>
                ))
              )}
            </>
          ) : (
            commands.map((command, index) => (
              <div key={command.id}>
                {index === 0 || commands[index - 1].group !== command.group ? <div className="doc-menu-group">{command.group}</div> : null}
                <button type="button" role="option" aria-selected={index === menu.pick} onClick={() => void choose(index)}>
                  <span className="doc-menu-icon">{command.icon}</span>
                  <span>
                    {command.name}
                    {command.hint ? <small>{command.hint}</small> : null}
                  </span>
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
      <button type="button" className="doc-delete icon-btn sm" onClick={() => removeNote(paperId, block.id)} aria-label="Delete this" title="Delete">
        <TrashIcon size={13} />
      </button>
    </div>
  );
}

function Kept({ paperId, block }: { paperId: string; block: Extract<NoteBlock, { kind: 'clip' }> }) {
  const html = useMemo(() => cleanClip(block.html), [block]);
  return (
    <figure className="doc-clip">
      <div className="note-clip" dangerouslySetInnerHTML={{ __html: html }} />
      {block.note ? <p className="doc-clip-note">{block.note}</p> : null}
      <figcaption>
        <button type="button" className="note-source" onClick={() => void showSource(block.source)}>
          {block.source.from === 'explain' ? <ExplainIcon size={12} /> : <FileIcon size={12} />} {block.label} · {sourceName(block.source)}
        </button>
        <span className="doc-jump">↩ jump to it</span>
        <button type="button" className="doc-delete icon-btn sm" onClick={() => removeNote(paperId, block.id)} aria-label="Delete this" title="Delete">
          <TrashIcon size={13} />
        </button>
      </figcaption>
    </figure>
  );
}

/**
 * The notes as one document: your writing, drawn as Markdown — headings,
 * checklists, maths — with what was kept from the paper set in among it,
 * in the list's own order. Click a passage of writing to edit it; `/` at the
 * start of a line drops in a highlight, a figure or table, a heading, a
 * checklist or an equation.
 */
export default function NotesDocument({ paperId }: { paperId: string }) {
  const blocks = useNotes(paperId);
  const [editing, setEditing] = useState<string | null>(null);

  const last = blocks[blocks.length - 1];
  const keepWriting = () => {
    // The last thing is writing already: carry on in it.
    if (last?.kind === 'text' && !last.pin && !last.tag && !last.source) {
      // On a line of its own.
      if (last.md && !last.md.endsWith('\n')) updateNote(paperId, last.id, { md: `${last.md}\n` });
      setEditing(last.id);
      return;
    }
    setEditing(addText(paperId).id);
  };

  return (
    <div className="scroll notes-doc">
      <article className="doc-page">
        {!blocks.length ? <p className="notes-empty">One document for this paper: write, and press / to drop in a highlight, a figure or table, a heading, a checklist or an equation.</p> : null}
        {blocks.map((block) =>
          block.kind === 'text' ? (
            <Writing key={block.id} paperId={paperId} block={block} editing={editing === block.id} onEdit={() => setEditing(block.id)} onDone={() => setEditing((current) => (current === block.id ? null : current))} />
          ) : (
            <Kept key={block.id} paperId={paperId} block={block} />
          ),
        )}
        <button type="button" className="doc-more" onClick={keepWriting}>
          Keep writing… <kbd>/</kbd> for more
        </button>
      </article>
    </div>
  );
}
