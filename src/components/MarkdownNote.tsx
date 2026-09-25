import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { drawnNote, toggleCheck } from '../lib/noteMarkdown';
import { typesetMath } from '../lib/typesetMath';

/**
 * A piece of writing: drawn as Markdown — headings, lists, checklists,
 * maths — until it is clicked, then the text itself to edit; drawn again
 * when it is left. A checklist's box is ticked without opening it. Empty,
 * it is open to write in.
 */
export default function MarkdownNote({
  md,
  onChange,
  placeholder = 'Write…',
  label = 'Your note',
  focus = false,
  className = '',
}: {
  md: string;
  onChange: (md: string) => void;
  placeholder?: string;
  label?: string;
  /** Opened and focused as it is drawn: a note just made. */
  focus?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(focus || !md.trim());
  const area = useRef<HTMLTextAreaElement>(null);
  const shown = useRef<HTMLDivElement>(null);
  const html = useMemo(() => drawnNote(md), [md]);

  const grow = () => {
    if (!area.current) return;
    area.current.style.height = 'auto';
    area.current.style.height = `${area.current.scrollHeight + 2}px`;
  };
  useLayoutEffect(grow);
  useEffect(() => {
    if (!editing) void typesetMath(shown.current);
  }, [editing, html]);
  // A note just made is written in at once — focused as it is drawn, and
  // again a frame later in case what drew it took the focus back.
  useLayoutEffect(() => {
    if (!focus) return;
    setEditing(true);
    area.current?.focus();
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== area.current) area.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  if (editing)
    return (
      <textarea
        ref={area}
        className={`note-write ${className}`}
        value={md}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => {
          onChange(event.target.value);
          grow();
        }}
        onBlur={() => md.trim() && setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            event.currentTarget.blur();
          }
        }}
      />
    );
  return (
    <div
      ref={shown}
      className={`note-shown doc-shown ${className}`}
      tabIndex={0}
      role="button"
      aria-label={`${label} — click to edit`}
      onClick={(event) => {
        const box = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-check]') : null;
        if (box) {
          onChange(toggleCheck(md, Number(box.dataset.check)));
          return;
        }
        setEditing(true);
        requestAnimationFrame(() => {
          const element = area.current;
          if (!element) return;
          element.focus();
          element.setSelectionRange(element.value.length, element.value.length);
        });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          setEditing(true);
          requestAnimationFrame(() => area.current?.focus());
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
