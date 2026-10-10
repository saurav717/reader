// A file's mark in the playground's explorer, tabs and agent: a small tag of
// its kind, coloured by family, as an editor's file icons are — in the site's
// own palette rather than an icon theme's.

const KINDS: [RegExp, string, string][] = [
  [/\.py$/i, 'py', 'is-py'],
  [/\.ipynb$/i, 'nb', 'is-py'],
  [/\.(ts|tsx)$/i, 'ts', 'is-ts'],
  [/\.(js|jsx|mjs|cjs)$/i, 'js', 'is-js'],
  [/\.(md|markdown|rst)$/i, 'md', 'is-doc'],
  [/\.(txt|log)$/i, 'txt', 'is-doc'],
  [/\.(json|jsonl)$/i, '{}', 'is-data'],
  [/\.(ya?ml|toml|ini|cfg|conf)$/i, 'cfg', 'is-data'],
  [/\.(csv|tsv|parquet)$/i, 'csv', 'is-data'],
  [/\.(sh|bash|zsh|ps1)$/i, '$', 'is-sh'],
  [/\.(c|cc|cpp|h|hpp|cu|cuh)$/i, 'c', 'is-c'],
  [/\.(rs)$/i, 'rs', 'is-c'],
  [/\.(go)$/i, 'go', 'is-ts'],
  [/\.(jl)$/i, 'jl', 'is-js'],
  [/\.(r)$/i, 'R', 'is-ts'],
  [/\.(png|jpe?g|gif|svg|webp)$/i, 'img', 'is-img'],
  [/\.(pt|pth|ckpt|safetensors|bin|npz|npy|h5)$/i, 'bin', 'is-bin'],
  [/(^|\/)(Dockerfile|Makefile|pyproject\.toml|setup\.py)$/i, '⚙', 'is-sh'],
];

/** What a path's language is, in a word, for the status bar. */
export function languageOf(path: string): string {
  const names: [RegExp, string][] = [
    [/\.py$/i, 'Python'],
    [/\.ipynb$/i, 'Notebook'],
    [/\.tsx?$/i, 'TypeScript'],
    [/\.(js|jsx|mjs|cjs)$/i, 'JavaScript'],
    [/\.(md|markdown)$/i, 'Markdown'],
    [/\.jsonl?$/i, 'JSON'],
    [/\.ya?ml$/i, 'YAML'],
    [/\.toml$/i, 'TOML'],
    [/\.(sh|bash|zsh)$/i, 'Shell'],
    [/\.(c|h)$/i, 'C'],
    [/\.(cc|cpp|hpp)$/i, 'C++'],
    [/\.(cu|cuh)$/i, 'CUDA'],
    [/\.rs$/i, 'Rust'],
    [/\.go$/i, 'Go'],
    [/\.jl$/i, 'Julia'],
    [/\.r$/i, 'R'],
    [/\.csv$/i, 'CSV'],
  ];
  return names.find(([test]) => test.test(path))?.[1] ?? 'Plain text';
}

export default function FileIcon({ path, folder, open }: { path: string; folder?: boolean; open?: boolean }) {
  if (folder) {
    return (
      <svg className={`pg-ficon is-folder${open ? ' is-open' : ''}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path d={open ? 'M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1V6H4.2a1 1 0 0 0-.95.68L1.5 12V4.5Zm2.7 2.5h10.9l-1.8 5.6a1 1 0 0 1-.95.7H2.1l2.1-6.3Z' : 'M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-10.9a1 1 0 0 1-1-1V4.5Z'} fill="currentColor" />
      </svg>
    );
  }
  const name = path.split('/').pop() ?? path;
  const [, label, kind] = KINDS.find(([test]) => test.test(name)) ?? [null, '·', 'is-plain'];
  return (
    <span className={`pg-ficon ${kind}`} aria-hidden="true">
      {label}
    </span>
  );
}
