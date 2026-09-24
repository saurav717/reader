// Kept apart from markdown.ts so that module stays free of KaTeX and its fonts.
/**
 * Typesets the maths `markdown` set aside, in place. KaTeX is loaded the first
 * time an answer has any, as a chunk of its own with its stylesheet; until
 * then, and if it cannot parse something, the TeX stays as written.
 */
export async function typesetMath(root: HTMLElement | null): Promise<void> {
  const pending = root ? Array.from(root.querySelectorAll<HTMLElement>('.chat-math:not([data-set]), .chat-math-block:not([data-set])')) : [];
  if (!pending.length) return;
  const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
  for (const element of pending) {
    if (!element.isConnected || element.dataset.set) continue;
    try {
      katex.render(element.dataset.tex ?? '', element, { throwOnError: false, displayMode: element.classList.contains('chat-math-block'), output: 'htmlAndMathml' });
      element.dataset.set = '1';
    } catch {
      element.dataset.set = 'failed';
    }
  }
}
