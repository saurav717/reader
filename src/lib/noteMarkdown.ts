// Writing in the notes, drawn: Markdown — headings, lists, maths — with a
// checklist's boxes ticked or not, and a box ticked by a click.
import { markdown } from './markdown';

/** A checklist line: `- [ ] …` or `- [x] …`. */
const CHECK = /^(\s*[-*] )\[( |x|X)\]/gm;

/** Markdown as drawn, with each checklist box numbered so a click can tick it. */
export function drawnNote(md: string): string {
  let index = 0;
  return markdown(md).replace(/<li>\[( |x|X)\] ?/g, (_, mark: string) => `<li class="doc-check${mark.trim() ? ' is-done' : ''}"><span class="doc-box" data-check="${index++}" role="checkbox" aria-checked="${Boolean(mark.trim())}"></span>`);
}

/** The nth checklist box in the Markdown, ticked or unticked. */
export function toggleCheck(md: string, nth: number): string {
  let index = -1;
  return md.replace(CHECK, (line, lead: string, mark: string) => {
    index += 1;
    return index === nth ? `${lead}[${mark.trim() ? ' ' : 'x'}]` : line;
  });
}
