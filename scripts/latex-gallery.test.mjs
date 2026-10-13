// The templates that come with Reader: every file each one lists is there,
// nothing in its folder is left out, its main document is a LaTeX document,
// and applying one writes its files into the paper under the folder given.
//
//   node --test scripts/latex-gallery.test.mjs

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { cleanup, load } from './bundle.mjs';

const gallery = await load('src/lib/latexGallery.ts');

after(cleanup);

const ROOT = 'public/latex-templates';
const walk = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])))).flat();

describe('the templates that come with Reader', () => {
  it('has a folder for each, and no folder left out', async () => {
    const folders = (await readdir(ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.deepEqual(gallery.LATEX_GALLERY.map((one) => one.slug).sort(), folders);
  });

  for (const template of gallery.LATEX_GALLERY)
    it(`lists exactly ${template.name}’s files, its main document among them`, async () => {
      const there = (await walk(join(ROOT, template.slug))).map((path) => relative(join(ROOT, template.slug), path)).sort();
      assert.deepEqual([...template.files].sort(), there);
      assert.ok(template.files.includes(template.main));
      assert.match(await readFile(join(ROOT, template.slug, template.main), 'utf8'), /^[^%\n]*\\documentclass/m);
    });

  it('is found by its slug, and only with the prefix', () => {
    assert.equal(gallery.galleryTemplate('reader:acl')?.name, 'ACL (*ACL conferences)');
    assert.equal(gallery.galleryTemplate('acl'), undefined);
    assert.equal(gallery.galleryTemplate('reader:nope'), undefined);
  });

  it('writes its files into the paper under the folder given', async () => {
    const written = new Map();
    const store = { writeBase64: async (path, base64) => void written.set(path, Buffer.from(base64, 'base64').toString()) };
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer });
    try {
      const template = gallery.galleryTemplate('reader:cvpr-2026');
      const main = await gallery.applyGallery(store, template, 'my-paper', '/base/latex-templates/');
      assert.equal(main, 'my-paper/main.tex');
      assert.equal(written.size, template.files.length);
      assert.equal(written.get('my-paper/sec/1_intro.tex'), '/base/latex-templates/cvpr-2026/sec/1_intro.tex');
    } finally {
      globalThis.fetch = real;
    }
  });
});
