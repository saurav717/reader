/**
 * Running a file, as VS Code's ▶ does: the language by its extension, and the
 * command that runs it with what the machine has (the Companion's
 * /companion/tools says which toolchains are on its PATH). A language with
 * nothing to run it says what to install. Also a light highlighter for the
 * languages other than Python, which has its own (Explain's).
 */

export interface MachineTools {
  os: 'mac' | 'linux' | 'windows';
  /** Command → where it is, for the toolchains found. */
  tools: Record<string, string>;
  /** The coding agents with a command line found there. */
  agents: { id: string; name: string }[];
  /** Whether Microsoft's VS Code is installed there (VS Code in the page). */
  vscode: boolean;
}

/** What a machine that can't be asked (Colab, a Jupyter server of one's own) is taken to have: a Linux box with Python and a compiler. */
export const ASSUMED_TOOLS: MachineTools = { os: 'linux', tools: { python3: 'python3', python: 'python', bash: 'bash', gcc: 'gcc', 'g++': 'g++' }, agents: [], vscode: false };

interface Language {
  id: string;
  name: string;
  exts: string[];
  /** The line comment. */
  comment: string;
  /** C-style block comments too. */
  block?: boolean;
  keywords: string;
  /** What to install when nothing here runs it. */
  install: string;
  run: (file: Target, has: (tool: string) => boolean) => string | null;
}

interface Target {
  /** The path, quoted for the shell. */
  q: string;
  /** Where a compiled program goes (.reader/bin/<name>), quoted, and the command that makes the folder. */
  out: string;
  mkdir: string;
  /** "a && b" for the machine's shell. */
  then: (...steps: string[]) => string;
  /** How to run a program at a quoted path. */
  exec: (quoted: string) => string;
}

const C_KEYWORDS = 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false nullptr class namespace template typename public private protected virtual override new delete this using include define';

