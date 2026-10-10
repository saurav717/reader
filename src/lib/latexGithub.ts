// Compiling on GitHub: all of TeX Live, nothing installed here. A private
// repository of the person's (made from the Write tab) holds a workflow that
// compiles whatever is pushed to a `reader/<project>` branch in a container
// with the full TeX Live (the one Overleaf-like CI uses), and pushes the PDF
// and the log to `reader-pdf/<project>`. The page pushes the paper's files,
// watches the run, and reads the PDF back through the contents API.
//
// Only an explicit compile pushes (⌘↵, Recompile): GitHub Actions is free up
// to 2,000 minutes a month on a private repository, and a compile is a minute
// or two, most of it the TeX Live image being pulled. A newer push cancels a
// run still going for the same project.

const API = 'https://api.github.com';

/** The image the workflow compiles in: TeX Live, every scheme, every package. */
export const TEXLIVE_IMAGE = 'ghcr.io/xu-cheng/texlive-full:latest';
export const WORKFLOW_PATH = '.github/workflows/reader-compile.yml';
/** Bumped when the workflow changes, so a repository made before gets the new one. */
export const WORKFLOW_VERSION = 1;

export const LATEXMK_FLAGS: Record<string, string> = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex', latex: '-pdfdvi' };

/** The workflow: compile on a push to reader/**, hand the PDF and log back on reader-pdf/**. */
export function workflow(): string {
  return `# Made by Reader (version ${WORKFLOW_VERSION}): compiles a paper pushed to reader/<project> with all of TeX Live,
# and pushes the PDF and the log to reader-pdf/<project>. Edit it and Reader puts its own back.
name: Reader compile
on:
  push:
    branches: ['reader/**']
permissions:
  contents: write
concurrency:
  group: \${{ github.ref }}
  cancel-in-progress: true
jobs:
  compile:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - name: Compile with all of TeX Live
        run: |
          set +e
          MAIN="$(cat .reader/main 2>/dev/null || echo main.tex)"
          FLAG="$(cat .reader/flag 2>/dev/null || echo -pdf)"
          mkdir -p .reader-out
          docker run --rm -v "$PWD:/w" -w /w ${TEXLIVE_IMAGE} \\
            latexmk "$FLAG" -cd -g -f -interaction=nonstopmode -file-line-error -synctex=1 \\
            -jobname=output -outdir=/w/.reader-out "$MAIN" > .reader-out/stdout.txt 2>&1
          echo $? > .reader-out/exit
      - name: Hand the PDF back
        if: always()
        run: |
          BRANCH="reader-pdf/\${GITHUB_REF_NAME#reader/}"
          mkdir -p /tmp/out
          for f in output.pdf output.log stdout.txt exit; do if [ -f ".reader-out/$f" ]; then cp ".reader-out/$f" /tmp/out/; fi; done
          echo "$GITHUB_SHA" > /tmp/out/source
          cd /tmp/out
          git init -q && git checkout -q -b "$BRANCH" && git add -A
          git -c user.name=reader -c user.email=reader@users.noreply.github.com commit -qm "PDF of $GITHUB_SHA"
          git push -qf "https://x-access-token:\${{ github.token }}@github.com/\${{ github.repository }}" "$BRANCH"
`;
}

async function api<T>(token: string, path: string, init: RequestInit = {}, raw = false): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    const said = detail?.message || String(response.status);
    const error = new Error(
      response.status === 401
        ? 'GitHub rejected the token: it may have expired.'
        : response.status === 403 && /workflow/i.test(said)
          ? 'GitHub refused to write the workflow: the token needs Workflows: read and write.'
          : response.status === 403
            ? `GitHub refused (${said}). The token needs Contents, Workflows and Actions: read and write on this repository.`
            : `GitHub: ${said}.`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (raw ? response : response.json()) as Promise<T>;
}

const enc = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export interface CompileFile {
  path: string;
  /** The file's bytes as base64. */
  base64: string;
}

/** A branch name for a project: what git allows, from its id. */
export const branchFor = (projectId: string) => `reader/${projectId.replace(/[^\w.-]+/g, '-').slice(0, 60)}`;

/** Whether the repository has the workflow, as this version writes it. */
export async function hasWorkflow(token: string, repo: string): Promise<boolean> {
  try {
    const text = await (await api<Response>(token, `/repos/${repo}/contents/${WORKFLOW_PATH}`, {}, true)).text();
    return text.includes(`(version ${WORKFLOW_VERSION})`);
  } catch {
    return false;
  }
}

