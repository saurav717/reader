// Compiling on GitHub, from the page's side: Reader's compiler is GitHub
// Actions in the reader's own repository, reached through its Worker
// (worker/latex.js, .github/workflows/latex-compile.yml). What comes back is
// a PDF and a TeX log; this reads the log.

export interface CompileFile {
  path: string;
  /** The file's bytes as base64. */
  base64: string;
}

export interface LogProblem {
  file: string;
  line: number | null;
  message: string;
}

/** Errors and warnings out of a TeX log, each with its file and line when it says. */
export function readTexLog(log: string): { errors: LogProblem[]; warnings: LogProblem[] } {
  const errors: LogProblem[] = [];
  const warnings: LogProblem[] = [];
  const lines = log.split('\n');
  const seen = new Set<string>();
  const add = (list: LogProblem[], item: LogProblem) => {
    const key = `${item.file}:${item.line}:${item.message}`;
    if (!seen.has(key)) (seen.add(key), list.push(item));
  };
  lines.forEach((line, index) => {
    const located = /^(?:\.\/)?([^\s:][^:]*\.(?:tex|sty|cls|bib|bbl)):(\d+): (.+)$/.exec(line);
    if (located) return add(errors, { file: located[1], line: Number(located[2]), message: located[3].trim() });
    if (line.startsWith('! ')) {
      const at = lines.slice(index + 1, index + 8).map((later) => /^l\.(\d+)/.exec(later)).find(Boolean);
      return add(errors, { file: '', line: at ? Number(at[1]) : null, message: line.slice(2).trim() });
    }
    const warned = /^(?:LaTeX|Package [\w-]+|Class [\w-]+) Warning: (.+?)(?: on input line (\d+))?\.?$/.exec(line);
    if (warned) add(warnings, { file: '', line: warned[2] ? Number(warned[2]) : null, message: warned[1].trim() });
  });
  return { errors, warnings: warnings.slice(0, 200) };
}
