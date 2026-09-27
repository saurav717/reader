// Reflow on a technical report set as a single column, as DeepSeek set
// "DeepSeek-VL: Towards Real-World Vision-Language Understanding" (arXiv
// 2403.05525), made up run by run as pdf.js reads it. Most of it came out
// wrong: two tables set one over the other, captioned under, each took the
// other's rows or none, and their cells ran on as paragraphs; a table over
// a plot drawn in paths took the plot's ticks for rows; a table of records
// whose cells run to several lines, parted by rules, was no table, and one
// whose cells are set justified split every wide space into a column; the
// contents page came out as headings; the abstract's items lost their
// lines after the first; a reference with an address in it broke at the
// address; paragraphs parted by space rather than an indent ran together;
// "References" and the appendix were a level under the sections; and the
// footnotes and the institution under the names were lost to the byline.
//
//   node --test scripts/pdf-reflow-report.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const { layoutPages, plain } = await load('src/lib/pdfLayout.ts');

after(cleanup);

const ROMAN = 'URWPalladioL-Roma';
const BOLD = 'URWPalladioL-Bold';
const SIZE = 10.9;
const LEADING = 13.5;
const LEFT = 71;
const WIDTH = 453;
const run = (str, x, y, { size = SIZE, font = ROMAN, width } = {}) => ({ str, x, y, width: width ?? str.length * size * 0.45, size, font });
const page = (runs, graphics = [], index = 0, links = []) => ({ index, width: 595, height: 842, runs, graphics, links });
/** A page after the first, whose front matter is read apart. */
const later = (runs, graphics = [], links = []) => layoutPages([page(paragraph(100, 45, 'Opening line')), page(runs, graphics, 1, links)]);
const text = (block) => ('spans' in block ? plain(block.spans) : plain(block.caption ?? []));
const cells = (table) => table.rows.map((row) => row.map((cell) => plain(cell.spans)));

/** A paragraph of justified lines from `top`, its first indented, its last short. */
function paragraph(top, count, words, { indent = 17, last = 0.5 } = {}) {
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const first = index === 0;
    const final = index === count - 1;
    const x = LEFT + (first ? indent : 0);
    out.push(run(`${words} ${index + 1} of the paragraph set out in full here${final ? '.' : ''}`, x, top + index * LEADING, { width: final ? WIDTH * last : WIDTH - (first ? indent : 0) }));
  }
  return out;
}

/** A booktabs rule across the table. */
const rule = (x0, x1, y) => ({ x0, y0: y - 0.2, x1, y1: y + 0.2, kind: 'path' });

