/**
 * The Explainer: an illustrated account of a project, written by the model
 * picked for explanations, for someone who wants to understand the code that
 * was written and what was done with it — by them or by an agent.
 *
 * It reads what the project holds: the files (the code itself, the most
 * telling first), what the agents were asked and answered (Koios's own, and
 * Claude Code / Codex), the commands run in the console, the simulation runs
 * (their numbers, what looks wrong, their videos) and the metrics the runs
 * printed. The model writes Markdown with four kinds of illustration, each a
 * fenced block the pane draws:
 *
 *   ```figure caption="…"      an SVG diagram it draws (the code's structure, the data's path)
 *   ```chart                   a chart from a run's numbers or the console's: run:/metric: or console:/metric:
 *   ```media                   an image or video in the project: path: and caption:
 *   ```python                  a short excerpt of the code, with file: when it is one
 *
 * It is kept in the project's folder (.reader/explainer.md), so it opens again
 * anywhere, and written again on request with what has changed since.
 */

import type { FileHost } from './playground';
import { readMeta, writeMeta } from './playground';
import { agentChatFor, listAll } from './projectAgent';
import type { AgentTurn } from './projectAgent';
import { parseRun as parseCliRun } from './cliAgent';
import type { CliAgentId } from './cliAgent';
import { diagnose, listKeptRuns, parseRun, readKeptRun, readSimRuns, scalarCharts } from './simTelemetry';
import type { RunListing, SimRun } from './simTelemetry';
import { readWholeRun } from './experimentFiling';
import { metricSeries } from './telemetry';
import type { Series } from './telemetry';
import { tag } from './assistant';

export const EXPLAINER_NAME = 'explainer.md';
export const EXPLAINER_META = 'explainer.json';

export interface ExplainerMeta {
  at: number;
  model: string;
  /** What it was written from, to say what has changed since. */
  files: number;
  runs: string[];
  agentTurns: number;
}

// ------------------------------------------------------------ the inputs --

/** Where a project's runs are: on the machine (connected) and in its own folder. */
export interface RunPlace {
  /** The project's folder on the machine, as the Sim pane has it; null when the machine isn't connected. */
  machineFolder: string | null;
  /** The project's own folder, when it isn't the machine's disk. */
  kept?: FileHost;
}

export interface ExplainerInputs {
  where: string;
  listing: { path: string; size: number | null }[];
  files: { path: string; text: string }[];
  agents: string;
  console: string[];
  runs: { dir: string; digest: string }[];
  metrics: { name: string; last: number; points: number }[];
  media: string[];
  previous?: { text: string; meta: ExplainerMeta };
}

const CODE = /\.(py|ipynb|js|ts|tsx|jsx|rs|go|c|cc|cpp|h|hpp|cu|java|jl|r|sh|toml|yaml|yml|cfg|ini)$/i;
const DOCS = /(^|\/)(readme|agents|claude|plan|notes?|design)[^/]*\.(md|txt)$/i;
const MEDIA = /\.(png|jpe?g|gif|webp|svg|mp4|webm)$/i;
const SKIP = /(^|\/)(\.git|\.reader|reader-meta|node_modules|__pycache__|\.ipynb_checkpoints|wandb|\.venv|venv|site-packages|data|datasets)\//;
const FILE_CHARS = 9000;
const FILES_CHARS = 90_000;

/** The files worth reading first: the docs, then the entry points, then the rest of the code, smallest folders first. */
function rank(path: string): number {
  if (DOCS.test(path)) return 0;
  if (/(^|\/)(main|train|run|app|model|agent|env|world|policy)[^/]*\.py$/i.test(path)) return 1;
  if (/\.py$/i.test(path)) return 2 + path.split('/').length;
  return 10 + path.split('/').length;
}

