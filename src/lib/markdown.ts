// A small Markdown renderer for Claude's answers: headings, paragraphs, lists,
// block quotes, fenced code, pipe tables, rules, and inline code, bold,
// italics and links. Everything is escaped first, so the output is only ever
// the tags written here — and the caller still runs it through DOMPurify.
//
// It is forgiving on purpose: an answer is rendered while it streams, so an
// unterminated fence or a half-written table must still come out readable.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline spans. Code spans are lifted out first so nothing inside them is formatted. */
export function inline(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${esc(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`,
  );
  // A paper named in an answer, `[Name et al. 2021](paper:Its full title)`: the
  // name, drawn as a button that carries the title. The window numbers it and
  // shows the paper's card from it. Set aside like a code span, so the title in
  // its attributes is never formatted.
  s = s.replace(/\[([^\]\n]+)\]\(paper:\s*([^)\n]+)\)/g, (_, text: string, title: string) => {
    codes.push(`<button type="button" class="chat-mention" data-paper="${title.trim()}" aria-haspopup="dialog">${text}</button>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isRule = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row);

export function markdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code, closed or still streaming.
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, if there is one
      const lang = fence[1] ? ` data-lang="${esc(fence[1])}"` : '';
      out.push(`<pre${lang}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // Answers live in a small window; h1 and h2 would shout. Everything is h4–h6.
      const level = Math.min(6, heading[1].length + 3);
      out.push(`<h${level}>${inline(heading[2].replace(/\s*#+\s*$/, ''))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    // A pipe table: a header row, then a rule of dashes.
    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && (marker.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (marker.test(lines[i])) items.push(lines[i].replace(marker, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const tagName = ordered ? 'ol' : 'ul';
      out.push(`<${tagName}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tagName}>`);
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    if (!para.length) {
      // A line no rule above claimed — never loop on it.
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
