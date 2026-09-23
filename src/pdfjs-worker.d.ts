// The pdf.js worker script, imported as a module of the app when the
// browser will not run it as a worker (see `pdfReflow.ts`). pdf.js ships
// no types for it; the one export that matters is what pdf.js looks for.
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown;
}
