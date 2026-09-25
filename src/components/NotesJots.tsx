import { useEffect, useRef, useState } from 'react';
import { TAG_NAMES, addText, removeNote, useNotes, withoutLabel } from '../lib/notes';
import type { NoteBlock, NoteTag } from '../lib/notes';
import { whereNow } from '../lib/where';
import type { Whereabouts } from '../lib/where';
import { relativeDay } from '../lib/libraryLook';
import { showSource } from './NotesList';
import { TrashIcon } from './icons';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso: string) => {
  const day = relativeDay(iso);
  return day ? day[0].toUpperCase() + day.slice(1) : '';
};

/** Where a jot was written, in a chip: "p. 3 · 4 Why self-attention". */
const whereName = (where: Whereabouts) => [where.page ? `p. ${where.page}` : '', where.section ?? ''].filter(Boolean).join(' · ');

function Jot({ paperId, block }: { paperId: string; block: NoteBlock }) {
  const text = block.kind === 'text' ? block.md : block.note || withoutLabel(block.label, block.text);
  const source = block.source;
  return (
    <article className={`jot${block.kind === 'text' && block.tag ? ` is-${block.tag}` : ''}${block.kind === 'clip' ? ' is-kept' : ''}`}>
      <p className="jot-text">
        {block.kind === 'text' && block.tag === 'question' ? <b>? </b> : null}
        {block.kind === 'text' && block.tag === 'key' ? <b>★ </b> : null}
        {block.kind === 'clip' ? <b className="jot-label">{block.label} · </b> : null}
        {text.trim()}
      </p>
      <div className="jot-meta">
        {source && (source.page || source.section || source.from === 'explain') ? (
          <button type="button" className="jot-chip" onClick={() => void showSource(source)} title="Go back to where it was written">
            {source.from === 'explain' ? 'Explain · ' : ''}
            {whereName({ page: source.page, section: source.section }) || 'Explain'}
          </button>
        ) : null}
        <span>{time(block.at)}</span>
        {block.kind === 'text' && block.tag ? <span>· {TAG_NAMES[block.tag].toLowerCase()}</span> : null}
        {block.kind === 'text' && block.pin ? <span>· sticky</span> : null}
        {block.kind === 'clip' ? <span>· kept</span> : null}
        <button type="button" className="jot-x" onClick={() => removeNote(paperId, block.id)} aria-label="Delete this jot" title="Delete">
          <TrashIcon size={12} />
        </button>
      </div>
    </article>
  );
}

/**
 * Quick capture: a line at a time, each remembering the page and section it
 * was written at, in the order they were written — a running log of the
 * reading. Enter keeps a jot; ? and ★ mark it as a question or a key point.
 */
export default function NotesJots({ paperId }: { paperId: string }) {
  const blocks = useNotes(paperId);
  const [draft, setDraft] = useState('');
  const [tag, setTag] = useState<NoteTag | null>(null);
  const [where, setWhere] = useState<Whereabouts>(() => whereNow());
  const [placed, setPlaced] = useState(true);
  const list = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // Writing begun and left empty elsewhere is not a jot.
  const ordered = blocks.filter((block) => block.kind !== 'text' || block.md.trim()).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [blocks.length]);

  const save = () => {
    const md = draft.trim();
    if (!md) return;
    const here = placed ? whereNow() : {};
    addText(paperId, md, { tag: tag ?? undefined, source: here.page || here.section ? { from: 'paper', page: here.page, section: here.section } : undefined });
    setDraft('');
    setTag(null);
    setWhere(whereNow());
    area.current?.focus();
  };

  let lastDay = '';
  return (
    <div className="notes-jots">
      <div ref={list} className="scroll jots-list">
        {!ordered.length ? <p className="notes-empty">Jot a line as you read — it keeps the page and section you were on. Enter to keep it.</p> : null}
        {ordered.map((block) => {
          const day = dayOf(block.at);
          const head = day !== lastDay ? <div className="jots-day">{day}</div> : null;
          lastDay = day;
          return (
            <div key={block.id}>
              {head}
              <Jot paperId={paperId} block={block} />
            </div>
          );
        })}
      </div>
      <div className="jots-compose">
        <textarea
          ref={area}
          value={draft}
          placeholder="Jot a line…"
          aria-label="Jot a line"
          onFocus={() => setWhere(whereNow())}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              save();
            }
            if (event.key === 'Escape') {
              event.stopPropagation();
              event.currentTarget.blur();
            }
          }}
        />
        <div className="jots-bar">
          {whereName(where) ? (
            <button type="button" className="jots-toggle" aria-pressed={placed} onClick={() => setPlaced(!placed)} title={placed ? 'Keep where you are with it — click to leave it off' : 'Leave where you are off it'}>
              📍 {whereName(where)}
            </button>
          ) : null}
          <button type="button" className="jots-toggle" aria-pressed={tag === 'question'} onClick={() => setTag(tag === 'question' ? null : 'question')}>
            ? question
          </button>
          <button type="button" className="jots-toggle" aria-pressed={tag === 'key'} onClick={() => setTag(tag === 'key' ? null : 'key')}>
            ★ key
          </button>
          <span className="jots-hint">⏎ to save</span>
          <button type="button" className="btn sm" onClick={save} disabled={!draft.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
