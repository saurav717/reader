// ===========================================================================
//  The paper, in the project's folder.
//
//  A project that starts from a paper carries the paper itself, so that any
//  coding agent — Claude Code or Codex on the compute, an agent in a terminal
//  by the files, the page's own Koios AI — reads it from the folder instead
//  of searching the web for it:
//
//    paper/paper.md          the full text, as the reader reflowed it (the PDF read
//                            page by page, else arXiv's HTML rendering)
//    paper/EXPLANATION.md    the Explain page, when one was written
//    paper/paper.pdf         the PDF, where the folder can hold a binary file
//    IMPLEMENTATION_PLAN.md  the Implementation page's plan (src/lib/projectAgent.ts)
//
//  The reader already has all of it: the PDF from Drive or the proxy, the
//  reflow pdf.js does for the Reflow view, the Explain and Implementation
//  pages in IndexedDB and Drive. Nothing here asks a model or the network for
//  anything the reader has not fetched for its own pages, and the text files
//  are written again only when what they came from changed.
// ===========================================================================

import type { Paper } from '../types';
import { loadExplanation } from './explain';
import { toMarkdownFile } from './explainDrive';
import { loadPaperContent, loadPaperContentFromPdf } from './paperContent';
import { fetchPaperPdf } from './pdf';
import { EXPLANATION_FILE, PAPER_DIR, PAPER_FILES_NOTE, PAPER_PDF_FILE, PAPER_TEXT_FILE } from './paperFiles';
import { htmlToMarkdown, paperMarkdown, stripDates, type TextSource } from './paperMarkdown';
import type { FileHost } from './playground';

export { EXPLANATION_FILE, PAPER_DIR, PAPER_FILES_NOTE, PAPER_PDF_FILE, PAPER_TEXT_FILE };

export interface PaperContext {
  /** Text files to write, path → text. */
  files: Record<string, string>;
  /** The PDF as base64, when it was fetched. */
  pdf?: string;
  /** Where the full text came from, for the front matter and the report. */
  textSource: TextSource;
  /** What could not be had, in words for the person. */
  missing: string[];
}

export interface PaperContextOptions {
  /** The Implementation page's plan, when one was written. */
  plan?: string;
  /** How to reach the paper's PDF: Drive first, the proxy after (see fetchPaperPdf). */
  drive?: { clientId?: string; folderName?: string; connected: boolean };
  signal?: AbortSignal;
  /** Which parts to gather; the rest are left out. All by default. */
  want?: { text?: boolean; explanation?: boolean; pdf?: boolean };
  /** What gathers them — gatherPaperContext, or a stand-in in the tests. */
  gather?: typeof gatherPaperContext;
}

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** The paper's PDF, or null when it cannot be had (no copy, no proxy, the folder cannot take it). */
async function pdfOf(paper: Paper, options: PaperContextOptions): Promise<Blob | null> {
  try {
    const { blob } = await fetchPaperPdf(
      paper,
      { driveFileId: paper.drive?.pdfFileId, driveFolderId: paper.drive?.folderId, rootFolderName: options.drive?.folderName, clientId: options.drive?.clientId, driveConnected: options.drive?.connected ?? false },
      options.signal,
    );
    return blob;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return null;
  }
}

