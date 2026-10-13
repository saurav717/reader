// The templates that come with Reader: conference and publisher kits, kept
// beside the app in public/latex-templates/<slug>/ so "Browse templates" is
// never empty. The kits with style files of their own (ICLR, ACL, CVPR) are
// copied as their organisers give them out on GitHub; the others are a short
// paper on a class all of TeX Live has (IEEEtran, acmart, llncs, elsarticle).
// NeurIPS and ICML hand theirs out only from their own sites, each year:
// upload that .zip and it is kept as a template too.

import type { PaperStore } from './paperStore';

export interface GalleryTemplate {
  slug: string;
  name: string;
  /** What it is for, in a few words. */
  note: string;
  /** Its main document, among its files. */
  main: string;
  files: string[];
  /** Where it comes from, to check for a newer one. */
  source: string;
}

export const GALLERY_PREFIX = 'reader:';

export const LATEX_GALLERY: GalleryTemplate[] = [
  {
    slug: 'iclr-2027',
    name: 'ICLR 2027',
    note: 'International Conference on Learning Representations',
    main: 'iclr2027_conference.tex',
    files: ['iclr2027_conference.tex', 'iclr2027_conference.sty', 'iclr2027_conference.bst', 'iclr2027_conference.bib', 'math_commands.tex', 'natbib.sty', 'fancyhdr.sty'],
    source: 'https://github.com/ICLR/Master-Template',
  },
  {
    slug: 'cvpr-2026',
    name: 'CVPR / ICCV 2026',
    note: 'Computer Vision and Pattern Recognition; ICCV and 3DV use it too',
    main: 'main.tex',
    files: ['main.tex', 'preamble.tex', 'cvpr.sty', 'ieeenat_fullname.bst', 'main.bib', 'fig/teaser.tex', 'sec/0_abstract.tex', 'sec/1_intro.tex', 'sec/2_formatting.tex', 'sec/3_finalcopy.tex', 'sec/X_suppl.tex'],
    source: 'https://github.com/cvpr-org/author-kit',
  },
  {
    slug: 'acl',
    name: 'ACL (*ACL conferences)',
    note: 'ACL, EMNLP, NAACL, EACL and the ACL Rolling Review',
    main: 'acl_latex.tex',
    files: ['acl_latex.tex', 'acl.sty', 'acl_natbib.bst', 'custom.bib'],
    source: 'https://github.com/acl-org/acl-style-files',
  },
  {
    slug: 'ieee-conference',
    name: 'IEEE conference',
    note: 'IEEEtran, two columns: ICRA, IROS, ICASSP, INFOCOM…',
    main: 'main.tex',
    files: ['main.tex', 'references.bib'],
    source: 'https://ctan.org/pkg/ieeetran',
  },
  {
    slug: 'acm-sigconf',
    name: 'ACM conference (sigconf)',
    note: 'acmart: CHI, KDD, SIGGRAPH, WWW, CCS…',
    main: 'main.tex',
    files: ['main.tex', 'references.bib'],
    source: 'https://ctan.org/pkg/acmart',
  },
  {
    slug: 'springer-lncs',
    name: 'Springer LNCS',
    note: 'Lecture Notes in Computer Science: ECCV, MICCAI and many workshops',
    main: 'main.tex',
    files: ['main.tex', 'references.bib'],
    source: 'https://ctan.org/pkg/llncs',
  },
  {
    slug: 'elsevier',
    name: 'Elsevier journal',
    note: 'elsarticle: Pattern Recognition, Neural Networks, Artificial Intelligence…',
    main: 'main.tex',
    files: ['main.tex', 'references.bib'],
    source: 'https://ctan.org/pkg/elsarticle',
  },
];

/** The one a slug names, if it is one of these. */
export const galleryTemplate = (slug: string) => (slug.startsWith(GALLERY_PREFIX) ? LATEX_GALLERY.find((one) => GALLERY_PREFIX + one.slug === slug) : undefined);

const base64Of = (bytes: Uint8Array) => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** Its files, fetched from beside the app and written into the paper under `dir`; the main document's path back. */
export async function applyGallery(store: PaperStore, template: GalleryTemplate, dir: string, base = `${import.meta.env?.BASE_URL ?? '/'}latex-templates/`): Promise<string> {
  const within = (path: string) => (dir ? `${dir}/${path}` : path);
  for (const file of template.files) {
    const response = await fetch(`${base}${template.slug}/${file}`);
    if (!response.ok) throw new Error(`Couldn’t fetch ${template.name}’s ${file} (${response.status}).`);
    await store.writeBase64(within(file), base64Of(new Uint8Array(await response.arrayBuffer())));
  }
  return within(template.main);
}
