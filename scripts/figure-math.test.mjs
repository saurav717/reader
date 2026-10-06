// Maths in a figure's labels, set inside the SVG: LaTeX between dollars, and
// the plain-text notation models fall back to (`z_hat_{t+1}`, `e_phi`),
// without touching labels that are only words.
//
//   node --test scripts/figure-math.test.mjs

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, load } from './bundle.mjs';

const math = await load('src/lib/figureMath.ts');
after(cleanup);

/** Pieces as a short string: `_` a subscript, `^` a superscript, `*` italic. */
const read = (label) => math.labelPieces(label).map((p) => `${p.level === -1 ? '_' : p.level === 1 ? '^' : ''}${p.italic ? '*' : ''}[${p.text}]`).join('').normalize('NFC');

describe('LaTeX between dollars', () => {
  it('sets accents, Greek, subscripts and operators', () => {
    assert.equal(read('$\\hat{z}_{t+1} = f_\\theta(z_t)$'), '*[ẑ]_*[t]_[+1][ = ]*[f]_[θ][(]*[z]_*[t][)]');
  });
  it('sets norms, powers, calligraphic letters and upright text', () => {
    assert.equal(read('$\\mathcal{L}_{\\text{pred}} = \\|a - b\\|^2$'), '[ℒ]_[pred][ = ‖]*[a][\u2009−\u2009]*[b][‖]^[2]');
  });
  it('writes a fraction and a root on one line', () => {
    assert.equal(read('$\\frac{1}{\\sqrt{d}}$'), '[1/√]*[d]');
  });
  it('shows a command it does not know by name rather than dropping it', () => {
    assert.equal(read('$\\foo x$'), '[foo]*[x]');
  });
});

describe('maths written as plain text', () => {
  it('reads the labels models write without LaTeX', () => {
    assert.equal(read('z_hat_{t+1} = z_t + Delta z_hat'), '*[ẑ]_*[t]_[+1][ = ]*[z]_*[t][ + Δ]*[ẑ]');
    assert.equal(read('encoder e_phi'), '[encoder ]*[e]_[φ]');
    assert.equal(read('N(mu_eta, I)'), '[N(μ]_[η][, I)]');
    assert.equal(read('score ||z - z_g||^2'), '[score ‖z − ]*[z]_*[g][‖]^[2]');
    assert.equal(read('Rbar_k'), '*[R̄]_*[k]');
    assert.equal(read('a -> b'), '[a → b]');
  });
  it('leaves words, and names with underscores, as they are', () => {
    assert.equal(read('sample N candidate action sequences'), '[sample N candidate action sequences]');
    assert.equal(read('train_step(batch) and file_name'), '[train_step(batch) and file_name]');
    assert.equal(read('beta version'), '[beta version]');
  });
});

describe('into the SVG', () => {
  it('sets subscripts with tspans, and comes back to the line before what follows', () => {
    const svg = math.typesetFigureMath('<svg viewBox="0 0 10 10"><text x="5"><tspan x="5">L_pred</tspan><tspan x="5" dy="1.2em">next</tspan></text></svg>');
    assert.equal(
      svg,
      '<svg viewBox="0 0 10 10"><text x="5"><tspan x="5"><tspan font-style="italic">L</tspan><tspan dy="0.314em" font-size="0.7em">pred</tspan><tspan dy="-0.22em">​</tspan></tspan><tspan x="5" dy="1.2em">next</tspan></text></svg>',
    );
  });
  it('touches only text, escapes what it writes, and leaves titles alone', () => {
    const svg = math.typesetFigureMath('<svg><rect x="1"></rect><text>a &lt; b &amp; x_t<title>x_t</title></text></svg>');
    assert.match(svg, /^<svg><rect x="1"><\/rect><text>a &lt; b &amp; <tspan font-style="italic">x<\/tspan>/);
    assert.match(svg, /<title>x_t<\/title><\/text><\/svg>$/);
  });
  it('passes a figure with no maths through unchanged', () => {
    const plain = '<svg viewBox="0 0 10 10"><text x="1" class="t-muted">encoder</text></svg>';
    assert.equal(math.typesetFigureMath(plain), plain);
  });
});
