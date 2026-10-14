// A QR code, drawn as SVG: the invite link, for a slide or a lab meeting.
// The encoding is qrcode-generator's (Kazuhiko Arase, MIT); the drawing is
// one rect per dark module, so it scales to any size and prints crisply.

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const rows: boolean[][] = [];
  for (let r = 0; r < count; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < count; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

/** The SVG as a string: for a download, and for the drawing below. */
export function qrSvg(text: string, size = 240): string {
  const modules = qrModules(text);
  const n = modules.length;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  const rects: string[] = [];
  modules.forEach((row, r) => row.forEach((dark, c) => dark && rects.push(`<rect x="${(c + quiet) * cell}" y="${(r + quiet) * cell}" width="${cell}" height="${cell}"/>`)));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#1a1a17">${rects.join('')}</g></svg>`;
}

export default function QrCode({ text, size = 120, title }: { text: string; size?: number; title?: string }) {
  const svg = useMemo(() => qrSvg(text, 240), [text]);
  return <span className="qr" role="img" aria-label={title ?? `QR code for ${text}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
