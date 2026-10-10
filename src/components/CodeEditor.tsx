// The playground's code editor, as VS Code's: line numbers, the current line
// lit, a minimap, find and replace, and VS Code's keys for lines — comment,
// move, copy, delete, indent — with brackets closed and the indent carried
// on a new line. It is still a textarea over the highlighted text, sized to
// its content inside a box that scrolls; every edit is typed in through the
// browser (insertText), so ⌘Z and ⇧⌘Z undo and redo it as they do typing.
// What it does to the text is src/lib/editing.ts.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { highlightCode } from '../lib/languages';
import { highlightTex } from '../lib/overleaf';
import type { Edit, FindOptions, Selection } from '../lib/editing';
import { commentFor, copyLines, deleteLines, deletePair, findAll, lineCol, lineSpan, moveLines, newLine, offsetOfLine, replaceAll, toggleComment, typeBracket } from '../lib/editing';
import { highlightPython } from './Explain';
import { CloseIcon } from './icons';

export interface CodeEditorHandle {
  focus: () => void;
  /** Puts the caret at the start of a line (from 1) and brings it into view. */
  goToLine: (line: number) => void;
  /** The find bar, or find and replace; with the selection as the query when there is one. */
  openFind: (replace?: boolean) => void;
  /** Types text in over the selection, or at the caret, so undo takes it back. */
  insert: (text: string) => void;
}

