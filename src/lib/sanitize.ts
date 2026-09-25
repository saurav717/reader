// ===========================================================================
//  Cleaning what Claude drew before it goes into the page — and cleaning it
//  again when a copy of it is kept.
//
//  Prose from Claude is Markdown, rendered by our own `markdown()` and then run
//  through DOMPurify's defaults. A figure is different: it is SVG written by
//  the model, verbatim, and dropped into the document as it is. DOMPurify's
//  SVG profile removes scripts and event handlers, but on its own it still
//  lets through what a figure has no business carrying — a `<style>` block
//  that can restyle the page around it, an `<image>` that fetches from
//  wherever it likes, a link, a `foreignObject` that smuggles HTML back in —
//  and the Explain prompt already forbids all of these. So the sanitiser says
//  the same thing: no scripts, no external images, no fonts or stylesheets,
//  colour and shape only through the classes the theme provides.
//
//  A kept piece is a copy of rendered Explain content, so it has the maths
//  typeset by KaTeX, and KaTeX's output depends on inline `style` for its
//  spacing (`margin-right`, `height`, `vertical-align`). The `style`
//  attribute therefore stays allowed on a clip while the `<style>` element,
//  and everything that can fetch or frame, does not.
// ===========================================================================

import DOMPurify from 'dompurify';

/** What a figure may not contain: nothing that fetches, links, restyles or embeds. */
const FIGURE_FORBIDDEN_TAGS = ['style', 'image', 'a', 'foreignObject', 'script'];
const FIGURE_FORBIDDEN_ATTRS = ['style', 'href', 'xlink:href'];

/** What a kept copy may not contain. Links stay: the prose ones are https only already. */
const CLIP_FORBIDDEN_TAGS = ['style', 'image', 'foreignObject', 'script', 'iframe', 'object', 'embed'];

/**
 * A figure Claude wrote — an `<svg>` — made safe to draw. Only SVG and its
 * filters are allowed at all, and within that nothing that could reach out
 * of the figure: no stylesheet, no image, no link, no HTML island, no
 * inline style. Shapes, text, classes and the geometry are untouched.
 */
export function cleanFigure(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FIGURE_FORBIDDEN_TAGS,
    FORBID_ATTR: FIGURE_FORBIDDEN_ATTRS,
  });
}

/**
 * A copy of part of the rendered Explain page, made safe to keep and draw
 * again. DOMPurify's default profiles, minus the stylesheet element and
 * everything that fetches or frames. The `style` attribute is kept on
 * purpose: KaTeX's typeset maths would fall apart without it.
 */
export function cleanClip(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: CLIP_FORBIDDEN_TAGS });
}