export const LANGUAGES: Language[] = [
  { id: 'python', name: 'Python', exts: ['py'], comment: '#', keywords: '', install: 'Python', run: (f, has) => (has('python') ? `python ${f.q}` : has('python3') ? `python3 ${f.q}` : null) },
  {
    id: 'javascript', name: 'JavaScript', exts: ['js', 'mjs', 'cjs'], comment: '//', block: true, install: 'Node.js',
    keywords: 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield true false null undefined',
    run: (f, has) => (has('node') ? `node ${f.q}` : has('bun') ? `bun ${f.q}` : has('deno') ? `deno run ${f.q}` : null),
  },
  {
    id: 'typescript', name: 'TypeScript', exts: ['ts', 'mts', 'cts'], comment: '//', block: true, install: 'Bun, Deno or tsx (npm i -g tsx)',
    keywords: 'abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in instanceof interface keyof let module namespace never new null number of private protected public readonly return static string super switch this throw true try type typeof undefined unknown var void while yield',
    run: (f, has) => (has('bun') ? `bun ${f.q}` : has('deno') ? `deno run ${f.q}` : has('tsx') ? `tsx ${f.q}` : null),
  },
  { id: 'go', name: 'Go', exts: ['go'], comment: '//', block: true, install: 'Go', keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil', run: (f, has) => (has('go') ? `go run ${f.q}` : null) },
  {
    id: 'rust', name: 'Rust', exts: ['rs'], comment: '//', block: true, install: 'Rust (rustup.rs)',
    keywords: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
    run: (f, has) => (has('rustc') ? f.then(f.mkdir, `rustc ${f.q} -o ${f.out}`, f.exec(f.out)) : null),
  },
  { id: 'c', name: 'C', exts: ['c'], comment: '//', block: true, install: 'a C compiler (gcc or clang)', keywords: C_KEYWORDS, run: (f, has) => (has('gcc') || has('clang') ? f.then(f.mkdir, `${has('gcc') ? 'gcc' : 'clang'} ${f.q} -o ${f.out} -lm`, f.exec(f.out)) : null) },
  {
    id: 'cpp', name: 'C++', exts: ['cpp', 'cc', 'cxx', 'c++'], comment: '//', block: true, install: 'a C++ compiler (g++ or clang++)', keywords: C_KEYWORDS,
    run: (f, has) => (has('g++') || has('clang++') ? f.then(f.mkdir, `${has('g++') ? 'g++' : 'clang++'} -std=c++17 ${f.q} -o ${f.out}`, f.exec(f.out)) : null),
  },
  {
    id: 'java', name: 'Java', exts: ['java'], comment: '//', block: true, install: 'a JDK (11 or newer)',
    keywords: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new package private protected public return short static super switch this throw throws try void volatile while true false null var record',
    run: (f, has) => (has('java') ? `java ${f.q}` : null),
  },
  { id: 'ruby', name: 'Ruby', exts: ['rb'], comment: '#', install: 'Ruby', keywords: 'def end if elsif else unless while until for in do return class module require puts nil true false self yield begin rescue ensure', run: (f, has) => (has('ruby') ? `ruby ${f.q}` : null) },
  { id: 'php', name: 'PHP', exts: ['php'], comment: '//', block: true, install: 'PHP', keywords: 'function echo if else elseif while for foreach as return class new public private protected static true false null', run: (f, has) => (has('php') ? `php ${f.q}` : null) },
  { id: 'perl', name: 'Perl', exts: ['pl'], comment: '#', install: 'Perl', keywords: 'my our sub if elsif else unless while for foreach return use print', run: (f, has) => (has('perl') ? `perl ${f.q}` : null) },
  { id: 'lua', name: 'Lua', exts: ['lua'], comment: '--', install: 'Lua', keywords: 'and break do else elseif end false for function if in local nil not or repeat return then true until while', run: (f, has) => (has('lua') ? `lua ${f.q}` : null) },
  { id: 'r', name: 'R', exts: ['r', 'R'], comment: '#', install: 'R', keywords: 'function if else for while repeat return TRUE FALSE NULL NA library', run: (f, has) => (has('Rscript') ? `Rscript ${f.q}` : null) },
  { id: 'julia', name: 'Julia', exts: ['jl'], comment: '#', install: 'Julia', keywords: 'function end if elseif else for while return using import module struct true false nothing begin let', run: (f, has) => (has('julia') ? `julia ${f.q}` : null) },
  { id: 'swift', name: 'Swift', exts: ['swift'], comment: '//', block: true, install: 'Swift (Xcode on a Mac)', keywords: 'func let var if else for in while return struct class enum import true false nil guard switch case', run: (f, has) => (has('swift') ? `swift ${f.q}` : null) },
  { id: 'dart', name: 'Dart', exts: ['dart'], comment: '//', block: true, install: 'Dart', keywords: 'void main var final const if else for while return class import true false null', run: (f, has) => (has('dart') ? `dart run ${f.q}` : null) },
  { id: 'haskell', name: 'Haskell', exts: ['hs'], comment: '--', install: 'GHC (ghcup)', keywords: 'module where import data type let in case of if then else do', run: (f, has) => (has('runghc') ? `runghc ${f.q}` : null) },
  { id: 'elixir', name: 'Elixir', exts: ['exs', 'ex'], comment: '#', install: 'Elixir', keywords: 'def defp defmodule do end if else case fn true false nil', run: (f, has) => (has('elixir') ? `elixir ${f.q}` : null) },
  { id: 'shell', name: 'Shell', exts: ['sh', 'bash'], comment: '#', install: 'bash', keywords: 'if then else elif fi for in do done while case esac function return export local echo', run: (f, has) => (has('bash') ? `bash ${f.q}` : null) },
  { id: 'zsh', name: 'zsh', exts: ['zsh'], comment: '#', install: 'zsh', keywords: 'if then else elif fi for in do done while case esac function return export local echo', run: (f, has) => (has('zsh') ? `zsh ${f.q}` : null) },
  { id: 'powershell', name: 'PowerShell', exts: ['ps1'], comment: '#', install: 'PowerShell', keywords: 'function param if else elseif foreach for while return', run: (f, has) => (has('pwsh') ? `pwsh -File ${f.q}` : null) },
];

export function languageOf(path: string): Language | null {
  const ext = path.split('/').pop()?.split('.').slice(1).pop() ?? '';
  return LANGUAGES.find((language) => language.exts.includes(ext) || language.exts.includes(ext.toLowerCase())) ?? null;
}

const posixQuote = (value: string) => (/^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
const windowsQuote = (value: string) => `"${value.replace(/"/g, '`"')}"`;

export type RunPlan = { command: string } | { missing: string; language: string } | null;

/**
 * The command that runs `path` (relative to `folder`, the project's folder on
 * the machine) there, starting with a cd into it when the folder is known.
 * Null for a file no language here runs.
 */
export function runPlan(path: string, folder: string | null, machine: MachineTools): RunPlan {
  const language = languageOf(path);
  if (!language) return null;
  const windows = machine.os === 'windows';
  const quote = windows ? windowsQuote : posixQuote;
  const name = (path.split('/').pop() ?? 'main').replace(/\.[^.]+$/, '') || 'main';
  const outPath = windows ? `.reader\\bin\\${name}.exe` : `.reader/bin/${name}`;
  const target: Target = {
    q: quote(windows ? path.replace(/\//g, '\\') : path),
    out: quote(outPath),
    mkdir: windows ? 'New-Item -ItemType Directory -Force .reader\\bin | Out-Null' : 'mkdir -p .reader/bin',
    then: (...steps) => (windows ? steps.reduce((all, step) => `${all}; if ($?) { ${step} }`) : steps.join(' && ')),
    exec: (quoted) => (windows ? `& ${quoted}` : quoted.startsWith("'") ? `'./${quoted.slice(1)}` : `./${quoted}`),
  };
  const has = (tool: string) => Boolean(machine.tools[tool]);
  const command = language.run(target, has);
  if (!command) return { missing: language.install, language: language.name };
  return { command: folder ? (windows ? `cd ${quote(folder)}; ${command}` : `cd ${quote(folder)} && ${command}`) : command };
}

