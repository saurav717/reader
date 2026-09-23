/**
 * The pdf.js worker script as a module of the app, for reading PDFs on the
 * main thread when the browser will not start it as a worker (see
 * `pdfReflow.ts`). A module of its own so that it is a chunk of its own,
 * loaded only then, and named apart from the worker script proper.
 */
export { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