describe('a report\'s tables', () => {
  it('gives each of two tables set one over the other, captioned under, its own rows', () => {
    // Two tables captioned under, one over the other; and one table on the
    // next page whose only side is over its caption, which tells which way
    // the paper sets them.
    const table = (top, names) => [
      run('Model', 110, top, { width: 30 }),
      run('MMB', 300, top, { width: 24 }),
      run('SEED', 400, top, { width: 26 }),
      ...names.flatMap((name, index) => [run(name, 110, top + 14 * (index + 1), { width: 60 }), run(`${60 + index}.0`, 300, top + 14 * (index + 1), { width: 20 }), run(`${70 + index}.5`, 400, top + 14 * (index + 1), { width: 20 })]),
    ];
    const first = [
      ...table(100, ['Gemini Pro', 'GPT-4V', 'Qwen-VL']),
      run('Table 5 | The comparison between different models.', LEFT, 170, { width: 260 }),
      ...table(200, ['MobileVLM', 'LLaVA-Phi']),
      run('Table 6 | The comparison between tiny models.', LEFT, 256, { width: 230 }),
      ...paragraph(300, 6, 'Body line'),
    ];
    const rules = [rule(100, 450, 90), rule(100, 450, 104), rule(100, 450, 152), rule(100, 450, 190), rule(100, 450, 204), rule(100, 450, 238)];
    const second = [...paragraph(100, 6, 'Second page line'), ...table(220, ['DeepSeek-VL', 'CogVLM']), run('Table 7 | The performance on language benchmarks.', LEFT, 276, { width: 250 }), ...paragraph(320, 5, 'After line')];
    const layout = layoutPages([page(first, rules), page(second, [rule(100, 450, 210), rule(100, 450, 224), rule(100, 450, 258)], 1)]);
    const tables = layout.blocks.filter((block) => block.kind === 'table');
    assert.deepEqual(tables.map((one) => one.label), ['Table 5', 'Table 6', 'Table 7']);
    assert.deepEqual(cells(tables[0]).map((row) => row[0]), ['Model', 'Gemini Pro', 'GPT-4V', 'Qwen-VL']);
    assert.deepEqual(cells(tables[1]).map((row) => row[0]), ['Model', 'MobileVLM', 'LLaVA-Phi']);
    // None of their cells run on as text.
    assert.ok(!layout.blocks.some((block) => block.kind === 'paragraph' && /Gemini|MobileVLM|Table 6/.test(text(block))));
  });

  it('ends a table over a plot drawn in paths where the plot begins, and leaves the plot to its figure', () => {
    const runs = [
      ...paragraph(90, 5, 'Body line'),
      run('Table 9 | Analysis of model performance across training stages.', LEFT, 175, { width: 300 }),
      run('Stage', 110, 195, { width: 30 }),
      run('MMB', 300, 195, { width: 24 }),
      run('1', 110, 209, { width: 6 }),
      run('59.4', 300, 209, { width: 20 }),
      run('2', 110, 223, { width: 6 }),
      run('63.4', 300, 223, { width: 20 }),
      // The plot's tick labels, rows of numbers of their own.
      run('2.170', 100, 260, { size: 5, width: 12 }),
      run('2.165', 100, 290, { size: 5, width: 12 }),
      run('2000', 140, 345, { size: 5, width: 10 }),
      run('4000', 200, 345, { size: 5, width: 10 }),
      run('6000', 260, 345, { size: 5, width: 10 }),
      run('Figure 8 | Comparative analysis of modality warmup on language.', LEFT, 370, { width: 300 }),
      ...paragraph(400, 5, 'After line'),
    ];
    const graphics = [
      rule(100, 450, 185),
      rule(100, 450, 199),
      rule(100, 450, 230),
      // The plot: its frame and a curve, in paths.
      { x0: 115, y0: 250, x1: 480, y1: 340, kind: 'path' },
      { x0: 120, y0: 260, x1: 470, y1: 330, kind: 'path' },
    ];
    const layout = layoutPages([page(runs, graphics)]);
    const table = layout.blocks.find((block) => block.kind === 'table');
    assert.deepEqual(cells(table), [['Stage', 'MMB'], ['1', '59.4'], ['2', '63.4']]);
    const figure = layout.blocks.find((block) => block.kind === 'figure');
    assert.equal(figure?.label, 'Figure 8');
    assert.ok(figure.crop.y0 > 235, `the figure is under the table: ${JSON.stringify(figure.crop)}`);
  });

  it('reads a table of records parted by rules, each cell running to several lines, one row a record', () => {
    const size = 9;
    const at = (str, x, y, width) => run(str, x, y, { size, width });
    const runs = [
      run('Table 1 | Summary of datasets used in the pretraining stage.', LEFT, 100, { width: 290 }),
      at('Category', 110, 125, 40),
      at('Dataset', 250, 125, 35),
      at('Ratio', 440, 125, 22),
      at('Interleaved image-text', 110, 145, 95),
      at('MMC4 (Zhu et al., 2024)', 250, 145, 100),
      at('Wikipedia EN& CN (Foundation)', 250, 157, 130),
      at('Wikihow (Yang et al., 2021)', 250, 169, 110),
      at('13.1%', 440, 145, 24),
      at('Image caption', 110, 187, 60),
      at('Capsfusion (Yu et al., 2023a)', 250, 187, 115),
      at('TaiSu (Liu et al., 2022b)', 250, 199, 100),
      at('11.1%', 440, 187, 24),
      at('Web Code', 110, 217, 42),
      at('Websight (HuggingFaceM4, 2024)', 250, 217, 135),
      at('python plots scraped from GitHub notebook', 250, 229, 170),
      at('0.4%', 440, 217, 20),
      at('Document OCR', 110, 247, 60),
      at('arXiv rendered markdown (Blecher et al., 2023)', 250, 247, 170),
      at('2.1%', 440, 247, 20),
      // A record of a dozen lines, as most of the table's rows are one cell.
      at('Scene text OCR', 110, 265, 62),
      ...['ArT (Chng et al., 2019)', 'MLT-17 (Nayef et al., 2017)', 'LSVT (Sun et al., 2019)', 'UberText (Zhang et al., 2017)', 'Coco-text (Veit et al., 2016)', 'RCTW-17 (Shi et al., 2017)', 'ReCTS (Zhang et al., 2019)', 'TextOCR (Singh et al., 2021)', 'OpenVINO (Krylov et al., 2021)', 'HierText (Long et al., 2022)'].map((name, index) => at(name, 250, 265 + 12 * index, 120)),
      at('1.2%', 440, 265, 20),
      ...paragraph(420, 5, 'After line'),
    ];
    const graphics = [rule(105, 470, 115), rule(105, 470, 131), rule(105, 470, 176), rule(105, 470, 206), rule(105, 470, 236), rule(105, 470, 255), rule(105, 470, 380)];
    const table = later(runs, graphics).blocks.find((block) => block.kind === 'table');
    assert.ok(table?.rows, 'read as a table');
    assert.deepEqual(cells(table), [
      ['Category', 'Dataset', 'Ratio'],
      ['Interleaved image-text', 'MMC4 (Zhu et al., 2024) Wikipedia EN& CN (Foundation) Wikihow (Yang et al., 2021)', '13.1%'],
      ['Image caption', 'Capsfusion (Yu et al., 2023a) TaiSu (Liu et al., 2022b)', '11.1%'],
      ['Web Code', 'Websight (HuggingFaceM4, 2024) python plots scraped from GitHub notebook', '0.4%'],
      ['Document OCR', 'arXiv rendered markdown (Blecher et al., 2023)', '2.1%'],
      ['Scene text OCR', 'ArT (Chng et al., 2019) MLT-17 (Nayef et al., 2017) LSVT (Sun et al., 2019) UberText (Zhang et al., 2017) Coco-text (Veit et al., 2016) RCTW-17 (Shi et al., 2017) ReCTS (Zhang et al., 2019) TextOCR (Singh et al., 2021) OpenVINO (Krylov et al., 2021) HierText (Long et al., 2022)', '1.2%'],
    ]);
    // A dataset a line, as the paper lists them.
    const listed = table.rows[1][1].spans.map((span) => span.text).join('');
    assert.equal(listed, 'MMC4 (Zhu et al., 2024)\nWikipedia EN& CN (Foundation)\nWikihow (Yang et al., 2021)');
  });

  it('keeps a cell set justified in its column, mends its broken words, and ends the heading at the rule under it, not at a "-"', () => {
    const size = 7;
    const at = (str, x, y, width) => run(str, x, y, { size, width });
    // A description set justified in a narrow column: its wide spaces are
    // pdf.js's gaps between runs, a word a run.
    const words = (list, y) => list.map(([str, x, width]) => at(str, x, y, width));
    const runs = [
      at('Main Category', 90, 120, 50),
      at('Description', 175, 120, 45),
      at('Secondary Category', 330, 120, 70),
      at('Tertiary Category', 430, 120, 65),
      at('Recognition', 90, 140, 40),
      ...words([['This', 175, 12], ['part', 193, 14], ['of', 213, 7], ['the', 226, 11], ['use', 243, 11], ['cases', 260, 18], ['under-', 284, 26]], 140),
      ...words([['standing', 175, 30], ['and', 211, 12], ['description', 229, 40], ['ability', 275, 25]], 149),
      at('Global Description', 330, 140, 65),
      ...words([['Theme', 430, 22], ['Description,', 458, 42], ['Lo-', 506, 12]], 140),
      at('cation/Scene Description', 430, 149, 85),
      at('Local Description', 330, 170, 60),
      ...words([['Pointing', 430, 28], ['Description,', 464, 42], ['Person', 512, 12]], 170),
      at('Recognition, Counting', 430, 179, 80),
      ...words([['Commonsense', 90, 44], ['Rea-', 140, 16]], 200),
      at('soning', 90, 209, 22),
      ...words([['This', 175, 12], ['type', 193, 15], ['tests', 214, 17], ['common', 237, 28], ['sense.', 271, 21]], 200),
      at('Humor Reasoning', 330, 200, 60),
      at('-', 430, 200, 3),
      ...paragraph(250, 5, 'After line'),
      run('Table 3 | Our taxonomy for the in-house SFT data.', LEFT, 232, { width: 240 }),
    ];
    const graphics = [rule(85, 525, 110), rule(85, 525, 127), rule(325, 525, 163), rule(85, 525, 190), rule(85, 525, 215)];
    const table = later(runs, graphics).blocks.find((block) => block.kind === 'table');
    assert.ok(table?.rows, 'read as a table');
    const rows = cells(table);
    // Four columns: no wide space in a cell made one of its own.
    assert.ok(rows.every((row) => row.length <= 4), JSON.stringify(rows));
    assert.deepEqual(rows[0], ['Main Category', 'Description', 'Secondary Category', 'Tertiary Category']);
    assert.deepEqual(rows[1], ['Recognition', 'This part of the use cases understanding and description ability', 'Global Description', 'Theme Description, Location/Scene Description']);
    // The category and its description cover the rows under them.
    assert.equal(table.rows[1][0].rowspan, 2);
    assert.equal(table.rows[1][1].rowspan, 2);
    assert.deepEqual(rows[2], ['Local Description', 'Pointing Description, Person Recognition, Counting']);
    assert.deepEqual(rows[3], ['Commonsense Reasoning', 'This type tests common sense.', 'Humor Reasoning', '-']);
    // Only the first row is the heading, though no row holds a figure but a "-".
    assert.deepEqual(table.rows.map((row) => row.some((cell) => cell.head)), [true, false, false, false]);
  });
});

