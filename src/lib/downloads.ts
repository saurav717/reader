/**
 * The paper, from your own Downloads folder — the way through every wall at
 * once, with nothing running anywhere.
 *
 * A site's check for a person, an institution's sign-in, Google's opinion of
 * a datacenter: your own browser passes all of them without noticing, and
 * it will not let this page read what it fetched. But it will let the page
 * read a folder you point it at. So: point the reader at your Downloads
 * folder once, open the paper in a tab of your own, save the PDF the way
 * you would anyway, and the reader takes it from the folder the moment it
 * lands — no drag, no file dialog. The File System Access API is what
 * allows it, which is Chrome's and Edge's; elsewhere the drop-in stands.
 *
 * Nothing is read but the folder's listing and the first bytes of a new
 * PDF; the permission is read-only and lasts the tab.
 */

/** The little of the File System Access API this needs — TypeScript's DOM library does not yet name all of it. */
export interface DirectoryLike {
  values(): AsyncIterable<EntryLike>;
}
export interface EntryLike {
  kind: 'file' | 'directory';
  name: string;
  getFile?: () => Promise<File>;
}

/** Whether this browser can hand a folder to a page at all. */
export function canWatchDownloads(): boolean {
  return typeof window !== 'undefined' && typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/** Ask for the folder — the Downloads folder, to start with. Must be called from a click. */
export async function pickDownloads(): Promise<DirectoryLike> {
  const picker = (window as unknown as { showDirectoryPicker: (options: object) => Promise<DirectoryLike> }).showDirectoryPicker;
  return picker({ id: 'reader-downloads', mode: 'read', startIn: 'downloads' });
}

/** A file a browser is still writing: Chrome's, Firefox's and Safari's part-files. */
export const PART_FILE = /\.(?:crdownload|part|download|tmp)$/i;

/**
 * The first PDF to land in the folder from now: a file that was not there
 * when the watch began (or has been written since), is not a part-file,
 * has stopped growing — the same size on two looks in a row — and starts
 * with `%PDF`. Looks every `every` milliseconds until one comes, or the
 * signal aborts. A file that turns out not to be a PDF is passed over,
 * once, and the watch goes on.
 */
export async function watchForPdf(
  dir: DirectoryLike,
  {
    since = Date.now(),
    every = 1500,
    signal,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: { since?: number; every?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<File> {
  const before = new Set<string>();
  for await (const entry of dir.values()) before.add(entry.name);
  const sizes = new Map<string, number>();
  const passed = new Set<string>();
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    for await (const entry of dir.values()) {
      if (entry.kind !== 'file' || !entry.getFile || passed.has(entry.name)) continue;
      if (!/\.pdf$/i.test(entry.name) || PART_FILE.test(entry.name)) continue;
      let file: File;
      try {
        file = await entry.getFile();
      } catch {
        continue; // still being written, or gone
      }
      if (before.has(entry.name) && file.lastModified < since) continue;
      const last = sizes.get(entry.name);
      sizes.set(entry.name, file.size);
      if (file.size === 0 || last !== file.size) continue; // first sight, or still growing
      const head = String.fromCharCode(...new Uint8Array(await file.slice(0, 5).arrayBuffer()));
      if (!head.startsWith('%PDF')) {
        passed.add(entry.name);
        continue;
      }
      return file;
    }
    await sleep(every);
  }
}