/** The full text, from the PDF first (the reader's own reflow), else arXiv's HTML, else the abstract alone. */
async function textOf(paper: Paper, pdf: Blob | null, signal?: AbortSignal): Promise<{ text: string; source: TextSource }> {
  if (pdf) {
    try {
      const reflowed = await loadPaperContentFromPdf(paper, pdf, { signal });
      if (reflowed) {
        try {
          const text = htmlToMarkdown(reflowed.html);
          if (text.length > (paper.abstract?.length ?? 0)) return { text, source: 'pdf' };
        } finally {
          reflowed.release?.();
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
    }
  }
  const loaded = await loadPaperContent(paper, signal);
  if (loaded.mode === 'html') return { text: htmlToMarkdown(loaded.html), source: 'html' };
  return { text: '', source: 'abstract' };
}

/**
 * Everything the folder should hold of the paper. The PDF is fetched once
 * and serves both the text (reflowed from it) and the file; the explanation
 * comes from the reader's cache or Drive. Nothing throws short of an abort:
 * what cannot be had is named in `missing`.
 */
export async function gatherPaperContext(paper: Paper, options: PaperContextOptions = {}): Promise<PaperContext> {
  const want = { text: true, explanation: true, pdf: true, ...options.want };
  const files: Record<string, string> = {};
  const missing: string[] = [];
  let textSource: TextSource = 'abstract';
  let pdf: string | undefined;

  const blob = want.text || want.pdf ? await pdfOf(paper, options) : null;
  if (want.pdf) {
    if (blob) pdf = await toBase64(blob);
    else missing.push('the PDF (no copy in Drive, and none could be fetched)');
  }
  if (want.text) {
    const { text, source } = await textOf(paper, blob, options.signal);
    textSource = source;
    files[PAPER_TEXT_FILE] = paperMarkdown(paper, text, source);
    if (source === 'abstract') missing.push('the full text (neither the PDF nor an HTML rendering could be read — the abstract was written instead)');
  }
  if (want.explanation) {
    const explanation = await loadExplanation(paper.id).catch(() => undefined);
    if (explanation?.content.trim()) files[EXPLANATION_FILE] = toMarkdownFile(paper, explanation);
    else missing.push('the Explain page (none was written for this paper yet)');
  }
  return { files, pdf, textSource, missing };
}

export interface PaperContextReport {
  /** Paths written this time. */
  wrote: string[];
  /** Paths already there and left as they were. */
  kept: string[];
  /** What could not be put in the folder, in words. */
  missing: string[];
}

/**
 * The paper's files in the folder, written where they are missing or stale:
 * the full text and the PDF are gathered only when the folder lacks them
 * (they never change); the explanation is read from the reader each time
 * and written when it differs from the file. `drive` says how the PDF may be
 * fetched. A folder that cannot hold a binary file gets no PDF, and says so.
 */
export async function ensurePaperContext(host: FileHost, paper: Paper, options: PaperContextOptions = {}): Promise<PaperContextReport> {
  const wrote: string[] = [];
  const kept: string[] = [];
  const missing: string[] = [];
  const have = async (path: string) => (await host.read(path).catch(() => null)) !== null;
  const haveText = await have(PAPER_TEXT_FILE);
  // The PDF is a binary: only a host that takes one can hold it, and reading it back as text says nothing — the listing does.
  const canPdf = Boolean(host.writeBase64);
  const havePdf = canPdf && (await host.list(PAPER_DIR).catch(() => [])).some((entry) => entry.type !== 'directory' && entry.name === 'paper.pdf');
  const want = { text: !haveText, pdf: canPdf && !havePdf, explanation: true, ...(options.want ?? {}) };
  if (haveText) kept.push(PAPER_TEXT_FILE);
  if (havePdf) kept.push(PAPER_PDF_FILE);
  const gathered = await (options.gather ?? gatherPaperContext)(paper, { ...options, want });
  missing.push(...gathered.missing);
  if (!canPdf) missing.push('the PDF (this folder holds text files only; the full text is there in its place)');
  for (const [path, text] of Object.entries(gathered.files)) {
    const before = await host.read(path).catch(() => null);
    // The full text's front matter carries the time it was written, so it is compared without it.
    const same = before !== null && stripDates(before) === stripDates(text);
    if (same) {
      kept.push(path);
      continue;
    }
    await host.write(path, text);
    wrote.push(path);
  }
  if (gathered.pdf && host.writeBase64) {
    await host.writeBase64(PAPER_PDF_FILE, gathered.pdf);
    wrote.push(PAPER_PDF_FILE);
  }
  return { wrote, kept, missing };
}

/** A line for the agent's pane after the files are in place, or when something could not be. */
export function paperContextSummary(report: PaperContextReport): string {
  const parts: string[] = [];
  if (report.wrote.length) parts.push(`Put in the folder: ${report.wrote.join(', ')}.`);
  else if (report.kept.length) parts.push('The paper’s files were already in the folder.');
  if (report.missing.length) parts.push(`Not there: ${report.missing.join('; ')}.`);
  return parts.join(' ');
}
