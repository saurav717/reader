// A frame of a Studio scene (src/lib/studio.ts) drawn on a canvas, in the
// page's own colours: a grid as cells, a density as a bell, bars as bars.
// Shared by the Studio and by the card in the page, which is why it is not
// in Studio.tsx: the card is part of every page, the Studio loads on demand.

import { useEffect, useRef } from 'react';
import { bell } from '../lib/studio';
import type { Frame, StudioSpec } from '../lib/studio';

type RGB = [number, number, number];
export interface Palette {
  paper: RGB;
  ink: RGB;
  accent: RGB;
  soft: RGB;
  mark: RGB;
}

const hex = (value: string, fallback: RGB): RGB => {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
const mixRgb = (a: RGB, b: RGB, u: number): RGB => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

/** The page's colours, read once from the element the canvas sits in, so the frames follow the theme. */
export function paletteOf(element: Element): Palette {
  const style = getComputedStyle(element);
  const get = (name: string, fallback: RGB) => hex(style.getPropertyValue(name), fallback);
  return { paper: get('--surface', [255, 253, 247]), ink: get('--ink', [26, 26, 23]), accent: get('--accent', [31, 94, 82]), soft: get('--accent-soft', [228, 239, 231]), mark: get('--gold', [184, 150, 63]) };
}

/** Draws a frame to fill the canvas: grids as cells, a density as a bell, bars as bars. `tone` picks the grid ramp: ink for a picture, accent for a map of values. */
export function drawFrame(canvas: HTMLCanvasElement, frame: Frame, palette: Palette, tone: 'ink' | 'accent', /** The side in pixels, for a canvas that is not on the page (a texture). */ pixels?: number) {
  const size = pixels ?? (Math.max(16, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1))) || 96);
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);
  if (frame.kind === 'grid') {
    const rows = frame.grid.length;
    const cols = frame.grid[0]?.length ?? 0;
    if (!rows || !cols) return;
    const dark = tone === 'ink' ? palette.ink : palette.accent;
    const cw = size / cols;
    const ch = size / rows;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = rgb(mixRgb(palette.paper, dark, 1 - frame.grid[y][x]));
        ctx.fillRect(Math.floor(x * cw), Math.floor(y * ch), Math.ceil(cw), Math.ceil(ch));
      }
    return;
  }
  ctx.fillStyle = rgb(palette.paper);
  ctx.fillRect(0, 0, size, size);
  if (frame.kind === 'density') {
    ctx.fillStyle = rgb(palette.soft);
    ctx.beginPath();
    ctx.moveTo(0, size);
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      ctx.lineTo(x * size, size - bell(frame, x) * size * 0.86);
    }
    ctx.lineTo(size, size);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgb(palette.accent);
    ctx.lineWidth = Math.max(1, size / 48);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const y = size - bell(frame, x) * size * 0.86;
      if (i) ctx.lineTo(x * size, y);
      else ctx.moveTo(x * size, y);
    }
    ctx.stroke();
    ctx.fillStyle = rgb(palette.accent);
    ctx.fillRect(frame.mean * size - 1, size * 0.1, 2, size * 0.9);
    if (frame.mark !== undefined) {
      ctx.fillStyle = rgb(palette.mark);
      ctx.fillRect(frame.mark * size - Math.max(1, size / 48), size * 0.8, Math.max(2, size / 24), size * 0.2);
    }
    return;
  }
  if (frame.kind === 'bars') {
    const n = frame.values.length;
    if (!n) return;
    const top = Math.max(1e-6, ...frame.values.map(Math.abs));
    const gap = size / (n * 6);
    const bw = (size - gap * (n + 1)) / n;
    for (let i = 0; i < n; i++) {
      const h = (Math.abs(frame.values[i]) / top) * size * 0.84;
      ctx.fillStyle = rgb(frame.values[i] < 0 ? palette.mark : palette.accent);
      ctx.fillRect(gap + i * (bw + gap), size * 0.92 - h, bw, h);
    }
    ctx.fillStyle = rgb(palette.ink);
    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, size * 0.92, size, 1);
    ctx.globalAlpha = 1;
    return;
  }
  const dot = (x: number, y: number, r: number, colour: RGB, alpha = 1) => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgb(colour);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  if (frame.kind === 'curve') {
    // The landscape, the dots left behind, and the point where the state stands now.
    const pad = size * 0.08;
    const w = size - pad * 2;
    const h = size * 0.78;
    const yAt = (x: number) => {
      const v = frame.values;
      const t = x * (v.length - 1);
      const i = Math.min(v.length - 2, Math.max(0, Math.floor(t)));
      return size * 0.9 - (v[i] + (v[i + 1] - v[i]) * (t - i)) * h;
    };
    ctx.fillStyle = rgb(palette.soft);
    ctx.beginPath();
    ctx.moveTo(pad, size * 0.9);
    for (let i = 0; i <= 64; i++) ctx.lineTo(pad + (i / 64) * w, yAt(i / 64));
    ctx.lineTo(pad + w, size * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgb(palette.accent);
    ctx.lineWidth = Math.max(1, size / 48);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pad + (i / 64) * w, yAt(i / 64));
    ctx.stroke();
    for (const t of frame.trail) dot(pad + t * w, yAt(t), size / 40, palette.ink, 0.35);
    dot(pad + frame.at * w, yAt(frame.at), size / 16, palette.mark);
    return;
  }
  if (frame.kind === 'map') {
    const rows = frame.grid.length;
    const cols = frame.grid[0]?.length ?? 0;
    if (rows && cols) {
      const cw = size / cols;
      const ch = size / rows;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          ctx.fillStyle = rgb(mixRgb(palette.paper, palette.accent, frame.grid[y][x] * 0.85));
          ctx.fillRect(Math.floor(x * cw), Math.floor(y * ch), Math.ceil(cw), Math.ceil(ch));
        }
    }
    // y runs up the page in the spec; the canvas counts down.
    const px = (pt: [number, number]): [number, number] => [pt[0] * size, (1 - pt[1]) * size];
    if (frame.trail.length > 1) {
      ctx.strokeStyle = rgb(palette.mark);
      ctx.lineWidth = Math.max(1.5, size / 40);
      ctx.beginPath();
      frame.trail.forEach((pt, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ...px(pt)));
      ctx.lineTo(...px(frame.at));
      ctx.stroke();
    }
    for (const t of frame.trail) dot(...px(t), size / 40, palette.mark, 0.6);
    dot(...px(frame.at), size / 16, palette.mark);
    ctx.strokeStyle = rgb(palette.paper);
    ctx.lineWidth = Math.max(1, size / 64);
    ctx.beginPath();
    ctx.arc(...px(frame.at), size / 16, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (frame.kind === 'points') {
    const shades: RGB[] = [palette.accent, palette.mark, palette.ink, mixRgb(palette.accent, palette.paper, 0.5), mixRgb(palette.mark, palette.ink, 0.5)];
    frame.points.forEach((pt, i) => dot(pt[0] * size, (1 - pt[1]) * size, size / 28, shades[(frame.groups?.[i] ?? 0) % shades.length], 0.9));
    return;
  }
  if (frame.kind === 'tokens') {
    // The tokens laid out as text, wrapping, the marked one on an accent tile.
    const font = Math.max(8, size / 9);
    ctx.font = `${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    const pad = size * 0.06;
    const gapX = font * 0.6;
    const lineH = font * 1.6;
    let x = pad;
    let y = pad + lineH / 2;
    frame.tokens.forEach((token, i) => {
      const w = ctx.measureText(token).width + font * 0.5;
      if (x + w > size - pad && x > pad) {
        x = pad;
        y += lineH;
      }
      if (y > size - pad) return;
      if (i === frame.mark) {
        ctx.fillStyle = rgb(palette.accent);
        ctx.fillRect(x - font * 0.1, y - lineH * 0.42, w, lineH * 0.84);
        ctx.fillStyle = rgb(palette.paper);
      } else ctx.fillStyle = rgb(palette.ink);
      ctx.fillText(token, x + font * 0.15, y);
      x += w + gapX;
    });
    return;
  }
  // A graph: edges, then nodes shaded by their value, the active one ringed.
  const pad = size * 0.1;
  const px = (pt: [number, number]): [number, number] => [pad + pt[0] * (size - pad * 2), pad + (1 - pt[1]) * (size - pad * 2)];
  ctx.strokeStyle = rgb(palette.ink);
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(1, size / 64);
  for (const [a, b] of frame.edges) {
    ctx.beginPath();
    ctx.moveTo(...px(frame.nodes[a]));
    ctx.lineTo(...px(frame.nodes[b]));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  frame.nodes.forEach((node, i) => {
    const [x, y] = px(node);
    dot(x, y, size / 18, mixRgb(palette.paper, palette.accent, 0.15 + 0.85 * (frame.values[i] ?? 0.5)));
    ctx.strokeStyle = rgb(i === frame.active ? palette.mark : palette.ink);
    ctx.lineWidth = i === frame.active ? Math.max(2, size / 32) : Math.max(1, size / 96);
    ctx.globalAlpha = i === frame.active ? 1 : 0.5;
    ctx.beginPath();
    ctx.arc(x, y, size / 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  });
}

/** A canvas that draws a frame and redraws it when the frame changes. */
export function FrameCanvas({ frame, tone, className, label }: { frame: Frame; tone: 'ink' | 'accent'; className?: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawFrame(canvas, frame, paletteOf(canvas), tone);
  });
  return <canvas ref={ref} className={`studio-frame${className ? ` ${className}` : ''}`} role="img" aria-label={label} />;
}

export const toneOf = (spec: Pick<StudioSpec, 'show'>): 'ink' | 'accent' => (spec.show?.kind === 'noise' ? 'ink' : 'accent');