describe('documents set otherwise', () => {
  const table = (x, top, names) => [
    run('Method', x, top, { size: 9.5, width: 32 }),
    run('Dev', x + 60, top, { size: 9.5, width: 16 }),
    run('Test', x + 110, top, { size: 9.5, width: 18 }),
    ...names.flatMap((name, index) => [run(name, x, top + 17 * (index + 1), { size: 9.5, width: 38 }), run(`${60 + index}.1`, x + 60, top + 17 * (index + 1), { size: 9.5, width: 17 }), run('-', x + 110, top + 17 * (index + 1), { size: 9.5, width: 3 })]),
  ];

  it('finds a narrow table set centred under a short caption at the column\'s edge', () => {
    const runs = [...paragraph(90, 5, 'Body line'), run('Table 1. Results on the first benchmark.', LEFT, 170, { size: 9.5, width: 152 }), ...table(240, 195, ['Method A', 'Method B', 'Method C']), ...paragraph(290, 5, 'After line')];
    const graphics = [rule(235, 380, 183), rule(235, 380, 199), rule(235, 380, 250)];
    const found = later(runs, graphics).blocks.find((block) => block.kind === 'table');
    assert.deepEqual(cells(found), [['Method', 'Dev', 'Test'], ['Method A', '60.1', '-'], ['Method B', '61.1', '-'], ['Method C', '62.1', '-']]);
  });

  it('ends a table over a plot where the plot begins, though its tick labels sit between the plot and its caption', () => {
    // The table is captioned under; the vote of the page's captions must not
    // be swayed by the plot being read as a table under "Table 4".
    const runs = [
      ...paragraph(90, 5, 'Body line'),
      ...table(240, 165, ['Method A', 'Method B']),
      run('Table 4. Ablations.', LEFT, 225, { size: 9.5, width: 80 }),
      run('0', 160, 360, { size: 6, width: 3 }),
      run('2000', 240, 360, { size: 6, width: 12 }),
      run('4000', 320, 360, { size: 6, width: 12 }),
      run('Figure 1. Loss over training steps.', LEFT, 385, { size: 9.5, width: 140 }),
      ...paragraph(410, 5, 'After line'),
    ];
    const graphics = [rule(235, 380, 153), rule(235, 380, 169), rule(235, 380, 204), { x0: 150, y0: 245, x1: 470, y1: 352, kind: 'path' }, { x0: 155, y0: 255, x1: 465, y1: 345, kind: 'path' }];
    const blocks = later(runs, graphics).blocks;
    assert.deepEqual(cells(blocks.find((block) => block.kind === 'table')), [['Method', 'Dev', 'Test'], ['Method A', '60.1', '-'], ['Method B', '61.1', '-']]);
    assert.equal(blocks.find((block) => block.kind === 'figure')?.label, 'Figure 1');
  });

  it('keeps the last line of a paragraph carried to the head of the page with its paragraph, not in the table under it', () => {
    const first = paragraph(100, 45, 'Opening line', { last: 1 }).map((one, index, all) => (index === all.length - 1 ? { ...one, str: one.str.replace(/\.$/, '') } : one));
    const second = [
      run('and closes here.', LEFT, 88, { width: 70 }),
      ...table(90, 110, ['Model 0', 'Model 1', 'Model 2']),
      run('Table 1: Accuracy of each model.', LEFT, 185, { size: 9.5, width: 140 }),
      ...paragraph(210, 5, 'After line'),
    ];
    const graphics = [rule(85, 530, 100), rule(85, 530, 114), rule(85, 530, 168)];
    const blocks = layoutPages([page(first), page(second, graphics, 1)]).blocks;
    assert.deepEqual(cells(blocks.find((block) => block.kind === 'table'))[0], ['Method', 'Dev', 'Test']);
    assert.ok(blocks.some((block) => block.kind === 'paragraph' && /here Opening|full here and closes here\.$/.test(text(block))), JSON.stringify(blocks.map(text)));
  });

  it('leaves out a contents page whose entries are numbered at their left, and keeps a section called "Contents" that is a list of parts', () => {
    const entry = (n, y) => [run(`${n}`, LEFT, y, { width: 6 }), run(`Section title number ${n} ` + '. '.repeat(40), 95, y, { width: 380 }), run(`${n * 3}`, 530 - 5.5 * String(n * 3).length, y, { width: 5.5 * String(n * 3).length })];
    const contents = [run('Table of Contents', LEFT, 90, { size: 15, font: BOLD, width: 120 }), ...[1, 2, 3, 4, 5, 6].flatMap((n) => entry(n, 120 + 18 * n))];
    const parts = [
      run('2 Contents', LEFT, 90, { size: 12.5, font: BOLD, width: 70 }),
      ...[['Screws', '12'], ['Washers', '24'], ['Brackets', '4'], ['Hinges', '2']].flatMap(([name, count], index) => [run(name, 100, 112 + 16 * index, { width: 50 }), run(count, 530 - 5.5 * count.length, 112 + 16 * index, { width: 5.5 * count.length })]),
      ...paragraph(190, 30, 'Body line'),
    ];
    const blocks = layoutPages([page(contents), page(parts, [], 1)]).blocks.map(text);
    assert.ok(!blocks.some((block) => /Section title|Table of Contents/.test(block)), JSON.stringify(blocks));
    assert.ok(blocks.includes('2 Contents'));
    // Every part, and its count, is kept.
    for (const part of ['Screws 12', 'Washers 24', 'Brackets 4', 'Hinges 2']) assert.ok(blocks.some((block) => block.includes(part)), part);
  });
});

