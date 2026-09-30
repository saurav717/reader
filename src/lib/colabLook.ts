// ===========================================================================
//  The reader's look for Colab. Colab's page, shown in the Colab tab through
//  the proxy's browser, is Colab's: white or its own dark, Roboto, its own
//  header with the notebook's name and Share. This is the stylesheet the tab
//  places into that page (a 'look' input, server/browseShared.js) so it
//  belongs here instead: the reader's colours and type put onto Colab's own
//  theme variables — Colab themes itself through `--colab-*` custom
//  properties on <body>, which is what its light, dark and adaptive
//  settings set — its top bar hidden, since the reader's strip names the
//  notebook and the runtime, and its cells drawn as the reader draws its
//  own. The variables are Colab's public theme surface; the few ids and
//  classes beside them are Colab's page as it is today, and a change on
//  Colab's side changes what they reach. Pure functions, for the tests.
// ===========================================================================

export interface ReaderTokens {
  paper: string;
  surface: string;
  panel: string;
  ink: string;
  ink2: string;
  muted: string;
  border: string;
  accent: string;
  accentSoft: string;
  sans: string;
  mono: string;
}

export type Scheme = 'dark' | 'light';

/** The reader's tokens as they stand, read off the document: the theme, glass and all. */
export function readerTokens(root: Element = document.documentElement): ReaderTokens {
  const style = getComputedStyle(root);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    paper: token('--paper', '#fbfaf6'),
    surface: token('--surface', '#fffdf7'),
    panel: token('--panel', '#f4f1e8'),
    ink: token('--ink', '#1a1a17'),
    ink2: token('--ink-2', '#55524a'),
    muted: token('--muted', '#6f6c63'),
    border: token('--border', '#e2ddce'),
    accent: token('--accent', '#1f5e52'),
    accentSoft: token('--accent-soft', '#e4efe7'),
    sans: token('--sans', 'system-ui, sans-serif'),
    mono: token('--mono', 'ui-monospace, monospace'),
  };
}

/** The theme the document is in, as its root says: dark, or light. */
export const schemeOf = (root: Element = document.documentElement): Scheme => (root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

/** A token as it goes into a stylesheet: nothing that could close the declaration, open a comment, or end the sheet. */
const safe = (value: string) => value.replace(/\/\*|\*\/|[;{}<>\r\n]/g, '').trim();

/**
 * The look: the scheme for Colab to follow, and the sheet. Colab's own
 * variables first, so everything Colab paints with them follows; then the
 * parts of the page the strip above already says; then the cells.
 */
export function colabLook(scheme: Scheme, tokens: ReaderTokens): { scheme: Scheme; css: string } {
  const t = Object.fromEntries(Object.entries(tokens).map(([key, value]) => [key, safe(value)])) as unknown as ReaderTokens;
  const css = `/* The reader's look for Colab (src/lib/colabLook.ts): the reader's colours and type on Colab's theme variables. */
:root, body, body.theme-light, body.theme-dark, body.theme-adaptive {
  color-scheme: ${scheme};
  --colab-primary-surface-color: ${t.paper};
  --colab-secondary-surface-color: ${t.surface};
  --colab-tertiary-surface-color: ${t.panel};
  --colab-highlighted-surface-color: ${t.panel};
  --colab-primary-text-color: ${t.ink};
  --colab-secondary-text-color: ${t.muted};
  --colab-tertiary-text-color: ${t.ink2};
  --colab-title-color: ${t.ink};
  --colab-logo-dark: ${t.ink};
  --colab-border-color: ${t.border};
  --colab-bold-border-color: ${t.border};
  --colab-divider-color: ${t.border};
  --colab-icon-color: ${t.muted};
  --colab-icon-hover-color: ${t.ink};
  --colab-anchor-color: ${t.accent};
  --colab-input-placeholder-color: ${t.muted};
  --colab-editor-focus-color: ${t.accent};
  --colab-chrome-font-family: ${t.sans};
  --colab-code-font-family: ${t.mono};
  --colab-chrome-font-size: 13px;
  --colab-code-font-size: 13px;
}
body { background: ${t.paper} !important; color: ${t.ink} !important; font-family: ${t.sans} !important; }
/* Colab's own top bar — the notebook's name, Share, the account — says what the reader's strip already says. */
#header, header#header, #top-toolbar .header-spacer { display: none !important; }
/* The toolbar stays: + Code, + Text, the runtime chip; in the reader's panel colour, with its border. */
#top-toolbar, .top-toolbar { background: ${t.panel} !important; border-bottom: 1px solid ${t.border} !important; }
#top-toolbar a, #top-toolbar button, #top-toolbar .toolbar-button { color: ${t.accent} !important; }
/* The cells as the reader draws its own: rounded, bordered, on the surface colour, the focused one in the accent. */
.notebook-cell-list > .cell, .cell { border-radius: 12px !important; background: ${t.surface} !important; border: 1px solid ${t.border} !important; overflow: hidden; }
.notebook-cell-list > .cell.focused, .cell.focused { border-color: ${t.accent} !important; box-shadow: 0 0 0 1px ${t.accent} !important; }
.cell .inputarea, .codecell .main-content, .monaco-editor, .monaco-editor .margin, .monaco-editor-background, .monaco-editor .inputarea.ime-input { background: ${t.surface} !important; }
.cell .output, .cell .output-content, .output-iframe-container, .output_subarea { background: ${t.panel} !important; color: ${t.ink} !important; border-radius: 0 0 12px 12px; min-width: 0; max-width: 100%; overflow-x: auto; }
.cell .output pre, .output-content pre { font-family: ${t.mono} !important; color: ${t.ink} !important; }
colab-run-button, .cell-execution, .cell-execution-indicator { color: ${t.accent} !important; }
a, .anchor { color: ${t.accent} !important; }
::selection { background: ${t.accentSoft}; }
`;
  return { scheme, css };
}
