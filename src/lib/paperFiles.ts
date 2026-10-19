// The paper's files in a project that starts from one, by name — and the line the briefings use to point the agents at
// them. Nothing else here, so the modules that only name the files (the agent's prompts, the first files of a project)
// pull in none of the reader's PDF or Explain machinery; src/lib/paperContext.ts gathers and writes the files.

export const PAPER_DIR = 'paper';
/** The full text, as the reader reflowed it: Markdown with front matter. */
export const PAPER_TEXT_FILE = `${PAPER_DIR}/paper.md`;
/** The Explain page, as the file the reader keeps in Drive. */
export const EXPLANATION_FILE = `${PAPER_DIR}/EXPLANATION.md`;
/** The PDF itself, where the folder can hold a binary file. */
export const PAPER_PDF_FILE = `${PAPER_DIR}/paper.pdf`;

/** How the folder's briefings name the paper's files — AGENTS.md, the plan, the agents' prompts — so the four say the same thing. */
export const PAPER_FILES_NOTE =
  `The paper is in the folder: ${PAPER_TEXT_FILE} holds its full text as the reader reflowed it, ${EXPLANATION_FILE} the ` +
  `reader's Explain page (what the paper does and why, section by section), ${PAPER_PDF_FILE} the PDF itself where the ` +
  `folder could take it, and IMPLEMENTATION_PLAN.md the plan drawn up on its Implementation page. Read these; they are ` +
  `the paper. Do not search the web for the paper or fetch it from arXiv — everything you need is here, and the network ` +
  `may not be.`;
