// The site's look as VS Code colour themes, Reader Light and Reader Dark, made
// from the tokens in src/styles.css (paper, ink, accent, the code colours) so
// the editor and the site stay one design. scripts/build-vscode.mjs writes them
// into vscode/themes/ and the .vsix; scripts/vscode.test.mjs checks the
// committed files are current.
//   node scripts/vscode-themes.mjs   (rewrites vscode/themes/*.json)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The custom properties set on `:root` (light) and `:root[data-theme='dark']` (dark), across every such block in the stylesheet. */
export function siteTokens(css) {
  const light = {};
  const dark = {};
  for (const block of css.matchAll(/(^|\n)(:root(?:\[data-theme='dark'\])?)\s*\{([^}]*)\}/g)) {
    const into = block[2] === ':root' ? light : dark;
    for (const decl of block[3].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) into[decl[1]] = decl[2].trim();
  }
  return { light, dark: { ...light, ...dark } };
}

// The terminal's ANSI colours, as src/components/Terminal.tsx draws them.
const ANSI = {
  light: ['#1a1a17', '#b5435a', '#2f7d4f', '#9a7a00', '#1f5e9e', '#8a3ea6', '#1f6f72', '#6f6c63', '#55524a', '#c9566c', '#3c9160', '#b0571c', '#3a78bd', '#a55bc0', '#2c8a8d', '#1a1a17'],
  dark: ['#25272d', '#e08592', '#93cfa6', '#e6c46f', '#8bb8ec', '#c99ae0', '#7cc7c4', '#c3bfb4', '#9b978c', '#f0a3ae', '#b3e3c1', '#f2d68f', '#a9cdf5', '#ddb8ef', '#9fdcd9', '#eae7df'],
};
const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

/** #rrggbb with an alpha, as VS Code takes it (#rrggbbaa). */
const a = (hex, alpha) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;

