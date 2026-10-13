/**
 * The wallpapers, calmest first: the order is how little each pulls the eye
 * from the page — measured as the colourfulness of what is round the page
 * (Hasler & Süsstrunk's metric) over a reading screen in both themes.
 */
export const GLASS_WALLS = [
    { id: 'spotlight', label: 'Spotlight', note: 'Warm paper, the edges dimmed and the page lit. The calmest to read in.' },
    { id: 'sage', label: 'Sage', note: 'The accent green, washed out. Calm, with a little colour.' },
    { id: 'paper', label: 'Paper', note: 'Cream and tan, like a desk under a book.' },
    { id: 'mist', label: 'Mist', note: 'Cool blue-grey, barely any colour.' },
    { id: 'graphite', label: 'Graphite', note: 'Neutral grey, no hue at all. Calmest in light, but flat.' },
    { id: 'lavender', label: 'Lavender', note: 'Soft violet and rose.' },
    { id: 'dusk', label: 'Dusk', note: 'Peach and amber, like evening light.' },
    { id: 'ocean', label: 'Ocean', note: 'Blue and teal, the most saturated.' },
    { id: 'spectrum', label: 'Spectrum', note: 'The accent and the four highlight colours. The liveliest, and the busiest.' },
];
export const NAV_STYLES = [
    { id: 'labelled', label: 'Labelled', note: 'A rail of named pages. Library, Discover, Notes and Ask AI are switches at the top of the page.' },
    { id: 'zones', label: 'Two zones', note: 'One narrow rail: pages at the top, the panels in a tray at the bottom.' },
    { id: 'sidebar', label: 'Sidebar', note: 'A wide sidebar: pages by name with your projects under Projects, the panels as switches. Folds to a narrow rail.' },
    { id: 'edge', label: 'Edge tabs', note: 'A rail of pages; the panels are tabs on the right edge of the page, pulled out like drawers.' },
    { id: 'classic', label: 'Classic', note: 'The one rail of icons as it was: pages and panels side by side.' },
];
export const PROJECT_NAVS = [
    { id: 'switcher', label: 'Switcher at the top', note: 'A tile under the R shows the project you are in, by name. Click it for the others.' },
    { id: 'menu', label: 'Menu from Projects', note: 'One Projects item with a count; it opens a menu of every project by name.' },
    { id: 'current', label: 'Just the current one', note: 'Under Projects, only the project you are in, or were in last, with its name.' },
    { id: 'dots', label: 'Colour dots', note: 'A row of small dots under Projects, one a project; hover one for its name.' },
    { id: 'folder', label: 'Opens like a folder', note: 'Projects opens a list of your projects by name right in the rail, and folds it again.' },
    { id: 'marks', label: 'Stacked marks', note: 'A lettered mark for each project, stacked under Projects.' },
];
export const COMPUTE_CONTROLS = [
    { id: 'everywhere', label: 'Everywhere', note: 'Settings → Compute, a switch on each place to run where a project’s code is set up, and a chip in the rail that lights while Colab runs.' },
    { id: 'settings', label: 'Only in Settings', note: 'Everything in Settings → Compute, and nothing anywhere else.' },
    { id: 'cards', label: 'Settings and the cards', note: 'Settings, and the switches where you choose where code runs. No chip in the rail.' },
    { id: 'rail', label: 'Settings and the rail', note: 'Settings, and the chip in the rail with what runs and Stop. No switches on the cards.' },
];
export const OVERLEAF_VIEWS = [
    { id: 'tab', label: 'Just the Write tab', note: 'The paper card’s Continue writing opens the Write tab where you left off: the files, the LaTeX and its PDF. Synced with Overleaf when you link one.' },
    { id: 'beside', label: 'Write tab + Overleaf beside', note: 'As the Write tab, and Open in Overleaf puts Overleaf in a window beside the reader, cite keys and BibTeX a click away.' },
    { id: 'write', label: 'Write tab + the workspace', note: 'As the Write tab, and the workspace gets a Write layout: the paper you read beside the .tex files (needs Overleaf’s GitHub sync).' },
    { id: 'dock', label: 'Write tab + the dock', note: 'As the Write tab, and a Draft tab beside Discover and Notes, next to whatever paper is open (needs Overleaf’s GitHub sync).' },
    { id: 'overview', label: 'Write tab + Overleaf in a tab', note: 'As the Write tab, and Open in Overleaf opens it in a new browser tab.' },
];
export const WRITE_DEFAULTS = { compile: 'pause', engine: 'auto', layout: 'side', sync: 'pause', citations: 'drawer', errors: 'continue', pdf: 'here' };
/** Each of the Write tab's choices, the default first. */
export const WRITE_OPTIONS = [
    {
        key: 'pdf',
        label: 'Compile on',
        choices: [
            { id: 'here', label: 'This computer', note: 'The Companion compiles it with the TeX installed here, and the PDF is beside the source.' },
            { id: 'github', label: 'GitHub Actions', note: 'Reader’s own compiler, not a sync: GitHub Actions compiles it with all of TeX Live and the PDF comes back here, in a minute or two. Nothing to install or set up; the files are never kept.' },
            { id: 'cloudrun', label: 'Cloud Run', note: 'Reader’s own compiler on Google Cloud Run, with all of TeX Live: the PDF comes back here in seconds once it is warm. Nothing to install or set up; the files are never kept.' },
            { id: 'overleaf', label: 'By Overleaf', note: 'Nothing to install: edits go to Overleaf a moment after you stop typing, and the PDF is in Overleaf’s window, beside.' },
        ],
    },
    {
        key: 'compile',
        label: 'Compile',
        choices: [
            { id: 'pause', label: 'As you type', note: 'A second after you stop typing, as Overleaf’s auto-compile does.' },
            { id: 'save', label: 'On save', note: 'When you press ⌘S.' },
            { id: 'manual', label: 'By hand', note: 'Only with Recompile.' },
        ],
    },
    {
        key: 'errors',
        label: 'On an error',
        choices: [
            { id: 'continue', label: 'Keep going', note: 'As Overleaf does: the PDF is made as far as TeX can, and the errors are listed.' },
            { id: 'halt', label: 'Stop at the first', note: 'Overleaf’s “Stop on first error”: no PDF until it is fixed.' },
        ],
    },
    {
        key: 'engine',
        label: 'TeX',
        choices: [
            { id: 'auto', label: 'Whichever is here', note: 'latexmk when TeX Live or MacTeX is installed, else Tectonic.' },
            { id: 'latexmk', label: 'latexmk', note: 'Your TeX installation, run as Overleaf runs it, with the project’s compiler and main document.' },
            { id: 'tectonic', label: 'Tectonic', note: 'One small program that fetches the packages a paper uses; the Companion can download it. Always XeLaTeX, so not quite Overleaf’s pdfLaTeX.' },
        ],
    },
    {
        key: 'layout',
        label: 'The PDF',
        choices: [
            { id: 'side', label: 'Beside the source', note: 'Source on the left, PDF on the right, as in Overleaf.' },
            { id: 'stacked', label: 'Under the source', note: 'For a tall, narrow window.' },
            { id: 'tabs', label: 'A tab of its own', note: 'Source or PDF, one at a time, full width.' },
        ],
    },
    {
        key: 'sync',
        label: 'Sync with Overleaf',
        choices: [
            { id: 'pause', label: 'As you type', note: 'A few seconds after you stop: Overleaf shows it, and what coauthors wrote comes in.' },
            { id: 'save', label: 'On save', note: 'When you press ⌘S.' },
            { id: 'manual', label: 'By hand', note: 'Only with Sync.' },
        ],
    },
    {
        key: 'citations',
        label: 'Citations',
        choices: [
            { id: 'drawer', label: 'A drawer of papers', note: 'The project’s papers on the left, under the files: click one to \\cite it, with its BibTeX added.' },
            { id: 'off', label: 'None', note: 'Just the files.' },
        ],
    },
];
export const HIGHLIGHT_COLORS = [
    { id: 'yellow', label: 'Key claim', swatch: '#F6E27A' },
    { id: 'green', label: 'Method or result I trust', swatch: '#A9D6B8' },
    { id: 'blue', label: 'Definition or notation', swatch: '#9CC2E6' },
    { id: 'pink', label: 'Doubt or disagreement', swatch: '#EBB2B8' },
];
export const COLLECTION_COLORS = ['#1F5E52', '#8A4B2A', '#3B4B8C', '#6B3F6E', '#0F6070', '#7A5C13'];
