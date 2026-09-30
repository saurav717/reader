import { HIGHLIGHT_COLORS, type HighlightColor, type HighlightStyle } from '../types';

/**
 * How a selection is marked: painted over in one of the four colours, or a
 * plain black line drawn under it. Underlining has no colour to choose.
 */
export interface Mark {
  color: HighlightColor;
  style: HighlightStyle;
}

/** A plain underline. The colour is only kept because every mark has one; the line is black. */
export const UNDERLINE: Mark = { color: HIGHLIGHT_COLORS[0].id, style: 'underline' };

/** A highlight in a colour. */
export function highlightIn(color: HighlightColor): Mark {
  return { color, style: 'highlight' };
}

/**
 * The keys a live selection answers to: 1–4 highlight it in a colour, U draws
 * a black line under it, N highlights it and opens a note.
 * Returns whether the key was taken.
 */
export function markKey(event: KeyboardEvent, onPick: (mark: Mark, withNote: boolean) => void): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const position = Number(event.key);
  if (position >= 1 && position <= HIGHLIGHT_COLORS.length) {
    onPick(highlightIn(HIGHLIGHT_COLORS[position - 1].id), false);
    return true;
  }
  const key = event.key.toLowerCase();
  if (key === 'u') {
    onPick(UNDERLINE, false);
    return true;
  }
  if (key === 'n') {
    onPick(highlightIn(HIGHLIGHT_COLORS[0].id), true);
    return true;
  }
  return false;
}

/** The four highlight colours, and the underline — one black line, no colour to pick. */
export default function MarkPicker({ onPick }: { onPick: (mark: Mark) => void }) {
  return (
    <>
      {HIGHLIGHT_COLORS.map((colour, position) => (
        <button
          key={colour.id}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(highlightIn(colour.id))}
          aria-label={`Highlight: ${colour.label} (key ${position + 1})`}
          title={`Highlight — ${colour.label} — ${position + 1}`}
        >
          <span className="swatch" style={{ background: colour.swatch }} />
        </button>
      ))}
      <button
        type="button"
        className="mark-style"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPick(UNDERLINE)}
        aria-label="Underline (U)"
        title="Underline — U"
      >
        U
      </button>
    </>
  );
}