/** What the agents were asked, and what each answered: Koios's own from the panel, Claude Code's and Codex's from .reader/cli-agent.json. */
async function agentStory(projectId: string, host: FileHost): Promise<{ text: string; turns: number }> {
  const parts: string[] = [];
  let turns = 0;
  const chat = agentChatFor(projectId);
  const own: AgentTurn[] = [...chat.history.slice().reverse().flatMap((saved) => saved.turns), ...chat.turns];
  for (const turn of own.slice(-40)) {
    turns++;
    if (turn.role === 'user') parts.push(`Asked Koios's agent: ${turn.text.slice(0, 600)}`);
    else parts.push(`Koios's agent answered: ${turn.text.slice(0, 900)}${turn.changes?.length ? ` (wrote ${turn.changes.map((c) => c.path).join(', ')})` : ''}${turn.runs?.length ? ` (ran ${turn.runs.map((r) => `${r.command} → ${r.state}`).join('; ')})` : ''}`);
  }
  try {
    const raw = await readMeta(host, 'cli-agent.json');
    const saved = raw ? (JSON.parse(raw) as { chats?: Partial<Record<CliAgentId, { turns?: { request: string; lines: string[] }[] }>> }) : null;
    for (const agent of ['claude', 'codex'] as CliAgentId[]) {
      for (const turn of saved?.chats?.[agent]?.turns?.slice(-25) ?? []) {
        turns++;
        const { events } = parseCliRun(agent, turn.lines ?? []);
        const said = events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('\n').trim();
        const edited = [...new Set(events.flatMap((e) => (e.kind === 'tool' && e.path && /^(Edit|Write|MultiEdit)$/.test(e.name) ? [e.path] : [])))];
        const ran = events.flatMap((e) => (e.kind === 'tool' && e.name === 'Bash' ? [e.detail.slice(0, 120)] : [])).slice(0, 8);
        const name = agent === 'claude' ? 'Claude Code' : 'Codex';
        parts.push(`Asked ${name}: ${turn.request.slice(0, 600)}\n${name} answered: ${said.slice(-1200) || '(nothing said)'}${edited.length ? `\n(edited ${edited.slice(0, 15).join(', ')})` : ''}${ran.length ? `\n(ran: ${ran.join(' ; ')})` : ''}`);
      }
    }
  } catch {
    // no Claude Code or Codex here
  }
  return { text: parts.join('\n\n').slice(-30_000), turns };
}

