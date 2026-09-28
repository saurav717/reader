import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { defaultSources, search } from '../lib/sources';
import { authorLine } from '../lib/libraryLook';
import { statusOf } from '../lib/status';
import type { Collection, Paper, PaperRef } from '../types';
import { ProgressRing, progressLabel } from './LibraryBits';
import { clip } from './HomeParts';
import { PlusIcon } from './icons';

/** A paper dragged from one column to another. */
const CARD_MIME = 'application/x-reader-card';
const SHOWN = 5;

const norm = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Collections: each collection a column of its papers, reading ones first,
 * with a box at the foot that finds a paper and puts it straight in. Cards
 * drag from one column to another to move the paper.
 */
export function CollectionsBoard({ onOpenPaper, onFind }: { onOpenPaper: (id: string) => void; onFind: (query: string) => void }) {
  const { papers, collections, createCollection, setPaperCollections } = useStore();
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const order = (paper: Paper) => (statusOf(paper) === 'reading' ? 0 : statusOf(paper) === 'unread' ? 1 : 2);
  const move = async (paperId: string, from: string, to: string) => {
    const paper = papers.find((item) => item.id === paperId);
    if (!paper || from === to) return;
    await setPaperCollections(paperId, [...paper.collectionIds.filter((id) => id !== from), ...(paper.collectionIds.includes(to) ? [] : [to])]);
  };

  return (
    <div className="home-view cb">
      <p className="cb-lede">
        Each collection takes a paper straight in: type in the box at its foot. Drag a card to another column to move it.
      </p>
      <div className="cb-cols">
        {collections.map((collection) => {
          const inIt = papers
            .filter((paper) => paper.collectionIds.includes(collection.id))
            .sort((a, b) => order(a) - order(b) || (b.lastOpenedAt ?? b.addedAt).localeCompare(a.lastOpenedAt ?? a.addedAt));
          const reading = inIt.filter((paper) => statusOf(paper) === 'reading').length;
          return (
            <section
              key={collection.id}
              className={`cb-col${dropOn === collection.id ? ' is-drop' : ''}`}
              aria-label={collection.name}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(CARD_MIME)) return;
                event.preventDefault();
                setDropOn(collection.id);
              }}
              onDragLeave={(event) => {
                if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setDropOn(null);
              }}
              onDrop={(event) => {
                setDropOn(null);
                const raw = event.dataTransfer.getData(CARD_MIME);
                if (!raw) return;
                event.preventDefault();
                const { id, from } = JSON.parse(raw) as { id: string; from: string };
                void move(id, from, collection.id);
              }}
            >
              <header className="cb-col-head">
                <span className="home-dot" style={{ background: collection.color }} />
                <b>{collection.name}</b>
                <span className="cb-count">
                  {inIt.length}
                  {reading ? ` · ${reading} reading` : ''}
                </span>
              </header>
              {inIt.slice(0, SHOWN).map((paper) => (
                <button
                  key={paper.id}
                  type="button"
                  className="cb-card"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(CARD_MIME, JSON.stringify({ id: paper.id, from: collection.id }));
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => onOpenPaper(paper.id)}
                >
                  <ProgressRing progress={paper.progress} size={24} />
                  <span className="home-row-text">
                    <span className="home-row-title">{paper.title}</span>
                    <span className="home-row-sub">
                      {progressLabel(paper.progress)} · {authorLine(paper.authors, 1)}
                    </span>
                  </span>
                </button>
              ))}
              {inIt.length > SHOWN ? <p className="cb-more">+ {inIt.length - SHOWN} more</p> : null}
              {!inIt.length ? <p className="cb-more">Nothing here yet.</p> : null}
              <AddInto collection={collection} onFind={onFind} />
            </section>
          );
        })}
        <section className="cb-col cb-new">
          {naming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                void createCollection(name.trim()).then(() => {
                  setName('');
                  setNaming(false);
                });
              }}
            >
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Name it after a question…" aria-label="New collection name" onBlur={() => !name && setNaming(false)} />
            </form>
          ) : (
            <button type="button" onClick={() => setNaming(true)}>
              <PlusIcon size={18} />
              <b>New collection</b>
              <span>Name it after a question, and add to it as you search.</span>
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

/** The box at a column's foot: type, and the papers found go into this collection. */
function AddInto({ collection, onFind }: { collection: Collection; onFind: (query: string) => void }) {
  const { papers, addPaper } = useStore();
  const [text, setText] = useState('');
  const [found, setFound] = useState<PaperRef[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Asked as the typing pauses, from the same sources a search starts with.
  useEffect(() => {
    const query = text.trim();
    abort.current?.abort();
    if (query.length < 3) {
      setFound(null);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    const timer = window.setTimeout(() => {
      setBusy(true);
      void search(query, defaultSources(), { limit: 5, signal: controller.signal })
        .then((outcome) => !controller.signal.aborted && setFound(outcome.results.slice(0, 4)))
        .catch(() => !controller.signal.aborted && setFound([]))
        .finally(() => !controller.signal.aborted && setBusy(false));
    }, 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  const add = async (ref: PaperRef) => {
    const existing = papers.find((paper) => paper.id === ref.id || norm(paper.title) === norm(ref.title));
    await addPaper(existing ? { ...ref, id: existing.id } : ref, collection.id);
    setText('');
    setFound(null);
    setDone(ref.title);
    window.setTimeout(() => setDone(null), 3000);
  };

  return (
    <div className="cb-add">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && found?.[0]) {
            event.preventDefault();
            void add(found[0]);
          }
          if (event.key === 'Escape') setText('');
        }}
        placeholder={`+ Add a paper to ${clip(collection.name, 24)}`}
        aria-label={`Add a paper to ${collection.name}`}
      />
      {busy ? <span className="spinner" /> : null}
      {done ? <p className="cb-done">Added {clip(done, 40)}</p> : null}
      {found ? (
        <div className="cb-found">
          {found.map((ref, index) => (
            <button key={`${ref.id}-${index}`} type="button" className={index === 0 ? 'is-first' : undefined} onClick={() => void add(ref)}>
              <b>{ref.title}</b>
              <small>
                {authorLine(ref.authors, 2)}
                {/^\d{4}/.exec(ref.published || '')?.[0] ? ` · ${/^\d{4}/.exec(ref.published)![0]}` : ''}
                {index === 0 ? ' · ↵ adds it here' : ''}
              </small>
            </button>
          ))}
          {!found.length ? <p className="cb-more">Nothing found.</p> : null}
          <button type="button" className="cb-everywhere" onClick={() => onFind(text)}>
            Search everywhere for “{clip(text, 30)}” →
          </button>
        </div>
      ) : null}
    </div>
  );
}