describe('a report\'s front matter and text', () => {
  it('leaves the contents page out, entries, dots and page numbers', () => {
    const entry = (label, title, y, number, bold) => [
      run(label, bold ? LEFT : 87, y, { font: bold ? BOLD : ROMAN, width: 14 }),
      run(title + (bold ? '' : ' . . . . . . . . . . . . . . . .'), bold ? 87 : 112, y, { font: bold ? BOLD : ROMAN, width: bold ? 90 : 300 }),
      run(number, 519, y, { font: bold ? BOLD : ROMAN, width: 5.5 }),
    ];
    const contents = [
      run('Contents', LEFT, 96, { size: 13, font: BOLD, width: 53 }),
      ...entry('1', 'Introduction', 131, '3', true),
      ...entry('2', 'Data Construction', 161, '6', true),
      ...entry('2.1', 'Vision-Language pretraining Data', 180, '6', false),
      ...entry('2.2', 'Supervised Fine-tuning Data', 199, '8', false),
      ...entry('3', 'Approach', 229, '10', true),
    ];
    const text1 = [run('1. Introduction', LEFT, 96, { size: 13, font: BOLD, width: 100 }), ...paragraph(120, 8, 'Introduction line')];
    const layout = layoutPages([page(contents), page(text1, [], 1)]);
    assert.deepEqual(layout.blocks.map((block) => `${block.kind}: ${text(block).slice(0, 20)}`), ['heading: 1. Introduction', 'paragraph: Introduction line 1 ']);
  });

  it('keeps an item set as a paragraph — its bullet indented, its lines turning over to the edge — whole', () => {
    const runs = [
      ...paragraph(100, 3, 'Opening line', { last: 0.3 }),
      run('•', 82, 150, { width: 6 }),
      run('Data Construction', 94, 150, { font: BOLD, width: 90 }),
      run(': We strive to ensure our data is diverse, scalable and covers', 184, 150, { width: 340 }),
      run('real-world scenarios including web screenshots, PDFs, OCR, charts, and knowledge', LEFT, 163.5, { width: WIDTH }),
      run('the model’s user experience in practical applications.', LEFT, 177, { width: 256 }),
      run('•', 82, 190.5, { width: 6 }),
      run('Model Architecture', 94, 190.5, { font: BOLD, width: 95 }),
      run(': Considering efficiency and the demands of most scenarios,', 189, 190.5, { width: 335 }),
      run('DeepSeek-VL incorporates a hybrid vision encoder.', LEFT, 204, { width: 240 }),
      run('The DeepSeek-VL family showcases superior user experiences as a chatbot in real-world', LEFT, 217.5, { width: WIDTH }),
      run('applications.', LEFT, 231, { width: 60 }),
      ...paragraph(260, 6, 'Filler line'),
    ];
    const blocks = layoutPages([page(runs)]).blocks.map(text);
    assert.ok(blocks.includes('• Data Construction: We strive to ensure our data is diverse, scalable and covers real-world scenarios including web screenshots, PDFs, OCR, charts, and knowledge the model’s user experience in practical applications.'), JSON.stringify(blocks));
    assert.ok(blocks.includes('• Model Architecture: Considering efficiency and the demands of most scenarios, DeepSeek-VL incorporates a hybrid vision encoder.'));
    // The paragraph after the list, flush left under a short line, is its own.
    assert.ok(blocks.some((block) => block.startsWith('The DeepSeek-VL family')));
  });

  it('parts paragraphs set apart by space rather than an indent', () => {
    const runs = [
      ...paragraph(100, 6, 'Body line'),
      run('Chart/table understanding', 88, 196, { font: BOLD, width: 132 }),
      run('datasets: OCRBench (Liu et al., 2023b);', 223, 196, { width: 186 }),
      // Set 20pt under it, where the lines of a paragraph are 13.5pt apart.
      run('Hallucination', 88, 216.3, { font: BOLD, width: 69 }),
      run('datasets: POPE (Li et al., 2023b);', 160, 216.3, { width: 155 }),
      run('Scientific problem', 88, 236.6, { font: BOLD, width: 91 }),
      run('datasets: ScienceQA (Lu et al., 2022a) and MathVista (Lu et al., 2023).', 182, 236.6, { width: 331.5 }),
      ...paragraph(257, 4, 'We apply'),
    ];
    const blocks = layoutPages([page(runs)]).blocks.map(text);
    assert.ok(blocks.includes('Chart/table understanding datasets: OCRBench (Liu et al., 2023b);'), JSON.stringify(blocks));
    assert.ok(blocks.includes('Hallucination datasets: POPE (Li et al., 2023b);'));
    assert.ok(blocks.includes('Scientific problem datasets: ScienceQA (Lu et al., 2022a) and MathVista (Lu et al., 2023).'));
  });

  it('keeps a reference whole where its address is set in a typewriter face, larger than the text', () => {
    const mono = 'LMMono10-Regular';
    const runs = [
      ...paragraph(100, 6, 'Body line'),
      run('References', LEFT, 200, { size: 13, font: BOLD, width: 65 }),
      run('Anthropic. Introducing Claude, 2023. URL', LEFT, 225, { width: 211 }),
      run('https://www.anthropic.com/index/introd', 285, 225, { size: 12, font: mono, width: 240 }),
      run('ucing-claude', 82, 238.5, { size: 12, font: mono, width: 76 }),
      run('.', 158, 238.5, { width: 3 }),
      run('J. Carter. Textocr-gpt4v.', LEFT, 261, { width: 120 }),
      run('https://huggingface.co/datasets/jimmycarter/textocr-g', 195, 261, { size: 12, font: mono, width: 330 }),
      run('pt4v', 82, 274.5, { size: 12, font: mono, width: 25 }),
      run(', 2024.', 107, 274.5, { width: 30 }),
      run('B. Zhang and R. Sennrich. Root mean square layer normalization, 2019.', LEFT, 297, { width: 330 }),
    ];
    // Each address a link, broken over two lines as it is set.
    const links = [
      { x0: 285, y0: 215, x1: 525, y1: 228, url: 'https://www.anthropic.com/index/introducing-claude' },
      { x0: 82, y0: 229, x1: 158, y1: 241, url: 'https://www.anthropic.com/index/introducing-claude' },
      { x0: 195, y0: 251, x1: 525, y1: 264, url: 'https://huggingface.co/datasets/jimmycarter/textocr-gpt4v' },
      { x0: 82, y0: 265, x1: 107, y1: 277, url: 'https://huggingface.co/datasets/jimmycarter/textocr-gpt4v' },
    ];
    const blocks = later(runs, [], links).blocks.map(text);
    const references = blocks.slice(blocks.indexOf('References') + 1);
    assert.deepEqual(references, [
      'Anthropic. Introducing Claude, 2023. URL https://www.anthropic.com/index/introducing-claude.',
      'J. Carter. Textocr-gpt4v. https://huggingface.co/datasets/jimmycarter/textocr-gpt4v, 2024.',
      'B. Zhang and R. Sennrich. Root mean square layer normalization, 2019.',
    ]);
  });

  it('ranks "References" and an appendix lettered "A." as sections, where they are set as the numbered ones are', () => {
    const heading = (str, y, size = 13) => run(str, LEFT, y, { size, font: BOLD, width: str.length * 6 });
    const runs = [
      heading('Abstract', 80, 14.3),
      ...paragraph(100, 4, 'Abstract line'),
      heading('1. Introduction', 170),
      ...paragraph(190, 4, 'Introduction line'),
      heading('1.1. Motivation', 260, 11.5),
      ...paragraph(280, 4, 'Motivation line'),
      heading('References', 350),
      run('A. Author. A paper. 2020.', LEFT, 370, { width: 150 }),
      heading('A. Appendix', 400),
      ...paragraph(420, 4, 'Appendix line'),
    ];
    const headings = layoutPages([page(runs)]).blocks.filter((block) => block.kind === 'heading');
    assert.deepEqual(
      headings.map((block) => [text(block), block.level]),
      [
        ['Abstract', 2],
        ['1. Introduction', 2],
        ['1.1. Motivation', 3],
        ['References', 2],
        ['A. Appendix', 2],
      ],
    );
  });

  it('reads the first page\'s footnotes at the foot of the page, and the institution marked under the names, into the byline', () => {
    const name = (str, x, y, width, marks) => [run(str, x, y, { size: 10, width }), run(marks, x + width, y - 3.6, { size: 7.3, width: marks.length * 3 })];
    const runs = [
      run('DeepSeek-VL: Towards Real-World Vision-Language Understanding', 140, 150, { size: 14.3, font: BOLD, width: 320 }),
      ...name('Haoyu Lu', 180, 180, 42, '∗1†'),
      ...name('Wen Liu', 240, 180, 36, '∗1'),
      ...name('Bo Zhang', 300, 180, 42, '∗1‡'),
      ...name('Chong Ruan', 268, 195, 56, '1'),
      run('1', 266.4, 210.3, { size: 7.3, width: 3.6 }),
      run('DeepSeek-AI', 270.5, 214, { size: 10, width: 58 }),
      run('Abstract', 270, 260, { size: 14.3, font: BOLD, width: 50 }),
      ...paragraph(285, 8, 'Abstract line'),
      run('∗', 74.6, 783.5, { size: 7.3, font: 'txsys', width: 3.4 }),
      run('Equal contribution.', 80.8, 786.7, { size: 9, width: 77 }),
      run('†', 74.6, 794.4, { size: 7.3, font: 'txsys', width: 3.6 }),
      run('Work done during the internship at DeepSeek-AI.', 81, 797.7, { size: 9, width: 197 }),
      run('‡', 74.6, 806.4, { size: 7.3, font: 'txsys', width: 3.6 }),
      run('Project lead.', 81, 809.7, { size: 9, width: 48 }),
    ];
    const { byline } = layoutPages([page(runs)], { title: 'DeepSeek-VL: Towards Real-World Vision-Language Understanding' });
    assert.ok(byline, 'a byline');
    assert.deepEqual(byline.affiliations, [{ mark: '1', text: 'DeepSeek-AI' }]);
    assert.ok(byline.authors.every((author) => author.affiliations.join() === 'DeepSeek-AI'), JSON.stringify(byline.authors));
    assert.deepEqual(byline.notes.map((note) => [note.mark, note.text]), [
      ['∗', 'Equal contribution'],
      ['†', 'Work done during the internship at DeepSeek-AI'],
      ['‡', 'Project lead'],
    ]);
    assert.deepEqual(byline.authors.find((author) => author.name === 'Bo Zhang').notes, ['Equal contribution', 'Project lead']);
  });
});