export function vscodeTheme(t, dark) {
  const ink = t.ink;
  const accent = t.accent;
  const colors = {
    focusBorder: a(accent, 0.6),
    foreground: ink,
    descriptionForeground: t.muted,
    disabledForeground: a(t.muted, 0.6),
    errorForeground: t.danger,
    'icon.foreground': t['ink-2'],
    'selection.background': a(accent, 0.25),
    'textLink.foreground': dark ? t['accent-ink'] : accent,
    'textLink.activeForeground': dark ? t['accent-ink'] : t['accent-ink'],
    'textPreformat.foreground': t['tok-f'],
    'textBlockQuote.background': t.panel,
    'textBlockQuote.border': t.border,
    'widget.border': t.border,
    'widget.shadow': dark ? '#00000066' : '#1a1a1722',
    'sash.hoverBorder': accent,
    'button.background': accent,
    'button.foreground': t['accent-on'],
    'button.hoverBackground': dark ? t['accent-ink'] : t['accent-ink'],
    'button.secondaryBackground': t.panel,
    'button.secondaryForeground': ink,
    'button.secondaryHoverBackground': t.border,
    'badge.background': accent,
    'badge.foreground': t['accent-on'],
    'input.background': dark ? t.paper : t.surface,
    'input.foreground': ink,
    'input.border': t.border,
    'input.placeholderForeground': t.muted,
    'inputOption.activeBorder': accent,
    'inputOption.activeBackground': t['accent-soft'],
    'inputValidation.errorBorder': t.danger,
    'dropdown.background': t.surface,
    'dropdown.border': t.border,
    'dropdown.foreground': ink,
    'checkbox.background': t.surface,
    'checkbox.border': t.border,
    'scrollbarSlider.background': a(accent, 0.16),
    'scrollbarSlider.hoverBackground': a(accent, 0.28),
    'scrollbarSlider.activeBackground': a(accent, 0.4),
    'scrollbar.shadow': '#00000000',
    'progressBar.background': accent,
    'activityBar.background': t.rail,
    'activityBar.foreground': accent,
    'activityBar.inactiveForeground': t.muted,
    'activityBar.border': t.border,
    'activityBar.activeBorder': accent,
    'activityBar.activeBackground': t.surface,
    'activityBarBadge.background': accent,
    'activityBarBadge.foreground': t['accent-on'],
    'sideBar.background': t.panel,
    'sideBar.foreground': t['ink-2'],
    'sideBar.border': t.border,
    'sideBarTitle.foreground': t.muted,
    'sideBarSectionHeader.background': t.panel,
    'sideBarSectionHeader.foreground': t.muted,
    'sideBarSectionHeader.border': t['border-soft'],
    'list.activeSelectionBackground': t['accent-soft'],
    'list.activeSelectionForeground': dark ? ink : t['accent-ink'],
    'list.activeSelectionIconForeground': dark ? t['accent-ink'] : accent,
    'list.inactiveSelectionBackground': a(t['accent-soft'], 0.7),
    'list.hoverBackground': dark ? t.surface : t.rail,
    'list.focusOutline': a(accent, 0.6),
    'list.highlightForeground': dark ? t['accent-ink'] : accent,
    'list.errorForeground': t.danger,
    'list.warningForeground': t['tok-n'],
    'tree.indentGuidesStroke': t.border,
    'editor.background': t.paper,
    'editor.foreground': ink,
    'editorLineNumber.foreground': a(t.muted, 0.6),
    'editorLineNumber.activeForeground': t['ink-2'],
    'editorCursor.foreground': accent,
    'editor.selectionBackground': a(accent, dark ? 0.32 : 0.2),
    'editor.inactiveSelectionBackground': a(accent, 0.12),
    'editor.selectionHighlightBackground': a(accent, 0.1),
    'editor.wordHighlightBackground': a(accent, 0.1),
    'editor.wordHighlightStrongBackground': a(accent, 0.16),
    'editor.findMatchBackground': dark ? '#e8cc4a55' : '#faeda2',
    'editor.findMatchHighlightBackground': dark ? '#e8cc4a2a' : '#faeda280',
    'editor.lineHighlightBackground': dark ? t.panel : t.panel,
    'editor.lineHighlightBorder': '#00000000',
    'editor.rangeHighlightBackground': a(accent, 0.06),
    'editorIndentGuide.background1': t['border-soft'],
    'editorIndentGuide.activeBackground1': t.border,
    'editorWhitespace.foreground': t.border,
    'editorBracketMatch.background': t['accent-soft'],
    'editorBracketMatch.border': a(accent, 0.4),
    'editorLink.activeForeground': accent,
    'editorGutter.background': t.paper,
    'editorGutter.modifiedBackground': t['tok-n'],
    'editorGutter.addedBackground': t['tok-s'],
    'editorGutter.deletedBackground': t.danger,
    'editorRuler.foreground': t['border-soft'],
    'editorCodeLens.foreground': t.muted,
    'editorWidget.background': t.surface,
    'editorWidget.border': t.border,
    'editorSuggestWidget.background': t.surface,
    'editorSuggestWidget.border': t.border,
    'editorSuggestWidget.selectedBackground': t['accent-soft'],
    'editorSuggestWidget.highlightForeground': dark ? t['accent-ink'] : accent,
    'editorHoverWidget.background': t.surface,
    'editorHoverWidget.border': t.border,
    'editorError.foreground': t.danger,
    'editorWarning.foreground': t['tok-n'],
    'editorInfo.foreground': t['tok-f'],
    'editorGroupHeader.tabsBackground': t.panel,
    'editorGroupHeader.tabsBorder': t.border,
    'editorGroup.border': t.border,
    'tab.activeBackground': t.paper,
    'tab.activeForeground': ink,
    'tab.inactiveBackground': t.panel,
    'tab.inactiveForeground': t.muted,
    'tab.border': t.border,
    'tab.activeBorderTop': accent,
    'tab.hoverBackground': t.paper,
    'tab.unfocusedActiveBorderTop': t.border,
    'tab.unfocusedActiveForeground': t['ink-2'],
    'breadcrumb.background': t.paper,
    'breadcrumb.foreground': t.muted,
    'breadcrumb.focusForeground': ink,
    'titleBar.activeBackground': t.rail,
    'titleBar.activeForeground': t['ink-2'],
    'titleBar.inactiveBackground': t.rail,
    'titleBar.inactiveForeground': t.muted,
    'titleBar.border': t.border,
    'commandCenter.background': t.surface,
    'commandCenter.border': t.border,
    'statusBar.background': accent,
    'statusBar.foreground': t['accent-on'],
    'statusBar.border': accent,
    'statusBar.noFolderBackground': accent,
    'statusBar.debuggingBackground': t['tok-n'],
    'statusBar.debuggingForeground': dark ? t.paper : '#ffffff',
    'statusBarItem.hoverBackground': '#ffffff22',
    'statusBarItem.remoteBackground': t['accent-ink'],
    'statusBarItem.remoteForeground': dark ? t.paper : t['accent-on'],
    'panel.background': t.paper,
    'panel.border': t.border,
    'panelTitle.activeForeground': ink,
    'panelTitle.activeBorder': accent,
    'panelTitle.inactiveForeground': t.muted,
    'terminal.background': t.paper,
    'terminal.foreground': ink,
    'terminalCursor.foreground': accent,
    'terminal.selectionBackground': a(accent, dark ? 0.38 : 0.22),
    'notifications.background': t.surface,
    'notifications.border': t.border,
    'notificationCenterHeader.background': t.panel,
    'notificationLink.foreground': dark ? t['accent-ink'] : accent,
    'quickInput.background': t.surface,
    'quickInputList.focusBackground': t['accent-soft'],
    'quickInputList.focusForeground': ink,
    'quickInputTitle.background': t.panel,
    'pickerGroup.foreground': dark ? t['accent-ink'] : accent,
    'pickerGroup.border': t.border,
    'menu.background': t.surface,
    'menu.foreground': ink,
    'menu.selectionBackground': t['accent-soft'],
    'menu.selectionForeground': ink,
    'menu.separatorBackground': t.border,
    'menu.border': t.border,
    'peekView.border': accent,
    'peekViewEditor.background': t.surface,
    'peekViewResult.background': t.panel,
    'peekViewTitle.background': t.panel,
    'gitDecoration.modifiedResourceForeground': t['tok-n'],
    'gitDecoration.untrackedResourceForeground': t['tok-s'],
    'gitDecoration.addedResourceForeground': t['tok-s'],
    'gitDecoration.deletedResourceForeground': t.danger,
    'gitDecoration.ignoredResourceForeground': a(t.muted, 0.7),
    'minimap.background': t.paper,
    'notebook.cellEditorBackground': t.surface,
    'notebook.cellBorderColor': t.border,
    'notebook.focusedCellBorder': accent,
    'notebook.selectedCellBackground': a(t['accent-soft'], 0.5),
    'notebook.cellToolbarSeparator': t.border,
    'welcomePage.tileBackground': t.surface,
    'keybindingLabel.background': t.surface,
    'keybindingLabel.border': t.border,
    'keybindingLabel.foreground': t['ink-2'],
    'settings.headerForeground': ink,
    'settings.modifiedItemIndicator': accent,
  };
  ANSI[dark ? 'dark' : 'light'].forEach((hex, i) => {
    colors[`terminal.ansi${i < 8 ? '' : 'Bright'}${ANSI_NAMES[i % 8]}`] = hex;
  });
  const scope = (scopes, foreground, fontStyle) => ({ scope: scopes, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } });
  return {
    $schema: 'vscode://schemas/color-theme',
    name: dark ? 'Reader Dark' : 'Reader Light',
    type: dark ? 'dark' : 'light',
    semanticHighlighting: true,
    colors,
    tokenColors: [
      scope(['comment', 'punctuation.definition.comment', 'string.quoted.docstring'], t['tok-c'], 'italic'),
      scope(['string', 'string.quoted', 'string.template', 'markup.inline.raw'], t['tok-s']),
      scope(['constant.character.escape', 'constant.other.placeholder'], t['tok-n']),
      scope(['keyword', 'keyword.control', 'keyword.operator.logical', 'keyword.operator.new', 'storage', 'storage.type', 'storage.modifier', 'variable.language.self', 'variable.language.this'], t['tok-k']),
      scope(['constant.numeric', 'constant.language', 'support.constant', 'constant.other.caps'], t['tok-n']),
      scope(['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.name.type', 'entity.name.class', 'support.class', 'support.type', 'entity.other.inherited-class'], t['tok-f']),
      scope(['entity.name.tag', 'meta.decorator', 'entity.name.function.decorator', 'punctuation.definition.decorator'], t['tok-k']),
      scope(['entity.other.attribute-name', 'variable.parameter'], t['ink-2']),
      scope(['variable', 'variable.other', 'meta.definition.variable'], ink),
      scope(['punctuation', 'meta.brace', 'keyword.operator'], t['ink-2']),
      scope(['markup.heading', 'entity.name.section'], dark ? t['accent-ink'] : accent, 'bold'),
      scope(['markup.bold'], ink, 'bold'),
      scope(['markup.italic'], ink, 'italic'),
      scope(['markup.underline.link', 'string.other.link'], t['tok-f']),
      scope(['markup.quote'], t['ink-2'], 'italic'),
      scope(['markup.inserted'], t['tok-s']),
      scope(['markup.deleted'], t.danger),
      scope(['invalid'], t.danger),
    ],
    semanticTokenColors: {
      function: t['tok-f'],
      method: t['tok-f'],
      class: t['tok-f'],
      type: t['tok-f'],
      keyword: t['tok-k'],
      number: t['tok-n'],
      string: t['tok-s'],
      parameter: t['ink-2'],
      'variable.readonly': t['tok-n'],
      decorator: t['tok-k'],
    },
  };
}

/** Both themes, as the files the extension ships: name → JSON text. */
export function themeFiles(css = readFileSync(join(here, '..', 'src', 'styles.css'), 'utf8')) {
  const tokens = siteTokens(css);
  return {
    'themes/reader-light-color-theme.json': `${JSON.stringify(vscodeTheme(tokens.light, false), null, 2)}\n`,
    'themes/reader-dark-color-theme.json': `${JSON.stringify(vscodeTheme(tokens.dark, true), null, 2)}\n`,
  };
}

export function writeThemes(dir = join(here, '..', 'vscode')) {
  const files = themeFiles();
  mkdirSync(join(dir, 'themes'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return Object.keys(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`vscode themes: ${writeThemes().join(', ')}`);
}
