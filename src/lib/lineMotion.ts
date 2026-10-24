// ===========================================================================
//  Line animation for drawn figures: a figure draws itself as it comes into
//  view — each stroke traced from one end to the other, in the order it was
//  drawn, the boxes and fills fading in after their outlines, the arrowheads
//  last — and draws itself again on a click. Nothing is asked of a model: a
//  figure's SVG is read as it is (src/lib/sanitize.ts has cleaned it), and
//  the stylesheet's `ln-*` rules do the moving. Off under
//  prefers-reduced-motion, where the stylesheet shows every figure at once.
// ===========================================================================

/** What is traced: anything with a stroke that has a length. */
const TRACED = 'path, line, polyline, polygon, circle, ellipse, rect';
/** How long one figure takes to draw, all told (ms), and the least a stroke gets. */
export const DRAW_MS = 1400;
export const STROKE_MS = 420;
const DONE = 'data-ln';

/**
 * When each of `count` strokes starts, so that the whole figure takes
 * about DRAW_MS: evenly spread, the last starting before the first has
 * finished when there are few, a steady cascade when there are many.
 */
export function stagger(count: number, total = DRAW_MS, each = STROKE_MS): number[] {
  if (count <= 0) return [];
  const span = Math.max(0, total - each);
  const gap = count > 1 ? Math.min(each * 0.6, span / (count - 1)) : 0;
  return Array.from({ length: count }, (_, i) => Math.round(i * gap));
}

const hasStroke = (element: SVGElement) => {
  const stroke = element.getAttribute('stroke') ?? '';
  const classes = element.getAttribute('class') ?? '';
  if (stroke === 'none') return false;
  // The page's figures colour strokes with s-* classes, or inherit the ink; a fill-only shape says fill and no stroke.
  if (stroke || /\bs-(ink|muted|accent)\b/.test(classes)) return true;
  const tag = element.tagName.toLowerCase();
  // Lines and paths are strokes unless they say otherwise; closed shapes are fills unless they ask for a stroke.
  return tag === 'path' || tag === 'line' || tag === 'polyline';
};

/** Marks a figure's strokes and fills for the stylesheet, in drawing order. Once per figure. */
export function prepareDrawing(svg: SVGSVGElement): boolean {
  if (svg.hasAttribute(DONE)) return false;
  svg.setAttribute(DONE, 'ready');
  const shapes = Array.from(svg.querySelectorAll<SVGElement>(TRACED)).filter((element) => !element.closest('marker, defs, clipPath, mask, pattern'));
  const traced = shapes.filter(hasStroke);
  const delays = stagger(traced.length);
  traced.forEach((element, i) => {
    // pathLength normalises every stroke to 1, so one dash rule traces all of them.
    element.setAttribute('pathLength', '1');
    element.classList.add('ln-draw');
    element.style.setProperty('--ln-delay', `${delays[i]}ms`);
  });
  // Fills, and the text, appear as their outlines finish; arrowheads with the last stroke.
  const last = delays.length ? delays[delays.length - 1] : 0;
  shapes
    .filter((element) => !hasStroke(element))
    .forEach((element, i, all) => {
      element.classList.add('ln-appear');
      element.style.setProperty('--ln-delay', `${Math.round((last * (i + 1)) / Math.max(1, all.length))}ms`);
    });
  svg.querySelectorAll<SVGElement>('text').forEach((element) => {
    element.classList.add('ln-appear');
    element.style.setProperty('--ln-delay', `${Math.round(last * 0.6)}ms`);
  });
  svg.querySelectorAll<SVGElement>('marker').forEach((element) => element.classList.add('ln-marker'));
  svg.style.setProperty('--ln-last', `${last + STROKE_MS}ms`);
  return true;
}

/** Plays a prepared figure: now, or again. */
export function playDrawing(svg: SVGSVGElement) {
  if (!svg.hasAttribute(DONE)) prepareDrawing(svg);
  svg.classList.remove('ln-play');
  // A frame between, so the animation restarts rather than carrying on.
  void svg.getBoundingClientRect();
  requestAnimationFrame(() => svg.classList.add('ln-play'));
}

/**
 * Every drawn figure under `root` draws itself as it scrolls into view, the
 * ones added later (a page still streaming) too. Returns what stops the watch.
 */
export function watchDrawings(root: HTMLElement, selector = '.figure-art:not(.paper-art):not(.photo-art) > svg'): () => void {
  if (typeof IntersectionObserver === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => undefined;
  const seen = new WeakSet<Element>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        playDrawing(entry.target as SVGSVGElement);
      }
    },
    { root, threshold: 0.35 },
  );
  const look = () => {
    for (const svg of root.querySelectorAll<SVGSVGElement>(selector)) {
      if (seen.has(svg)) continue;
      seen.add(svg);
      prepareDrawing(svg);
      observer.observe(svg);
    }
  };
  look();
  const mutations = new MutationObserver(look);
  mutations.observe(root, { childList: true, subtree: true });
  return () => {
    mutations.disconnect();
    observer.disconnect();
  };
}