export interface Cursor {
  line: number;
  col: number;
  /** Characters selected. */
  selected: number;
  lines: number;
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PAD_Y = 10;
const PAD_X = 14;
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string;
  path: string;
  fontSize?: number;
  minimap?: boolean;
  onChange: (next: string) => void;
  /** Keys it doesn't use itself: ⌘S, ⌘↵ and the workbench's. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCursor?: (cursor: Cursor) => void;
  onFocus?: () => void;
  /** Shown, searched and selected, never changed: a snapshot of code that is somewhere else. */
  readOnly?: boolean;
  /**
   * Long lines wrapped to the editor's width, as prose wants (the Write tab's
   * LaTeX), a line number at the first row of each. For a language whose
   * highlighting never spans lines, as LaTeX's doesn't.
   */
  wrap?: boolean;
}>(function CodeEditor({ value, path, fontSize = 13, minimap = true, onChange, onKeyDown, onCursor, onFocus, readOnly = false, wrap = false }, ref) {
  const text = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const map = useRef<HTMLCanvasElement>(null);
  const lineHeight = Math.round(fontSize * 1.6);
  const [charWidth, setCharWidth] = useState(fontSize * 0.6);
  const [caret, setCaret] = useState(0);
  const [findOpen, setFindOpen] = useState<null | 'find' | 'replace'>(null);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<FindOptions>({});
  const [current, setCurrent] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  const lines = useMemo(() => value.split('\n'), [value]);
  const widest = useMemo(() => lines.reduce((most, line) => Math.max(most, line.replace(/\t/g, '    ').length), 0), [lines]);
  const html = useMemo(() => (/\.py$/i.test(path) ? highlightPython(value) : /\.(tex|bib|sty|cls)$/i.test(path) ? highlightTex(value) : highlightCode(value, path)), [value, path]);
  const found = useMemo(() => (findOpen ? findAll(value, query, options) : { matches: [] as Selection[] }), [findOpen, value, query, options]);
  const marks = useMemo(() => {
    if (!found.matches.length) return '';
    let out = '';
    let at = 0;
    found.matches.forEach((match, index) => {
      out += esc(value.slice(at, match.start)) + `<mark class="${index === current ? 'is-current' : ''}">${esc(value.slice(match.start, match.end))}</mark>`;
      at = match.end;
    });
    return out + esc(value.slice(at));
  }, [found, value, current]);

  // The width of one character of the font, measured: the caret's place on screen comes from it.
  useLayoutEffect(() => {
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(100);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fontSize}px var(--mono)`;
    scroller.current?.appendChild(probe);
    setCharWidth(probe.getBoundingClientRect().width / 100 || fontSize * 0.6);
    probe.remove();
  }, [fontSize]);

  const report = useCallback(() => {
    const element = text.current;
    if (!element) return;
    setCaret(element.selectionEnd);
    const { line, col } = lineCol(element.value, element.selectionEnd);
    onCursor?.({ line, col, selected: Math.abs(element.selectionEnd - element.selectionStart), lines: element.value.split('\n').length });
  }, [onCursor]);

  /** The caret kept in view, as an editor scrolls to it: the box scrolls, not the textarea. */
  const reveal = useCallback(() => {
    const element = text.current;
    const box = scroller.current;
    if (!element || !box) return;
    const { line, col } = lineCol(element.value, element.selectionEnd);
    const y = topOf(line);
    const x = gutterWidth + PAD_X + (col - 1) * charWidth;
    if (y < box.scrollTop) box.scrollTop = y - lineHeight;
    else if (y + heightOf(line) + lineHeight > box.scrollTop + box.clientHeight) box.scrollTop = y + heightOf(line) + lineHeight - box.clientHeight;
    if (wrap) return;
    if (x < box.scrollLeft + gutterWidth + 20) box.scrollLeft = Math.max(0, x - gutterWidth - 40);
    else if (x + 30 > box.scrollLeft + box.clientWidth) box.scrollLeft = x + 60 - box.clientWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineHeight, charWidth, lines.length]);

  const gutterWidth = Math.max(3, String(lines.length).length) * charWidth + 28;

  // Wrapped, a line takes as many rows as it needs: its top and height are measured off the shadow's line boxes.
  const shadowLines = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<{ tops: number[]; heights: number[] } | null>(null);
  // Read by reveal, which is made once: the rows as they are now, not as they were then.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useLayoutEffect(() => {
    if (!wrap) return;
    const holder = shadowLines.current;
    if (!holder) return;
    const measure = () => {
      const children = Array.from(holder.children) as HTMLElement[];
      setRows({ tops: children.map((child) => child.offsetTop), heights: children.map((child) => child.offsetHeight) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(holder);
    return () => observer.disconnect();
  }, [wrap, value, fontSize]);
  const topOf = (line: number) => (wrap && rowsRef.current ? rowsRef.current.tops[line - 1] ?? PAD_Y + (line - 1) * lineHeight : PAD_Y + (line - 1) * lineHeight);
  const heightOf = (line: number) => (wrap && rowsRef.current ? rowsRef.current.heights[line - 1] ?? lineHeight : lineHeight);

  /** One edit typed in through the browser, so undo keeps it; the selection placed after. */
  const apply = useCallback(
    (edit: Edit | null) => {
      const element = text.current;
      if (!element || !edit || readOnly) return false;
      element.focus();
      element.setSelectionRange(edit.from, edit.to);
      const typed = edit.insert ? document.execCommand('insertText', false, edit.insert) : edit.from === edit.to || document.execCommand('delete');
      if (!typed) onChange(element.value.slice(0, edit.from) + edit.insert + element.value.slice(edit.to));
      window.requestAnimationFrame(() => {
        element.setSelectionRange(edit.select.start, edit.select.end);
        report();
        reveal();
      });
      return true;
    },
    [onChange, report, reveal, readOnly],
  );

  const go = useCallback(
    (offset: number, end = offset) => {
      const element = text.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(offset, end);
      report();
      window.requestAnimationFrame(reveal);
    },
    [report, reveal],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => text.current?.focus(),
      goToLine: (line: number) => go(offsetOfLine(text.current?.value ?? value, line)),
      insert: (insert: string) => {
        const element = text.current;
        if (!element) return;
        const from = element.selectionStart;
        const at = from + insert.length;
        apply({ from, to: element.selectionEnd, insert, select: { start: at, end: at } });
      },
      openFind: (replace = false) => {
        const element = text.current;
        const picked = element ? element.value.slice(element.selectionStart, element.selectionEnd) : '';
        if (picked && !picked.includes('\n')) setQuery(picked);
        setFindOpen(replace ? 'replace' : 'find');
        window.requestAnimationFrame(() => {
          findInput.current?.focus();
          findInput.current?.select();
        });
      },
    }),
    [go, value, apply],
  );

  // A new query goes to the match nearest after the caret.
  useEffect(() => {
    if (!findOpen || !found.matches.length) return;
    const next = found.matches.findIndex((match) => match.start >= (text.current?.selectionStart ?? 0));
    setCurrent(next === -1 ? 0 : next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, options, findOpen]);

  const step = (by: number) => {
    const count = found.matches.length;
    if (!count) return;
    const next = (current + by + count) % count;
    setCurrent(next);
    const match = found.matches[next];
    const element = text.current;
    if (!element) return;
    element.setSelectionRange(match.start, match.end);
    report();
    reveal();
  };

  // The minimap: each line a bar as long as its text, the part in view framed; a click or drag scrolls there.
  useEffect(() => {
    const canvas = map.current;
    const box = scroller.current;
    if (!canvas || !box || !minimap) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.scale(ratio, ratio);
    g.clearRect(0, 0, width, height);
    const row = Math.min(3, Math.max(1, height / Math.max(1, lines.length)));
    const ink = getComputedStyle(canvas).color;
    g.fillStyle = ink;
    g.globalAlpha = 0.45;
    lines.forEach((line, index) => {
      const lead = line.length - line.trimStart().length;
      const len = line.trimEnd().length - lead;
      if (len > 0) g.fillRect(4 + lead * 0.9, index * row, Math.min(width - 8, len * 0.9), Math.max(1, row - 1));
    });
    g.globalAlpha = 1;
    found.matches.forEach((match) => {
      g.fillStyle = 'rgba(232, 170, 40, 0.9)';
      g.fillRect(0, (lineCol(value, match.start).line - 1) * row, width, Math.max(2, row));
    });
    const total = PAD_Y * 2 + lines.length * lineHeight;
    const scale = (lines.length * row) / total;
    g.fillStyle = getComputedStyle(canvas).getPropertyValue('--ce-view') || 'rgba(127,127,127,0.18)';
    g.fillRect(0, view.top * scale, width, Math.max(10, view.height * scale));
  }, [lines, view, minimap, found, value, lineHeight]);

  const scrollFromMap = (clientY: number) => {
    const canvas = map.current;
    const box = scroller.current;
    if (!canvas || !box) return;
    const row = Math.min(3, Math.max(1, canvas.clientHeight / Math.max(1, lines.length)));
    const total = PAD_Y * 2 + lines.length * lineHeight;
    const y = clientY - canvas.getBoundingClientRect().top;
    box.scrollTop = (y / (lines.length * row)) * total - box.clientHeight / 2;
  };

  const { line: caretLine } = lineCol(value, Math.min(caret, value.length));

  const keys = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const sel = { start: element.selectionStart, end: element.selectionEnd };
    const mod = mac ? event.metaKey : event.ctrlKey;
    const k = event.key;
    const take = (edit: Edit | null) => {
      if (!edit) return;
      event.preventDefault();
      apply(edit);
    };
    if (k === 'Tab' && !mod && !event.altKey) {
      event.preventDefault();
      const { from, to } = lineSpan(element.value, sel);
      if (event.shiftKey || sel.start !== sel.end) {
        const chunk = element.value.slice(from, to);
        const next = event.shiftKey ? chunk.replace(/^ {1,4}/gm, '') : chunk.replace(/^(?=.)/gm, '    ');
        const firstShift = (next.split('\n')[0].length - chunk.split('\n')[0].length);
        apply({ from, to, insert: next, select: { start: Math.max(from, sel.start + firstShift), end: Math.max(from, sel.end + next.length - chunk.length) } });
      } else apply({ from: sel.start, to: sel.end, insert: '    ', select: { start: sel.start + 4, end: sel.start + 4 } });
      return;
    }
    if (mod && (k === ']' || k === '[')) {
      event.preventDefault();
      const { from, to } = lineSpan(element.value, sel);
      const chunk = element.value.slice(from, to);
      const next = k === ']' ? chunk.replace(/^/gm, '    ') : chunk.replace(/^ {1,4}/gm, '');
      apply({ from, to, insert: next, select: { start: from, end: from + next.length } });
      return;
    }
    if (k === 'Enter' && !mod && !event.shiftKey && !event.altKey) return take(newLine(element.value, sel));
    if (mod && k === '/') return take(toggleComment(element.value, sel, commentFor(path)));
    if (event.altKey && !mod && (k === 'ArrowUp' || k === 'ArrowDown')) {
      if (event.shiftKey) return take(copyLines(element.value, sel, k === 'ArrowDown'));
      event.preventDefault();
      apply(moveLines(element.value, sel, k === 'ArrowDown'));
      return;
    }
    if (mod && event.shiftKey && k.toLowerCase() === 'k') return take(deleteLines(element.value, sel));
    if (mod && !event.shiftKey && k.toLowerCase() === 'l') {
      event.preventDefault();
      const { from, to } = lineSpan(element.value, sel);
      go(from, Math.min(element.value.length, to + 1));
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && k.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      const picked = element.value.slice(sel.start, sel.end);
      if (picked && !picked.includes('\n')) setQuery(picked);
      setFindOpen((open) => (open === 'replace' ? 'replace' : 'find'));
      window.requestAnimationFrame(() => (findInput.current?.focus(), findInput.current?.select()));
      return;
    }
    if ((mod && k.toLowerCase() === 'h') || (mac && event.metaKey && event.altKey && k.toLowerCase() === 'f')) {
      event.preventDefault();
      event.stopPropagation();
      setFindOpen('replace');
      window.requestAnimationFrame(() => findInput.current?.focus());
      return;
    }
    if (k === 'F3') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
      return;
    }
    if (k === 'Escape' && findOpen) {
      event.preventDefault();
      setFindOpen(null);
      return;
    }
    if (k === 'Backspace' && !mod && !event.altKey) return take(deletePair(element.value, sel));
    if (k.length === 1 && !mod && !event.altKey && '([{"\'`)]}'.includes(k)) return take(typeBracket(element.value, sel, k));
    onKeyDown?.(event);
  };

  const replaceOne = () => {
    const match = found.matches[current];
    if (!match) return;
    const result = replaceAll(value.slice(match.start, match.end), query, replacement, options);
    apply({ from: match.start, to: match.end, insert: result.text, select: { start: match.start + result.text.length, end: match.start + result.text.length } });
  };
  const replaceEvery = () => {
    const result = replaceAll(value, query, replacement, options);
    if (result.count) apply({ from: 0, to: value.length, insert: result.text, select: { start: 0, end: 0 } });
  };

  return (
    <div className={`ce${minimap ? ' has-map' : ''}`} style={{ '--ce-fs': `${fontSize}px`, '--ce-lh': `${lineHeight}px`, '--ce-gutter': `${gutterWidth}px` } as React.CSSProperties}>
      <div className="ce-scroll" ref={scroller} onScroll={(event) => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
        <div className={`ce-inner${wrap ? ' is-wrap' : ''}`} style={wrap ? undefined : { height: PAD_Y * 2 + lines.length * lineHeight, width: `max(100%, ${gutterWidth + PAD_X * 2 + (widest + 4) * charWidth}px)` }}>
          {wrap ? (
            <div className="ce-gutter ce-gutter-rows" aria-hidden="true">
              {lines.map((_, index) => (
                <span key={index} style={{ top: topOf(index + 1) }} className={index + 1 === caretLine ? 'is-on' : undefined}>
                  {index + 1}
                </span>
              ))}
            </div>
          ) : (
            <pre className="ce-gutter" aria-hidden="true" dangerouslySetInnerHTML={{ __html: lines.map((_, index) => (index + 1 === caretLine ? `<b>${index + 1}</b>` : String(index + 1))).join('\n') }} />
          )}
          <div className="ce-current" style={{ top: topOf(caretLine), height: heightOf(caretLine) }} aria-hidden="true" />
          {marks ? <pre className="ce-layer ce-marks" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `${marks}\n` }} /> : null}
          {wrap ? (
            // A box a line, so each line's rows can be measured; the first in the flow, so it gives the editor its height.
            <div className="ce-layer ce-shadow ce-shadow-lines" aria-hidden="true" ref={shadowLines} dangerouslySetInnerHTML={{ __html: html.split('\n').map((line) => `<div>${line}</div>`).join('') }} />
          ) : (
            <pre className="ce-layer ce-shadow" aria-hidden="true">
              <code dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
            </pre>
          )}
          <textarea
            ref={text}
            className="ce-layer ce-text"
            value={value}
            wrap={wrap ? 'soft' : 'off'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={readOnly ? `${path}, read-only` : `Editing ${path}`}
            readOnly={readOnly}
            onChange={(event) => {
              if (readOnly) return;
              onChange(event.target.value);
              window.requestAnimationFrame(() => (report(), reveal()));
            }}
            onKeyDown={keys}
            onKeyUp={report}
            onClick={report}
            onSelect={report}
            onFocus={() => (report(), onFocus?.())}
          />
        </div>
      </div>
      {minimap ? (
        <canvas
          ref={map}
          className="ce-map"
          aria-hidden="true"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            scrollFromMap(event.clientY);
          }}
          onPointerMove={(event) => event.buttons === 1 && scrollFromMap(event.clientY)}
        />
      ) : null}
      {findOpen ? (
        <div className="ce-find" role="search" onKeyDown={(event) => event.key === 'Escape' && (setFindOpen(null), text.current?.focus())}>
          <button type="button" className="ce-find-fold" onClick={() => setFindOpen(findOpen === 'replace' ? 'find' : 'replace')} aria-label={findOpen === 'replace' ? 'Hide replace' : 'Show replace'} title="Toggle Replace">
            {findOpen === 'replace' ? '▾' : '▸'}
          </button>
          <div className="ce-find-rows">
            <div className="ce-find-row">
              <input
                ref={findInput}
                value={query}
                placeholder="Find"
                aria-label="Find"
                spellCheck={false}
                className={found.error ? 'is-bad' : ''}
                title={found.error}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    step(event.shiftKey ? -1 : 1);
                  }
                }}
              />
              <button type="button" className={`ce-opt${options.caseSensitive ? ' is-on' : ''}`} aria-pressed={Boolean(options.caseSensitive)} onClick={() => setOptions({ ...options, caseSensitive: !options.caseSensitive })} title="Match Case">
                Aa
              </button>
              <button type="button" className={`ce-opt${options.wholeWord ? ' is-on' : ''}`} aria-pressed={Boolean(options.wholeWord)} onClick={() => setOptions({ ...options, wholeWord: !options.wholeWord })} title="Match Whole Word">
                <u>ab</u>
              </button>
              <button type="button" className={`ce-opt${options.regex ? ' is-on' : ''}`} aria-pressed={Boolean(options.regex)} onClick={() => setOptions({ ...options, regex: !options.regex })} title="Use Regular Expression">
                .*
              </button>
              <span className="ce-count">{query ? (found.matches.length ? `${current + 1} of ${found.matches.length}` : 'No results') : ''}</span>
              <button type="button" className="ce-opt" onClick={() => step(-1)} disabled={!found.matches.length} title="Previous Match (⇧↵)" aria-label="Previous match">
                ↑
              </button>
              <button type="button" className="ce-opt" onClick={() => step(1)} disabled={!found.matches.length} title="Next Match (↵)" aria-label="Next match">
                ↓
              </button>
              <button type="button" className="ce-opt" onClick={() => (setFindOpen(null), text.current?.focus())} title="Close (Escape)" aria-label="Close find">
                <CloseIcon size={12} />
              </button>
            </div>
            {findOpen === 'replace' ? (
              <div className="ce-find-row">
                <input value={replacement} placeholder="Replace" aria-label="Replace" spellCheck={false} onChange={(event) => setReplacement(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), replaceOne())} />
                <button type="button" className="ce-opt is-word" onClick={replaceOne} disabled={!found.matches.length} title="Replace (↵)">
                  Replace
                </button>
                <button type="button" className="ce-opt is-word" onClick={replaceEvery} disabled={!found.matches.length} title="Replace All">
                  All
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default CodeEditor;