// ------------------------------------------------------------- highlighting --

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = new Map<string, RegExp>();

function patternFor(language: Language): RegExp {
  let pattern = patterns.get(language.id);
  if (!pattern) {
    const comment = `${escapeRe(language.comment)}[^\\n]*${language.block ? '|\\/\\*[\\s\\S]*?(?:\\*\\/|$)' : ''}`;
    const words = language.keywords.split(/\s+/).filter(Boolean).map(escapeRe).join('|');
    pattern = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"?|'(?:\\\\.|[^'\\\\\\n])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)|\\b(${words || '(?!)'})\\b|\\b(\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b|\\b([A-Za-z_]\\w*)(?=\\s*\\()`, 'g');
    patterns.set(language.id, pattern);
  }
  return pattern;
}

/** The code as HTML, with the same token classes as Python's (tok-c, tok-s, tok-k, tok-n, tok-f). */
export function highlightCode(code: string, path: string): string {
  const language = languageOf(path);
  if (!language || language.id === 'python') return escapeHtml(code);
  let out = '';
  let last = 0;
  for (const match of code.matchAll(patternFor(language))) {
    out += escapeHtml(code.slice(last, match.index));
    const [text, comment, string, keyword, number, call] = match;
    const kind = comment ? 'c' : string ? 's' : keyword ? 'k' : number ? 'n' : call ? 'f' : '';
    out += kind ? `<span class="tok-${kind}">${escapeHtml(text)}</span>` : escapeHtml(text);
    last = (match.index ?? 0) + text.length;
  }
  return out + escapeHtml(code.slice(last));
}
