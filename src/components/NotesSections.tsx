import { useMemo, useRef, useEffect } from 'react';
import { addText, removeNote, sourceName, updateNote, useNotes } from '../lib/notes';
import type { NoteBlock, NoteTag } from '../lib/notes';
import { sectionsOf } from '../lib/board';
import { cleanClip } from '../lib/sanitize';
import { useStore } from '../lib/store';
import { whereNow } from '../lib/where';
import { showSource } from './NotesList';
import { ExplainIcon, FileIcon, PlusIcon, TrashIcon } from './icons';

type Text = Extract<NoteBlock, { kind: 'text' }>;
const WHOLE = 'Whole paper';

/** A textarea as tall as what is in it. */
function Grow({ paperId, block, placeholder, className }: { paperId: string; block: Text; placeholder: string; className: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${area.current.scrollHeight + 2}px`;
  });
  // A piece just made, empty, is written in straight away.
  useEffect(() => {
    if (!block.md && Date.now() - Date.parse(block.at) < 1500) area.current?.focus();
  }, [block.md, block.at]);
  return (
    <span className={`sec-write-wrap ${className}`}>
      <textarea ref={area} className="sec-write" value={block.md} placeholder={placeholder} aria-label={placeholder} onChange={(event) => updateNote(paperId, block.id, { md: event.target.value })} />
      <button type="button" className="sec-x" onClick={() => removeNote(paperId, block.id)} aria-label="Delete this" title="Delete">
        <TrashIcon size={12} />
      </button>
    </span>
  );
}

function Clip({ paperId, block }: { paperId: string; block: Extract<NoteBlock, { kind: 'clip' }> }) {
  const html = useMemo(() => cleanClip(block.html), [block]);
  return (
    <div className="sec-clip">
      <div className="note-clip" dangerouslySetInnerHTML={{ __html: html }} />
      <div className="sec-clip-foot">
        <button type="button" className="note-source" onClick={() => void showSource(block.source)}>
          {block.source.from === 'explain' ? <ExplainIcon size={12} /> : <FileIcon size={12} />} {block.label} · {sourceName(block.source)}
        </button>
        <button type="button" className="sec-x" onClick={() => removeNote(paperId, block.id)} aria-label="Delete this" title="Delete">
          <TrashIcon size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * The notes laid out by the paper's sections, Cornell style: for each, the
 * questions to test yourself with down the left (cues), the notes on the
 * right — what you wrote and what you kept — and a line of summary under
 * them. The section being read is marked. Sections you have highlighted in
 * but not written about wait at the bottom of the list; the whole paper's
 * summary comes last.
 */
export default function NotesSections({ paperId }: { paperId: string }) {
  const blocks = useNotes(paperId);
  const { highlights } = useStore();
  const here = whereNow().section;

  const groups = useMemo(() => {
    const names = sectionsOf(blocks).map((name) => (name === 'Your notes' ? WHOLE : name));
    const order: string[] = [];
    names.forEach((name) => {
      if (name !== WHOLE && !order.includes(name)) order.push(name);
    });
    for (const highlight of highlights) {
      if (highlight.paperId === paperId && highlight.section && !order.includes(highlight.section)) order.push(highlight.section);
    }
    if (here && !order.includes(here)) order.push(here);
    const of = (name: string) => blocks.filter((_, index) => names[index] === name);
    return { sections: order.map((name) => ({ name, blocks: of(name) })), whole: of(WHOLE) };
  }, [blocks, highlights, paperId, here]);

  const write = (section: string, tag?: NoteTag) => addText(paperId, '', { tag, source: section === WHOLE ? undefined : { from: 'paper', section } });

  const section = (name: string, list: NoteBlock[], whole = false) => {
    const cues = list.filter((block): block is Text => block.kind === 'text' && block.tag === 'question');
    const summaries = list.filter((block): block is Text => block.kind === 'text' && block.tag === 'summary');
    const notes = list.filter((block) => !(block.kind === 'text' && (block.tag === 'question' || block.tag === 'summary')));
    const empty = !list.length;
    return (
      <section key={name} className={`sec${name === here ? ' is-here' : ''}`}>
        <h3 className="sec-name">
          <span>{whole ? 'Whole paper' : name}</span>
          {name === here ? <span className="sec-here">Reading now</span> : null}
        </h3>
        {empty ? (
          <button type="button" className="sec-start" onClick={() => write(name, whole ? 'summary' : undefined)}>
            <PlusIcon size={13} /> {whole ? 'Overall summary' : 'Write about this section'}
          </button>
        ) : (
          <div className="sec-card">
            {!whole ? (
              <div className="sec-cues">
                <div className="sec-label">Cues</div>
                {cues.map((cue) => (
                  <Grow key={cue.id} paperId={paperId} block={cue} placeholder="A question…" className="is-cue" />
                ))}
                <button type="button" className="sec-add" onClick={() => write(name, 'question')}>
                  + cue
                </button>
              </div>
            ) : null}
            <div className="sec-notes">
              {notes.map((block) =>
                block.kind === 'clip' ? (
                  <Clip key={block.id} paperId={paperId} block={block} />
                ) : (
                  <Grow key={block.id} paperId={paperId} block={block} placeholder="Notes…" className={block.tag === 'key' ? 'is-key' : ''} />
                ),
              )}
              {!whole ? (
                <button type="button" className="sec-add" onClick={() => write(name)}>
                  + note
                </button>
              ) : null}
            </div>
            <div className="sec-summary">
              <div className="sec-label">Summary</div>
              {summaries.map((summary) => (
                <Grow key={summary.id} paperId={paperId} block={summary} placeholder="In a line…" className="is-summary" />
              ))}
              {!summaries.length ? (
                <button type="button" className="sec-add" onClick={() => write(name, 'summary')}>
                  + summary
                </button>
              ) : null}
            </div>
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="scroll notes-sections">
      {!blocks.length && !groups.sections.length ? (
        <p className="notes-empty">Notes by the paper's sections: questions down the left, notes on the right, a summary under each. Start with the section you are reading, or keep something from the paper and its section appears here.</p>
      ) : null}
      {groups.sections.map((group) => section(group.name, group.blocks))}
      {section(WHOLE, groups.whole, true)}
    </div>
  );
}