/** A run in a few lines: what it is, how it went, its numbers, what looks wrong, its videos. */
export function runDigest(run: SimRun, now: number): string {
  const episodes = run.episodes;
  const returns = episodes.map((e) => e.ret);
  const best = returns.length ? Math.max(...returns) : null;
  const lines = [
    `name: ${run.meta.name ?? run.dir}; simulator: ${run.meta.sim ?? '?'}; status: ${run.status}; steps: ${run.step}; episodes: ${episodes.length}`,
    returns.length ? `returns: first ${returns[0].toFixed(2)}, last ${returns[returns.length - 1].toFixed(2)}, best ${best!.toFixed(2)}` : '',
    run.meta.config ? `config: ${JSON.stringify(run.meta.config).slice(0, 600)}` : '',
    `logged: ${[...run.scalars.keys()].slice(0, 30).map((k) => {
      const points = run.scalars.get(k)!;
      return `${k} (last ${points.length ? points[points.length - 1].y.toPrecision(4) : '?'})`;
    }).join(', ')}`,
    run.evaluations.length ? `evaluations: ${run.evaluations.slice(-3).map((e) => `${e.name} at ${e.step}: ${JSON.stringify(e.metrics)}`).join('; ')}` : '',
    run.media.length ? `media (path relative to the run): ${run.media.slice(-12).map((m) => `${m.path} [${m.type}, step ${m.step}${m.caption ? `, ${m.caption}` : ''}]`).join('; ')}` : '',
    run.notes.length ? `notes: ${run.notes.slice(-6).map((n) => `${n.by}: ${n.text}`).join(' | ')}` : '',
    `findings: ${diagnose(run, now).map((f) => `${f.level} ${f.title} — ${f.detail}`).join(' | ') || 'none'}`,
    run.error ? `error: ${run.error.slice(0, 400)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** A run whole, from the machine or the project's own folder. */
export async function loadRun(place: RunPlace, dir: string, listing?: RunListing): Promise<SimRun | null> {
  if (place.machineFolder !== null && !listing?.kept) {
    const whole = await readWholeRun(place.machineFolder, dir).catch(() => null);
    if (whole) return whole.run;
  }
  if (place.kept) {
    const read = await readKeptRun(place.kept, { dir, offset: 0 }).catch(() => null);
    if (read) {
      const meta = listing?.meta ?? (JSON.parse((await place.kept.read(`${dir}/run.json`).catch(() => null)) ?? '{}') as SimRun['meta']);
      return parseRun(dir, meta, read.text);
    }
  }
  return null;
}

/** The runs, from wherever they are: the machine's first, the project folder's that the machine hasn't. */
export async function listRuns(place: RunPlace): Promise<RunListing[]> {
  const there = place.machineFolder !== null ? await readSimRuns(place.machineFolder, null).then((r) => r.runs).catch(() => []) : [];
  const seen = new Set(there.map((r) => r.dir));
  const kept = place.kept ? (await listKeptRuns(place.kept).catch(() => [])).filter((r) => !seen.has(r.dir)) : [];
  return [...there, ...kept].sort((a, b) => b.mtime - a.mtime);
}

export async function gatherInputs(params: { projectId: string; host: FileHost; where: string; place: RunPlace; console: string[]; metricTexts: string[]; onStep?: (text: string) => void }): Promise<ExplainerInputs> {
  const { host } = params;
  params.onStep?.('Listing the files');
  const listing = (await listAll(host)).filter((file) => !SKIP.test(`${file.path}`));
  const readable = listing.filter((file) => (CODE.test(file.path) || DOCS.test(file.path) || /\.md$/i.test(file.path)) && (file.size ?? 0) < 400_000).sort((a, b) => rank(a.path) - rank(b.path));
  const files: { path: string; text: string }[] = [];
  let total = 0;
  params.onStep?.('Reading the code');
  for (const file of readable) {
    if (total > FILES_CHARS) break;
    const text = await host.read(file.path).catch(() => null);
    if (!text) continue;
    const clipped = text.length > FILE_CHARS ? `${text.slice(0, FILE_CHARS)}\n[… ${text.length - FILE_CHARS} more characters …]` : text;
    files.push({ path: file.path, text: clipped });
    total += clipped.length;
  }
  params.onStep?.('Reading what the agents did');
  const agents = await agentStory(params.projectId, host);
  params.onStep?.('Reading the simulation runs');
  const listed = await listRuns(params.place);
  const runs: { dir: string; digest: string }[] = [];
  for (const listing of listed.slice(0, 6)) {
    const run = await loadRun(params.place, listing.dir, listing);
    if (run) runs.push({ dir: listing.dir, digest: runDigest(run, Date.now() / 1000) });
  }
  const metrics = new Map<string, { name: string; last: number; points: number }>();
  for (const text of params.metricTexts) {
    for (const metric of metricSeries(text)) {
      const points = metric.series.flatMap((s) => s.points);
      if (points.length) metrics.set(metric.name, { name: metric.name, last: points[points.length - 1].y, points: points.length });
    }
  }
  const media = listing.filter((file) => MEDIA.test(file.path)).map((file) => file.path).slice(0, 60);
  let previous: ExplainerInputs['previous'];
  const [text, meta] = await Promise.all([readMeta(host, EXPLAINER_NAME).catch(() => null), readMeta(host, EXPLAINER_META).catch(() => null)]);
  if (text && meta) {
    try {
      previous = { text, meta: JSON.parse(meta) as ExplainerMeta };
    } catch {
      // a half-written one: written afresh
    }
  }
  return { where: params.where, listing: listing.map((f) => ({ path: f.path, size: f.size })), files, agents: agents.text, console: params.console, runs, metrics: [...metrics.values()], media, previous };
}

// ------------------------------------------------------------ the prompt --

export const EXPLAINER_SYSTEM = `You write the Explainer for a research code project in Koios: an illustrated account, for the person who owns the project, of what the code does and what has been done with it — so they understand the codebase without reading it all. Agents (Claude Code, Codex, Koios's own) may have written much of it; say so where it matters, and say what each piece is for.

Write Markdown, plain and exact, in sections with ## headings, in this order (leave out a section with nothing in it):
1. ## In short — what the project is and where it stands, in a few sentences.
2. ## How the code fits together — the files that matter, what each does, how data and control move between them. Draw it.
3. ## How it works — the method itself: the model, the algorithm, the simulator or environment, the losses and updates, with short excerpts of the real code where they make it clearer.
4. ## What was done — a timeline of the requests and the work, from the agents' log and the console: what was asked, what was built or changed, what was run.
5. ## What the runs show — each run that matters: what it trained, how it went, with charts of its numbers and its videos or images, and what looks wrong.
6. ## Where it stands, and what to try next — what works, what doesn't, open problems, the next useful experiments.

Illustrations, as fenced blocks the page draws — use them generously where they help, never as decoration:
- \`\`\`figure caption="…"  then one self-contained <svg> with a viewBox, about 640 wide: boxes and arrows for the code's structure, the data's path, a training loop, an environment's loop. Use currentColor for strokes and text, fill="none" or a light fill with fill-opacity, font-size 12–14, no <image>, no <style>, no scripts. Keep labels short.
- \`\`\`chart  then lines "run: <run dir>" and "metric: returns | success | length | <a logged scalar name>" — or "console: all" and "metric: <name>" for a number the console printed — and "title: …". Only runs and names that the inputs list.
- \`\`\`media  then "path: <file path in the project>" and "caption: …": an image or video the project has (from the media list, or a run's media as <run dir>/<path>). Only files that are listed.
- \`\`\`python file="<path>"  a short excerpt (under 25 lines) of the real code, as it is in that file.

Be truthful: describe only what the inputs show. Where something is unclear or looks broken, say so plainly. Don't invent numbers, files or results. Refer to files by their paths in backticks.`;

export function explainerMessage(inputs: ExplainerInputs, update: boolean): string {
  const parts = [
    tag('where', inputs.where),
    tag('listing', inputs.listing.slice(0, 400).map((f) => `${f.path}${f.size !== null ? ` (${f.size} B)` : ''}`).join('\n') || '(empty)'),
    ...inputs.files.map((f) => tag('file', f.text, { path: f.path })),
    tag('agents', inputs.agents || 'No agent has worked on it yet.'),
    tag('console', inputs.console.slice(-40).join('\n') || 'No commands run yet.'),
    ...inputs.runs.map((r) => tag('run', r.digest, { dir: r.dir })),
    tag('metrics', inputs.metrics.map((m) => `${m.name}: last ${m.last.toPrecision(4)} over ${m.points} points`).join('\n') || 'None printed.'),
    tag('media', inputs.media.join('\n') || 'None.'),
  ];
  if (update && inputs.previous) {
    parts.push(tag('previous_explainer', inputs.previous.text.slice(0, 40_000), { written: new Date(inputs.previous.meta.at).toISOString() }));
    parts.push('Write the Explainer again, whole: keep what still holds of the previous one, correct what changed, and add what is new since it was written (new files, new requests, new runs).');
  } else {
    parts.push('Write the Explainer for this project.');
  }
  return parts.join('\n\n');
}

// ----------------------------------------------------------- the answer --

export type ExplainerBlock =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; svg: string; caption: string }
  | { kind: 'chart'; run?: string; console?: boolean; metric: string; title: string }
  | { kind: 'media'; path: string; caption: string }
  | { kind: 'code'; lang: string; file?: string; text: string };

const attr = (info: string, name: string) => info.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? info.match(new RegExp(`${name}=(\\S+)`))?.[1];
const field = (body: string, name: string) => body.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'mi'))?.[1].trim();

