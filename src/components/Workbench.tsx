// The playground workbench's VS Code pieces, apart from the editor itself:
// Quick Open and the command palette in one box (⌘P files, > commands,
// : a line, @ a symbol), the right-click menus, the Outline view and the
// Open Editors list, and the activity bar's few marks of its own.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeSymbol } from '../lib/editing';
import { fuzzyScore } from '../lib/editing';
import type { FileHost } from '../lib/playground';
import { listAll } from '../lib/projectAgent';
import FileIcon from './FileIcon';
import { CloseIcon } from './icons';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** A shortcut as this computer writes it: ⇧⌘P on a Mac, Ctrl+Shift+P elsewhere. */
export const keyLabel = (combo: string) =>
  combo
    .split(' ')
    .map((chord) => {
      const parts = chord.split('+');
      const key = parts.pop() ?? '';
      const shown = key.length === 1 ? key.toUpperCase() : key === 'enter' ? (isMac ? '↵' : 'Enter') : key;
      if (isMac) return `${parts.includes('ctrl') ? '⌃' : ''}${parts.includes('alt') ? '⌥' : ''}${parts.includes('shift') ? '⇧' : ''}${parts.includes('mod') ? '⌘' : ''}${shown}`;
      return [...parts.map((p) => (p === 'mod' || p === 'ctrl' ? 'Ctrl' : p === 'alt' ? 'Alt' : 'Shift')).filter((p, i, all) => all.indexOf(p) === i), shown].join('+');
    })
    .join(' ');

/** A name with the letters a query matched in it marked, as Quick Open shows them. */
function Marked({ text, hits }: { text: string; hits: number[] }) {
  if (!hits.length) return <>{text}</>;
  const set = new Set(hits);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  );
}

export function SymbolMark({ kind }: { kind: CodeSymbol['kind'] }) {
  const letter = kind === 'class' ? 'C' : kind === 'heading' ? '#' : kind === 'variable' ? 'v' : 'ƒ';
  return (
    <span className={`vs-sym is-${kind}`} aria-hidden="true">
      {letter}
    </span>
  );
}

interface Command {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
}

/**
 * Quick Open and the command palette, as VS Code's one box: what is typed
 * first says what it lists — nothing for the folder's files, > for commands,
 * : for a line, @ for the symbols of the file in front.
 */
