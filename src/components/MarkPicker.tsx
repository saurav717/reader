import { useCallback, useEffect, useState } from 'react';
import { HIGHLIGHT_COLORS, type HighlightColor, type HighlightStyle } from '../types';

/**
 * Whether a selection is highlighted or underlined: one choice, the same in
 * Reflow mode and on the PDF's pages, remembered on this device. U flips it.
 */
const STYLE_KEY = 'reader.markStyle';
const STYLE_EVENT = 'reader:mark-style';

function savedStyle(): HighlightStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'underline' ? 'underline' : 'highlight';
  } catch {
    return 'highlight';
  }
}

export function useMarkStyle(): [HighlightStyle, (next: HighlightStyle) => void] {
  const [style, setStyle] = useState<HighlightStyle>(savedStyle);
  useEffect(() => {
    const onChange = (event: Event) => setStyle((event as CustomEvent<HighlightStyle>).detail);
    window.addEventListener(STYLE_EVENT, onChange);
    return () => window.removeEventListener(STYLE_EVENT, onChange);
  }, []);
  const choose = useCallback((next: HighlightStyle) => {
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {
      // A private window: the choice lasts as long as the page.
    }
    window.dispatchEvent(new CustomEvent(STYLE_EVENT, { detail: next }));
  }, []);
  return [style, choose];
}

/**
 * The keys a live selection answers to: 1–4 mark it in a colour, U flips
 * between highlighting and underlining, N marks it and opens a note.
 * Returns whether the key was taken.
 */
export function markKey(
  event: KeyboardEvent,
  style: HighlightStyle,
  onStyle: (next: HighlightStyle) => void,
  onPick: (color: HighlightColor, withNote: boolean) => void,
): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const position = Number(event.key);
  if (position >= 1 && position <= HIGHLIGHT_COLORS.length) {
    onPick(HIGHLIGHT_COLORS[position - 1].id, false);
    return true;
  }
  const key = event.key.toLowerCase();
  if (key === 'u') {
    onStyle(style === 'underline' ? 'highlight' : 'underline');
    return true;
  }
  if (key === 'n') {
    onPick(HIGHLIGHT_COLORS[0].id, true);
    return true;
  }
  return false;
}

/** The four colours, drawn as dots or as lines by the style picked, and the switch between the two. */
export default function MarkPicker({
  style,
  onStyle,
  onPick,
}: {
  style: HighlightStyle;
  onStyle: (next: HighlightStyle) => void;
  onPick: (color: HighlightColor) => void;
}) {
  const underline = style === 'underline';
  return (
    <>
      {HIGHLIGHT_COLORS.map((colour, position) => (
        <button
          key={colour.id}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(colour.id)}
          aria-label={`${underline ? 'Underline' : 'Highlight'}: ${colour.label} (key ${position + 1})`}
          title={`${underline ? 'Underline' : 'Highlight'} — ${colour.label} — ${position + 1}`}
        >
          <span
            className={`swatch${underline ? ' is-underline' : ''}`}
            style={underline ? { borderBottomColor: colour.swatch } : { background: colour.swatch }}
          />
        </button>
      ))}
      <button
        type="button"
        className="mark-style"
        aria-pressed={underline}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStyle(underline ? 'highlight' : 'underline')}
        aria-label={underline ? 'Underlining — switch to highlighting (U)' : 'Highlighting — switch to underlining (U)'}
        title={underline ? 'Underlining — the colours draw a line under the text. U to highlight instead' : 'Underline instead of highlight (U)'}
      >
        U
      </button>
    </>
  );
}
