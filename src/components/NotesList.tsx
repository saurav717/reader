import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { NOTE_ADDED, OPEN_EXPLAIN, SHOW_IN_EXPLAIN, addText, moveNote, removeNote, updateNote, useNotes } from '../lib/notes';
import type { NoteBlock, NoteSource } from '../lib/notes';
import { ExplainIcon, PlusIcon, TrashIcon } from './icons';

/** Waits, a frame at a time, for something to be on the page. */
function whenThere(selector: string, within = 4000): Promise<boolean> {
  const until = performance.now() + within;
  return new Promise((resolve) => {
    const look = () => {
      if (document.querySelector(selector)) resolve(true);
      else if (performance.now() > until) resolve(false);
      else requestAnimationFrame(look);
    };
    look();
  });
}

/** Back to where a piece was kept from: Explain opened if it is shut, then the passage marked, or its section scrolled to. */
async function showSource(source: NoteSource) {
  if (!document.querySelector('.explain')) {
    window.dispatchEvent(new CustomEvent(OPEN_EXPLAIN));
    if (!(await whenThere('.explain .explain-section'))) return;
  }
  window.dispatchEvent(new CustomEvent(SHOW_IN_EXPLAIN, { detail: source }));
}

/** A textarea as tall as what is in it. */
function grow(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight + 2}px`;
}

function Piece({ paperId, block, first, last, fresh }: { paperId: string; block: NoteBlock; first: boolean; last: boolean; fresh: boolean }) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const [noting, setNoting] = useState(false);
  const html = useMemo(() => (block.kind === 'clip' ? DOMPurify.sanitize(block.html) : ''), [block]);

  useEffect(() => grow(textRef.current));
  useEffect(() => {
    if (!fresh) return;
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (block.kind === 'text') textRef.current?.focus();
  }, [fresh, block.kind]);

  const tools = (
    <span className="note-piece-tools">
      <button type="button" className="icon-btn sm" disabled={first} onClick={() => moveNote(paperId, block.id, -1)} aria-label="Move up" title="Move up">
        ↑
      </button>
      <button type="button" className="icon-btn sm" disabled={last} onClick={() => moveNote(paperId, block.id, 1)} aria-label="Move down" title="Move down">
        ↓
      </button>
      <button type="button" className="icon-btn sm" onClick={() => removeNote(paperId, block.id)} aria-label="Delete" title="Delete">
        <TrashIcon size={14} />
      </button>
    </span>
  );

  if (block.kind === 'text') {
    return (
      <article ref={cardRef} className={`note-piece is-text${fresh ? ' is-fresh' : ''}`}>
        <header className="note-piece-head">
          <span className="note-piece-kind">Text</span>
          {tools}
        </header>
        <textarea
          ref={textRef}
          className="note-write"
          value={block.md}
          placeholder="Write…"
          aria-label="Your note"
          onChange={(event) => {
            updateNote(paperId, block.id, { md: event.target.value });
            grow(event.target);
          }}
        />
      </article>
    );
  }

  return (
    <article ref={cardRef} className={`note-piece is-clip${fresh ? ' is-fresh' : ''}`}>
      <header className="note-piece-head">
        <span className="note-piece-kind">{block.label}</span>
        {tools}
      </header>
      <div className="note-clip" dangerouslySetInnerHTML={{ __html: html }} />
      <footer className="note-piece-foot">
        <button type="button" className="note-source" onClick={() => void showSource(block.source)} title="Show it in the explanation">
          <ExplainIcon size={12} /> Explain{block.source.section ? ` · ${block.source.section}` : ''}
        </button>
        {!block.note && !noting ? (
          <button type="button" className="btn ghost sm" onClick={() => setNoting(true)}>
            + note
          </button>
        ) : null}
      </footer>
      {block.note || noting ? (
        <textarea
          ref={(element) => grow(element)}
          className="note-write is-under"
          value={block.note ?? ''}
          placeholder="A line of your own about it…"
          aria-label="Your note on this"
          autoFocus={noting && !block.note}
          onChange={(event) => {
            updateNote(paperId, block.id, { note: event.target.value });
            grow(event.target);
          }}
          onBlur={() => setNoting(false)}
        />
      ) : null}
    </article>
  );
}

/**
 * Your notes on a paper: what you write, and what you keep from its Explain
 * page, in the order you put them.
 */
export default function NotesList({ paperId }: { paperId: string }) {
  const blocks = useNotes(paperId);
  const [fresh, setFresh] = useState<string | null>(null);

  // What was just added is scrolled to, and a new text piece is written in straight away.
  useEffect(() => {
    const onAdded = (event: Event) => {
      const detail = (event as CustomEvent<{ paperId: string; id: string }>).detail;
      if (detail.paperId !== paperId) return;
      setFresh(detail.id);
      window.setTimeout(() => setFresh((current) => (current === detail.id ? null : current)), 1600);
    };
    window.addEventListener(NOTE_ADDED, onAdded);
    return () => window.removeEventListener(NOTE_ADDED, onAdded);
  }, [paperId]);

  return (
    <div className="scroll notes-list">
      {!blocks.length ? (
        <p className="notes-empty">
          Write here, or keep things from the paper’s Explain page: select any of it and choose <b>Add to notes</b>, or point at a diagram, code cell, table or
          equation, or a section’s heading.
        </p>
      ) : null}
      {blocks.map((block, index) => (
        <Piece key={block.id} paperId={paperId} block={block} first={index === 0} last={index === blocks.length - 1} fresh={fresh === block.id} />
      ))}
      <button type="button" className="btn ghost sm notes-write-btn" onClick={() => addText(paperId)}>
        <PlusIcon size={14} /> Write
      </button>
    </div>
  );
}