export function QuickPick({ initial, host, commands, symbols, lines, onClose, onFile, onLine }: { initial: string; host: FileHost; commands: Command[]; symbols: CodeSymbol[]; lines: number; onClose: () => void; onFile: (path: string, side: boolean) => void; onLine: (line: number) => void }) {
  const [text, setText] = useState(initial);
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const mode = text.startsWith('>') ? 'commands' : text.startsWith(':') ? 'line' : text.startsWith('@') ? 'symbols' : 'files';
  const query = mode === 'files' ? text.trim() : text.slice(1).trim();
  useEffect(() => {
    input.current?.focus();
    const at = initial.length;
    input.current?.setSelectionRange(at, at);
  }, [initial]);
  useEffect(() => {
    if (mode !== 'files' || files) return;
    let live = true;
    void listAll(host, 2000).then((all) => live && setFiles(all.map((f) => f.path)));
    return () => {
      live = false;
    };
  }, [mode, files, host]);
  useEffect(() => setCursor(0), [text]);

  type Row = { key: string; title: string; hits: number[]; sub?: string; keys?: string; icon?: React.ReactNode; pick: (side?: boolean) => void };
  const rows: Row[] = useMemo(() => {
    if (mode === 'commands') {
      return commands
        .map((c) => ({ c, m: fuzzyScore(query, c.label) }))
        .filter((r) => r.m)
        .sort((a, b) => (query ? b.m!.score - a.m!.score : 0))
        .slice(0, 60)
        .map(({ c, m }) => ({ key: c.id, title: c.label, hits: m!.hits, keys: c.keys, pick: () => (onClose(), window.setTimeout(c.run, 0)) }));
    }
    if (mode === 'line') {
      const [lineText, colText] = query.split(/[:,]/);
      const line = Number(lineText);
      if (!lines) return [{ key: 'none', title: 'Open a file first, to go to a line in it.', hits: [], pick: () => undefined }];
      if (!query || !Number.isFinite(line) || line < 1) return [{ key: 'hint', title: `Type a line number between 1 and ${lines} to go to.`, hits: [], pick: () => undefined }];
      const target = Math.min(line, lines);
      return [{ key: 'go', title: `Go to line ${target}${colText ? `, column ${colText}` : ''}.`, hits: [], pick: () => (onClose(), window.setTimeout(() => onLine(target), 0)) }];
    }
    if (mode === 'symbols') {
      if (!symbols.length) return [{ key: 'none', title: lines ? 'No symbols in this file.' : 'Open a file first.', hits: [], pick: () => undefined }];
      return symbols
        .map((s) => ({ s, m: fuzzyScore(query, s.name) }))
        .filter((r) => r.m)
        .sort((a, b) => (query ? b.m!.score - a.m!.score : a.s.line - b.s.line))
        .map(({ s, m }) => ({ key: `${s.line}-${s.name}`, title: s.name, hits: m!.hits, sub: `line ${s.line}`, icon: <SymbolMark kind={s.kind} />, pick: () => (onClose(), window.setTimeout(() => onLine(s.line), 0)) }));
    }
    if (!files) return [{ key: 'loading', title: 'Reading the folder…', hits: [], pick: () => undefined }];
    return files
      .map((path) => ({ path, m: fuzzyScore(query, path) }))
      .filter((r) => r.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .slice(0, 60)
      .map(({ path, m }) => {
        const base = path.lastIndexOf('/') + 1;
        return { key: path, title: path.slice(base), hits: m!.hits.filter((h) => h >= base).map((h) => h - base), sub: path.slice(0, Math.max(0, base - 1)), icon: <FileIcon path={path} />, pick: (side = false) => (onClose(), window.setTimeout(() => onFile(path, side), 0)) };
      });
  }, [mode, query, commands, files, symbols, lines, onClose, onFile, onLine]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('.is-on')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="vs-pick-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="vs-pick" role="dialog" aria-label={mode === 'commands' ? 'Command palette' : 'Quick open'}>
        <input
          ref={input}
          autoFocus
          value={text}
          spellCheck={false}
          aria-label="Search"
          placeholder={mode === 'files' ? 'Search files by name (append : to go to a line, > for commands, @ for symbols)' : ''}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') (event.preventDefault(), setCursor((c) => Math.min(rows.length - 1, c + 1)));
            else if (event.key === 'ArrowUp') (event.preventDefault(), setCursor((c) => Math.max(0, c - 1)));
            else if (event.key === 'Enter') {
              event.preventDefault();
              rows[cursor]?.pick(event.metaKey || event.ctrlKey);
            }
          }}
        />
        <ul ref={list} role="listbox">
          {rows.length ? (
            rows.map((row, index) => (
              <li key={row.key}>
                <button type="button" role="option" aria-selected={index === cursor} className={index === cursor ? 'is-on' : ''} onMouseMove={() => setCursor(index)} onClick={(event) => row.pick(event.metaKey || event.ctrlKey)}>
                  {row.icon}
                  <span className="vs-pick-title">
                    <Marked text={row.title} hits={row.hits} />
                  </span>
                  {row.sub ? <span className="vs-pick-sub">{row.sub}</span> : null}
                  {row.keys ? <kbd>{keyLabel(row.keys)}</kbd> : null}
                </button>
              </li>
            ))
          ) : (
            <li className="vs-pick-none">{mode === 'commands' ? 'No matching commands' : 'No matching results'}</li>
          )}
        </ul>
      </div>
    </div>
  );
}