/** The Markdown cut at its fenced blocks: prose, and each illustration. A block still being written is left as text. */
export function parseExplainer(src: string): ExplainerBlock[] {
  const out: ExplainerBlock[] = [];
  const fence = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let at = 0;
  let m: RegExpExecArray | null;
  const prose = (text: string) => {
    if (text.trim()) out.push({ kind: 'text', text });
  };
  while ((m = fence.exec(src))) {
    prose(src.slice(at, m.index));
    at = m.index + m[0].length;
    const info = m[1].trim();
    const kind = info.split(/\s+/)[0].toLowerCase();
    const body = m[2];
    if (kind === 'figure') {
      const svg = body.match(/<svg[\s\S]*<\/svg>/i)?.[0];
      if (svg) out.push({ kind: 'figure', svg, caption: attr(info, 'caption') ?? '' });
    } else if (kind === 'chart') {
      const metric = field(body, 'metric');
      const run = field(body, 'run');
      const console = field(body, 'console');
      if (metric && (run || console)) out.push({ kind: 'chart', run, console: Boolean(console), metric, title: field(body, 'title') ?? metric });
    } else if (kind === 'media') {
      const path = field(body, 'path');
      if (path) out.push({ kind: 'media', path: path.replace(/^`|`$/g, ''), caption: field(body, 'caption') ?? '' });
    } else {
      out.push({ kind: 'code', lang: kind || 'text', file: attr(info, 'file'), text: body.replace(/\n$/, '') });
    }
  }
  prose(src.slice(at));
  return out;
}