/** A private repository for compiling, with the workflow in it; owner/repo. */
export async function makeCompileRepo(token: string, name = 'reader-latex'): Promise<string> {
  let fullName: string;
  try {
    const made = await api<{ full_name: string }>(token, '/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, private: true, auto_init: true, description: 'Reader compiles papers here with all of TeX Live (GitHub Actions).' }),
    });
    fullName = made.full_name;
  } catch (error) {
    // Made before (on another computer, say): use it.
    if ((error as { status?: number }).status !== 422) throw error;
    const me = await api<{ login: string }>(token, '/user');
    fullName = `${me.login}/${name}`;
  }
  await putWorkflow(token, fullName);
  return fullName;
}

/** Writes the workflow on the default branch (the Contents API: it needs the Workflows permission). */
export async function putWorkflow(token: string, repo: string): Promise<void> {
  let sha: string | undefined;
  try {
    sha = (await api<{ sha: string }>(token, `/repos/${repo}/contents/${WORKFLOW_PATH}`)).sha;
  } catch {
    sha = undefined;
  }
  const content = btoa(unescape(encodeURIComponent(workflow())));
  await api(token, `/repos/${repo}/contents/${WORKFLOW_PATH}`, {
    method: 'PUT',
    body: JSON.stringify({ message: 'Reader: the compile workflow', content, ...(sha ? { sha } : {}) }),
  });
}

/**
 * The paper's files as one commit on the project's branch, the whole folder
 * (files gone here are gone there), with the main document and compiler in
 * .reader/. The commit's sha: the run, and the PDF, are known by it.
 */
export async function pushPaper(token: string, repo: string, branch: string, files: CompileFile[], how: { main: string; compiler: string }): Promise<string> {
  const all: CompileFile[] = [
    ...files,
    { path: '.reader/main', base64: btoa(how.main) },
    { path: '.reader/flag', base64: btoa(LATEXMK_FLAGS[how.compiler] ?? '-pdf') },
  ];
  const blobs = await Promise.all(
    all.map(async (file) => ({ path: file.path, sha: (await api<{ sha: string }>(token, `/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: file.base64, encoding: 'base64' }) })).sha })),
  );
  const tree = await api<{ sha: string }>(token, `/repos/${repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: blobs.map((blob) => ({ path: blob.path, mode: '100644', type: 'blob', sha: blob.sha })) }),
  });
  let parent: string | null = null;
  try {
    parent = (await api<{ object: { sha: string } }>(token, `/repos/${repo}/git/ref/heads/${enc(branch)}`)).object.sha;
  } catch {
    parent = null;
  }
  const commit = await api<{ sha: string }>(token, `/repos/${repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message: `Compile ${how.main}`, tree: tree.sha, parents: parent ? [parent] : [] }),
  });
  if (parent) await api(token, `/repos/${repo}/git/refs/heads/${enc(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: true }) });
  else await api(token, `/repos/${repo}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  return commit.sha;
}

export interface RunState {
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending' | 'unknown';
  conclusion?: string | null;
  url?: string;
  startedAt?: string;
}

/** The run for a pushed commit, as GitHub has it so far. */
export async function runFor(token: string, repo: string, sha: string): Promise<RunState | null> {
  const runs = await api<{ workflow_runs: { status: RunState['status']; conclusion: string | null; html_url: string; run_started_at?: string; head_sha: string }[] }>(
    token,
    `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=5`,
  );
  const run = runs.workflow_runs.find((item) => item.head_sha === sha);
  return run ? { status: run.status, conclusion: run.conclusion, url: run.html_url, startedAt: run.run_started_at } : null;
}

export interface GithubCompiled {
  pdf: Blob | null;
  log: string;
  /** latexmk's exit: 0 when it made the PDF with no error. */
  exit: number | null;
}

/** The PDF and log of a pushed commit, once the run has handed them back; null until then. */
export async function resultFor(token: string, repo: string, branch: string, sha: string): Promise<GithubCompiled | null> {
  const back = `reader-pdf/${branch.replace(/^reader\//, '')}`;
  const read = async (name: string) => (await api<Response>(token, `/repos/${repo}/contents/${name}?ref=${encodeURIComponent(back)}`, {}, true));
  let source = '';
  try {
    source = (await (await read('source')).text()).trim();
  } catch {
    return null;
  }
  if (source !== sha) return null;
  const text = async (name: string) => {
    try {
      return await (await read(name)).text();
    } catch {
      return '';
    }
  };
  let pdf: Blob | null = null;
  try {
    pdf = new Blob([await (await read('output.pdf')).arrayBuffer()], { type: 'application/pdf' });
  } catch {
    pdf = null;
  }
  const exit = Number.parseInt((await text('exit')).trim(), 10);
  return { pdf, log: `${await text('output.log')}\n${await text('stdout.txt')}`, exit: Number.isFinite(exit) ? exit : null };
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