interface MenuItem {
  label: string;
  keys?: string;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** A right-click menu where the click was, kept on screen; any click away or Escape closes it. */
export function ContextMenu({ menu, onClose }: { menu: { x: number; y: number; items: (MenuItem | 'sep')[] }; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    const el = box.current;
    if (el) setAt({ x: Math.min(menu.x, window.innerWidth - el.offsetWidth - 8), y: Math.min(menu.y, window.innerHeight - el.offsetHeight - 8) });
    const away = (event: MouseEvent) => !box.current?.contains(event.target as Node) && onClose();
    const key = (event: KeyboardEvent) => event.key === 'Escape' && (event.stopPropagation(), onClose());
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [menu, onClose]);
  return (
    <div ref={box} className="menu vs-menu" role="menu" style={{ left: at.x, top: at.y }} onContextMenu={(event) => event.preventDefault()}>
      {menu.items.map((item, index) =>
        item === 'sep' ? (
          <hr key={index} />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={item.danger ? 'is-danger' : ''}
            onClick={() => {
              onClose();
              item.run?.();
            }}
          >
            <span>{item.label}</span>
            {item.keys ? <kbd>{item.keys}</kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}

/** The Outline view: the file in front's classes, functions and headings, the one the caret is in lit; a click goes there. */
export function OutlineView({ file, symbols, line, onGo }: { file: { path: string } | null; symbols: CodeSymbol[]; line: number; onGo: (line: number) => void }) {
  if (!file) return <p className="pg-note pg-pad">Open a file to see its outline.</p>;
  if (!symbols.length) return <p className="pg-note pg-pad">No symbols found in {file.path.split('/').pop()}.</p>;
  const here = [...symbols].reverse().find((s) => s.line <= line);
  return (
    <ul className="vs-outline">
      {symbols.map((symbol) => (
        <li key={`${symbol.line}-${symbol.name}`}>
          <button type="button" className={`pg-entry${symbol === here ? ' is-on' : ''}`} style={{ paddingLeft: 12 + symbol.depth * 14 }} onClick={() => onGo(symbol.line)}>
            <SymbolMark kind={symbol.kind} />
            {symbol.name}
            <small>{symbol.line}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Open Editors, at the top of the Explorer: every tab, by group when the editor is split. */
export function OpenEditors({ items, split, activeKey, focusedGroup, onShow, onClose }: { items: { key: string; group: number; file: { path: string; text: string; saved: string } }[]; split: boolean; activeKey: string | null; focusedGroup: number; onShow: (key: string, group: number) => void; onClose: (key: string, group: number) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pg-tree-part vs-open-editors">
      <button type="button" className={`pg-tree-head vs-section${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="vs-chev" aria-hidden="true">›</span>
        <span>Open Editors</span>
      </button>
      {open ? (
        <ul className="pg-folder">
          {items.map(({ key, group, file }, index) => (
            <li key={`${group}-${key}`}>
              {split && (index === 0 || items[index - 1].group !== group) ? <div className="vs-oe-group">Group {group + 1}</div> : null}
              <div className={`vs-oe${key === activeKey && group === focusedGroup ? ' is-on' : ''}`}>
                <button type="button" className="vs-oe-x" onClick={() => onClose(key, group)} aria-label={`Close ${file.path}`} title="Close">
                  {file.text !== file.saved ? <span className="vs-dot">●</span> : <CloseIcon size={11} />}
                </button>
                <button type="button" className="pg-entry" onClick={() => onShow(key, group)} title={file.path}>
                  <FileIcon path={file.path} />
                  {file.path.split('/').pop()}
                  <small>{file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : ''}</small>
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const OutlineGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h3M10 6h10M7 12h3M13 12h7M7 18h3M13 18h7" />
  </svg>
);
export const SplitGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);
export const PaletteGlyph = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="m7 10 3 2-3 2M12 15h5" />
  </svg>
);
export const FolderPlusGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </svg>
);