/** A chart's lines, from a run: its returns, success, lengths, or a logged scalar (matched by name). */
export function runChartSeries(run: SimRun, metric: string, series: { returns: (r: SimRun) => Series[]; success: (r: SimRun) => Series[]; length: (r: SimRun) => Series[] }): Series[] {
  const name = metric.toLowerCase();
  if (/^(returns?|reward|episode.?return)$/.test(name)) return series.returns(run);
  if (/^success/.test(name)) return series.success(run);
  if (/^(length|episode.?length)$/.test(name)) return series.length(run);
  const charts = scalarCharts(run, metric);
  const exact = charts.find((c) => c.title.toLowerCase() === name) ?? charts[0];
  return exact?.series ?? [];
}

/** The console's numbers for one name, a line per command that printed it. */
export function consoleChartSeries(texts: { label: string; text: string }[], metric: string): Series[] {
  const out: Series[] = [];
  for (const { label, text } of texts) {
    const found = metricSeries(text).find((m) => m.name.toLowerCase() === metric.toLowerCase());
    if (found) out.push(...found.series.map((s) => ({ ...s, name: label })));
  }
  return out.slice(0, 4);
}

// ------------------------------------------------------------- keeping --

export async function loadExplainer(host: FileHost): Promise<{ text: string; meta: ExplainerMeta } | null> {
  const [text, meta] = await Promise.all([readMeta(host, EXPLAINER_NAME), readMeta(host, EXPLAINER_META)]);
  if (!text) return null;
  try {
    return { text, meta: meta ? (JSON.parse(meta) as ExplainerMeta) : { at: 0, model: '', files: 0, runs: [], agentTurns: 0 } };
  } catch {
    return { text, meta: { at: 0, model: '', files: 0, runs: [], agentTurns: 0 } };
  }
}

export async function saveExplainer(host: FileHost, text: string, meta: ExplainerMeta): Promise<void> {
  await writeMeta(host, EXPLAINER_NAME, text);
  await writeMeta(host, EXPLAINER_META, `${JSON.stringify(meta)}\n`);
}

// ------------------------------------------------- asked of the page --

/**
 * The ask bar under the Explain page's title: a question about the page or
 * the project, or a change to the page ("simpler", "add a diagram of the data
 * flow", "a section on how to run it"). The model answers in two parts: a
 * <note> — the answer, or a line on what changed — and, for a change, the
 * whole page again in <explainer>, which replaces it (and can be undone).
 */
export const EXPLAINER_ASK = `The person is reading the Explainer below and asks something of it. Either:
- they ask a question (about the page, the code, the runs): answer it in <note>…</note>, in Markdown, short and exact, and leave the page as it is; or
- they ask for a change to the page (simpler, deeper, a new diagram or chart, a new section, fewer words, a different emphasis): write <note>one sentence on what you changed</note>, then the whole page again, changed, in <explainer>…</explainer> — every section, the ones you didn't touch word for word as they were, in the same format and with the same kinds of illustration.
When they name a section, the request is about that section: change it alone unless they ask for more. Describe only what the inputs show.`;

export function askMessage(inputs: ExplainerInputs, current: string, request: string, section?: string): string {
  return [explainerMessage({ ...inputs, previous: undefined }, false).replace(/\n\nWrite the Explainer for this project\.$/, ''), tag('explainer_now', current), tag('request', request, section ? { section } : {})].join('\n\n');
}

/** The answer as it streams: the note, and the page so far once its tag has opened. */
export function readAskReply(text: string): { note: string; page: string | null; pageDone: boolean } {
  const note = text.match(/<note>([\s\S]*?)(?:<\/note>|$)/)?.[1]?.trim() ?? (text.includes('<explainer>') ? '' : text.replace(/<\/?note>/g, '').trim());
  const open = text.indexOf('<explainer>');
  if (open < 0) return { note, page: null, pageDone: false };
  const rest = text.slice(open + '<explainer>'.length);
  const close = rest.indexOf('</explainer>');
  return { note, page: (close >= 0 ? rest.slice(0, close) : rest).replace(/^\n+/, ''), pageDone: close >= 0 };
}
