// ===========================================================================
//  Going to a cell of the notebook from elsewhere: the Ask AI window's
//  answers name cells ("cell 5 prints the weights"), and each such mention
//  is a link that brings that cell into view on the Colab tab, switching to
//  the tab first when another page is open. The event goes out here; the
//  Explain page and the notebook page listen.
// ===========================================================================

export const SHOW_CELL = 'reader:notebook-show-cell';

export interface ShowCell {
  /** The cell's number as the notebook lists it, from 1. */
  cell: number;
}

export function showNotebookCell(cell: number) {
  if (!Number.isInteger(cell) || cell < 1) return;
  window.dispatchEvent(new CustomEvent<ShowCell>(SHOW_CELL, { detail: { cell } }));
}

// A cell asked for while the Colab tab was not the one open: held until the notebook page mounts and takes it.
let held: number | null = null;
export const holdCell = (cell: number) => {
  held = cell;
};
export function takeHeldCell(): number | null {
  const cell = held;
  held = null;
  return cell;
}

const MENTION = /\b([Cc]ells?)(\s+)(\d{1,3})((?:\s*(?:,|and|&|or|to|–|—|-)\s*\d{1,3})*)\b/g;
const NUMBER = /\d{1,3}/g;

/**
 * Every "cell 5", "Cell 12", "cells 3 and 5", "cells 2, 4 and 6" in a reply's
 * HTML becomes a link to that cell — outside <code> and <pre>, where a number
 * is code, not a mention.
 */
export function linkCells(html: string): string {
  const parts = html.split(/(<(?:code|pre)\b[^>]*>[\s\S]*?<\/(?:code|pre)>|<[^>]+>)/g);
  return parts
    .map((part, index) => {
      // Odd parts are the tags and the code they enclose, left alone.
      if (index % 2 === 1) return part;
      return part.replace(MENTION, (_match, word: string, space: string, first: string, rest: string) => {
        const link = (n: string) => `<a class="chat-cell" href="#cell-${n}" data-cell="${n}" title="Go to cell ${n} in the notebook">${n}</a>`;
        return `${word}${space}${link(first)}${rest.replace(NUMBER, (n) => link(n))}`;
      });
    })
    .join('');
}
