import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// A LaTeX project in Drive compared with its Overleaf project, as GitHub
// compares two branches: on the left every file, changed, the same, or on one
// side only; on the right the chosen file's lines side by side with their
// changes, or the two PDFs with what changed on each page. Each file ends up
// as picked — this site's version in total, Overleaf's in total, or change by
// change — and that is then the version in both places: written into Drive,
// and pushed to Overleaf on top of the commit compared with.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { apiFetch } from '../lib/api';
import { isTextFile, latexLinkAt, latexOwner, latexSeparate, overleafGitUrl, withLatexLink } from '../lib/overleaf';
import { compareWithOverleaf, settleWithOverleaf } from '../lib/overleafCloud';
import { subStore } from '../lib/paperStore';
import { diffPdfs } from '../lib/pdfDiff';
import { diffLines, hunksOf, mergeLines } from '../lib/textDiff';
import OverleafAccounts from './OverleafAccounts';
const decode = (base64) => (base64 === undefined ? '' : new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))));
const encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(binary);
};
const isText = (path) => isTextFile(path) || /\.(txt|md|csv|json|tsv)$/i.test(path);
/** Files on one side only start kept (nothing anybody wrote is lost by default); changed ones wait to be picked, as a conflict does. */
const firstDecision = (file) => (file.status === 'here' ? { whole: 'mine' } : file.status === 'overleaf' ? { whole: 'theirs' } : undefined);
/** The file as it is to end up: base64, or null for gone. */
function finalOf(file, decision, rows) {
    if ('whole' in decision)
        return (decision.whole === 'mine' ? file.mine : file.theirs) ?? null;
    return encode(mergeLines(rows ?? diffLines(decode(file.mine), decode(file.theirs)), decision.hunks));
}
const SIDE = { mine: 'This site', theirs: 'Overleaf' };
export default function CompareOverleaf({ project, store, dir, onClose }) {
    const { updateCollection } = useStore();
    const link = project.project.overleaf;
    // What syncs as one with that Overleaf project: the folder whose link it is, less the other LaTeX projects in it.
    const owner = latexOwner(link, dir);
    const own = useMemo(() => subStore(store, owner), [store, owner]);
    const exclude = useMemo(() => latexSeparate(link, owner), [link, owner]);
    const target = latexLinkAt(link, owner);
    const gitUrl = overleafGitUrl(target.url);
    const [comparison, setComparison] = useState(null);
    const [problem, setProblem] = useState(null);
    const [needToken, setNeedToken] = useState(false);
    const [decisions, setDecisions] = useState({});
    const [chosen, setChosen] = useState(null);
    const [view, setView] = useState('code');
    const [showSame, setShowSame] = useState(false);
    const [applying, setApplying] = useState(false);
    const [done, setDone] = useState(null);
    const [round, setRound] = useState(0);
    useEffect(() => {
        if (!gitUrl)
            return;
        let live = true;
        setComparison(null);
        setProblem(null);
        setNeedToken(false);
        void compareWithOverleaf(own, gitUrl, { account: target.gitAccount, exclude }).then((found) => {
            if (!live)
                return;
            setComparison(found);
            setDecisions(Object.fromEntries(found.files.flatMap((file) => (firstDecision(file) ? [[file.path, firstDecision(file)]] : []))));
            setChosen(found.files.find((file) => file.status !== 'same')?.path ?? found.files[0]?.path ?? null);
        }, (error) => {
            if (!live)
                return;
            setProblem(error instanceof Error ? error.message : String(error));
            setNeedToken(Boolean(error.needToken));
        });
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [own, gitUrl, round]);
    const differing = comparison?.files.filter((file) => file.status !== 'same') ?? [];
    const undecided = differing.filter((file) => !decisions[file.path]);
    const file = comparison?.files.find((item) => item.path === chosen) ?? null;
    const allTo = (side) => setDecisions(Object.fromEntries(differing.map((item) => [item.path, { whole: side }])));
    const apply = async () => {
        if (!comparison || !gitUrl || undecided.length)
            return;
        setApplying(true);
        setProblem(null);
        try {
            const finals = {};
            for (const item of differing)
                finals[item.path] = finalOf(item, decisions[item.path]);
            const synced = await settleWithOverleaf(own, gitUrl, comparison, finals, { account: target.gitAccount, exclude });
            if (synced.account && synced.account !== target.gitAccount)
                void updateCollection(project.id, (collection) => {
                    const info = { ...project.project, ...(collection.project ?? {}) };
                    return info.overleaf ? { project: { ...info, overleaf: withLatexLink(info.overleaf, owner, { gitAccount: synced.account }) } } : {};
                });
            if (!synced.ok)
                throw new Error(synced.error ?? 'Overleaf didn’t take the settled version.');
            setDone(`${differing.length} file${differing.length === 1 ? '' : 's'} settled: this site and Overleaf now have the same version${synced.pushed ? ', pushed to Overleaf' : ''}.`);
            setRound((n) => n + 1);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setApplying(false);
        }
    };
    const head = (_jsxs("header", { className: "wc-head", children: [_jsx("button", { type: "button", className: "wr-home-back wc-back", onClick: onClose, children: "\u2190 Back to the LaTeX projects" }), _jsxs("div", { className: "wc-title", children: [_jsx("span", { className: "eyebrow", children: "Compare with Overleaf" }), _jsx("h2", { children: owner ? `${owner}/` : 'The top of the folder' })] }), comparison ? (_jsxs("div", { className: "wc-actions", children: [_jsx("span", { className: "wr-quiet", children: differing.length ? `${differing.length} file${differing.length === 1 ? '' : 's'} differ${differing.length === 1 ? 's' : ''}${undecided.length ? ` · ${undecided.length} to pick` : ''}` : 'Nothing differs' }), differing.length ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "btn sm", onClick: () => allTo('mine'), title: "Every file as it is on this site: Overleaf gets this site\u2019s version", children: "Keep all of this site\u2019s" }), _jsx("button", { type: "button", className: "btn sm", onClick: () => allTo('theirs'), title: "Every file as it is on Overleaf: this site gets Overleaf\u2019s version", children: "Take all of Overleaf\u2019s" }), _jsx("button", { type: "button", className: "btn sm primary", disabled: applying || Boolean(undecided.length), onClick: () => void apply(), title: undecided.length ? 'Pick a version for every changed file first' : 'Write the picked versions here and push them to Overleaf', children: applying ? 'Settling…' : 'Apply to both' })] })) : null] })) : null] }));
    if (!gitUrl)
        return (_jsxs("div", { className: "wc", children: [head, _jsx("p", { className: "wr-quiet wc-pad", children: "This LaTeX project isn\u2019t on Overleaf, so there is nothing to compare it with." })] }));
    return (_jsxs("div", { className: "wc", children: [head, done ? _jsx("p", { className: "wc-done wc-pad", children: done }) : null, problem ? (_jsxs("div", { className: "wc-pad", children: [_jsx("p", { className: "wr-bad", children: problem }), needToken ? _jsx(OverleafAccounts, { open: true, projectUrl: target.url, onConnected: () => setRound((n) => n + 1) }) : null] })) : null, !comparison && !problem ? _jsx("p", { className: "wr-quiet wc-pad", children: "Asking Overleaf for its files, and reading this site\u2019s\u2026" }) : null, comparison ? (_jsxs("div", { className: "wc-body", children: [_jsxs("aside", { className: "wc-files", "aria-label": "The files, compared", children: [['changed', 'here', 'overleaf'].map((status) => {
                                const list = comparison.files.filter((item) => item.status === status);
                                if (!list.length)
                                    return null;
                                return (_jsxs("section", { children: [_jsx("h4", { children: status === 'changed' ? 'Changed on both' : status === 'here' ? 'Only on this site' : 'Only on Overleaf' }), list.map((item) => (_jsx(FileRow, { file: item, decision: decisions[item.path], on: item.path === chosen, onClick: () => setChosen(item.path) }, item.path)))] }, status));
                            }), _jsxs("section", { children: [_jsxs("button", { type: "button", className: "wc-same-toggle", "aria-expanded": showSame, onClick: () => setShowSame(!showSame), children: [showSame ? '▾' : '▸', " The same on both \u00B7 ", comparison.files.filter((item) => item.status === 'same').length] }), showSame ? comparison.files.filter((item) => item.status === 'same').map((item) => _jsx(FileRow, { file: item, on: item.path === chosen, onClick: () => setChosen(item.path) }, item.path)) : null] })] }), _jsxs("main", { className: "wc-main", children: [_jsxs("div", { className: "wc-tabs", role: "tablist", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": view === 'code', className: view === 'code' ? 'is-on' : '', onClick: () => setView('code'), children: "Files" }), _jsx("button", { type: "button", role: "tab", "aria-selected": view === 'pdf', className: view === 'pdf' ? 'is-on' : '', onClick: () => setView('pdf'), children: "PDFs" })] }), view === 'code' ? (file ? (_jsx(FileCompare, { file: file, decision: decisions[file.path], onDecide: (decision) => setDecisions((now) => ({ ...now, [file.path]: decision })) }, file.path)) : (_jsx("p", { className: "wr-quiet wc-pad", children: "No files." }))) : (_jsx(PdfCompare, { comparison: comparison, decisions: decisions, main: target.main || 'main.tex', compiler: target.compiler ?? 'pdflatex' }))] })] })) : null] }));
}
function FileRow({ file, decision, on, onClick }) {
    const said = !decision ? 'pick' : 'hunks' in decision ? 'picked across' : file.status === 'changed' ? SIDE[decision.whole] : file.status === 'here' ? (decision.whole === 'mine' ? 'kept' : 'deleted') : decision.whole === 'theirs' ? 'kept' : 'deleted';
    return (_jsxs("button", { type: "button", className: `wc-file is-${file.status}${on ? ' is-on' : ''}${file.status !== 'same' && !decision ? ' is-open' : ''}`, onClick: onClick, title: file.path, children: [_jsx("span", { className: "wc-file-mark", "aria-hidden": "true", children: file.status === 'changed' ? 'M' : file.status === 'here' ? 'S' : file.status === 'overleaf' ? 'O' : '=' }), _jsx("span", { className: "wc-file-name mono", children: file.path }), file.status !== 'same' ? _jsx("small", { className: `wc-file-pick${decision ? '' : ' is-open'}`, children: said }) : null] }));
}
const CONTEXT = 3;
/** One file's two versions: side by side, line by line, each change kept from one side or the other, or both. */
function FileCompare({ file, decision, onDecide }) {
    const text = isText(file.path);
    const rows = useMemo(() => (text ? diffLines(decode(file.mine), decode(file.theirs)) : []), [file, text]);
    const hunks = useMemo(() => hunksOf(rows), [rows]);
    const [allLines, setAllLines] = useState(false);
    const picks = decision && 'hunks' in decision ? decision.hunks : hunks.map(() => (decision && 'whole' in decision ? decision.whole : 'mine'));
    const pickHunk = (n, pick) => onDecide({ hunks: hunks.map((_, at) => (at === n ? pick : picks[at])) });
    const whole = (side) => onDecide({ whole: side });
    const wholeIs = (side) => Boolean(decision && 'whole' in decision && decision.whole === side);
    const choices = file.status === 'same' ? (_jsx("p", { className: "wr-quiet", children: "The same on this site and on Overleaf." })) : file.status === 'changed' ? (_jsxs("div", { className: "wc-choose", children: [_jsx("button", { type: "button", className: `btn sm${wholeIs('mine') ? ' primary' : ''}`, onClick: () => whole('mine'), children: "Use this site\u2019s version" }), _jsx("button", { type: "button", className: `btn sm${wholeIs('theirs') ? ' primary' : ''}`, onClick: () => whole('theirs'), children: "Use Overleaf\u2019s version" }), text && hunks.length ? _jsx("span", { className: "wr-quiet", children: decision && 'hunks' in decision ? 'Picked change by change, below.' : 'Or pick change by change, below.' }) : null] })) : (_jsxs("div", { className: "wc-choose", children: [_jsx("button", { type: "button", className: `btn sm${wholeIs(file.status === 'here' ? 'mine' : 'theirs') ? ' primary' : ''}`, onClick: () => whole(file.status === 'here' ? 'mine' : 'theirs'), children: "Keep it on both" }), _jsxs("button", { type: "button", className: `btn sm${wholeIs(file.status === 'here' ? 'theirs' : 'mine') ? ' primary' : ''}`, onClick: () => whole(file.status === 'here' ? 'theirs' : 'mine'), children: ["Delete it from ", file.status === 'here' ? 'this site' : 'Overleaf'] })] }));
    if (!text)
        return (_jsxs("div", { className: "wc-file-view", children: [_jsxs("div", { className: "wc-file-head", children: [_jsx("b", { className: "mono", children: file.path }), choices] }), _jsxs("p", { className: "wr-quiet wc-pad", children: ["Not a text file: this site\u2019s is ", file.mine ? `${Math.round((file.mine.length * 3) / 4 / 1024)} KB` : 'not there', ", Overleaf\u2019s ", file.theirs ? `${Math.round((file.theirs.length * 3) / 4 / 1024)} KB` : 'not there', "."] })] }));
    // Each row shown, or folded into "n lines the same" away from the changes.
    const near = new Set();
    for (const hunk of hunks)
        for (let i = Math.max(0, hunk.from - CONTEXT); i <= Math.min(rows.length - 1, hunk.to + CONTEXT); i += 1)
            near.add(i);
    const body = [];
    let folded = 0;
    const fold = (key) => {
        if (!folded)
            return;
        body.push(_jsx("tr", { className: "wc-fold", children: _jsx("td", { colSpan: 4, children: _jsxs("button", { type: "button", className: "link-btn", onClick: () => setAllLines(true), children: ["\u22EF ", folded, " line", folded === 1 ? '' : 's', " the same"] }) }) }, key));
        folded = 0;
    };
    let hunkAt = 0;
    for (let i = 0; i < rows.length; i += 1) {
        const hunk = hunks[hunkAt];
        if (hunk && i === hunk.from) {
            fold(`f${i}`);
            const n = hunkAt;
            const pick = picks[n];
            body.push(_jsx("tr", { className: "wc-hunk-bar", children: _jsxs("td", { colSpan: 4, children: [_jsxs("span", { className: "wr-quiet", children: ["Change ", n + 1, " of ", hunks.length] }), ['mine', 'theirs', 'both'].map((side) => (_jsx("button", { type: "button", className: `wc-pick${file.status === 'changed' && pick === side && decision ? ' is-on' : ''}`, onClick: () => pickHunk(n, side), children: side === 'mine' ? 'Keep this site’s' : side === 'theirs' ? 'Take Overleaf’s' : 'Keep both' }, side)))] }) }, `h${n}`));
            // Side by side: this site's lines on the left, Overleaf's on the right, paired in order.
            const left = rows.slice(hunk.from, hunk.to + 1).filter((row) => row.kind === 'removed');
            const right = rows.slice(hunk.from, hunk.to + 1).filter((row) => row.kind === 'added');
            for (let k = 0; k < Math.max(left.length, right.length); k += 1) {
                const l = left[k];
                const r = right[k];
                // Struck through: the side a pick leaves out (nothing yet, before one is made).
                const keptL = !decision || pick !== 'theirs';
                const keptR = !decision || pick !== 'mine';
                body.push(_jsxs("tr", { className: "wc-row is-change", children: [_jsx("td", { className: "wc-num", children: l?.a ?? '' }), _jsx("td", { className: `wc-code${l ? ` is-mine${keptL ? '' : ' is-dropped'}` : ' is-blank'}`, children: l?.text ?? '' }), _jsx("td", { className: "wc-num", children: r?.b ?? '' }), _jsx("td", { className: `wc-code${r ? ` is-theirs${keptR ? '' : ' is-dropped'}` : ' is-blank'}`, children: r?.text ?? '' })] }, `h${n}-${k}`));
            }
            i = hunk.to;
            hunkAt += 1;
            continue;
        }
        if (!allLines && !near.has(i)) {
            folded += 1;
            continue;
        }
        const row = rows[i];
        body.push(_jsxs("tr", { className: "wc-row", children: [_jsx("td", { className: "wc-num", children: row.a }), _jsx("td", { className: "wc-code", children: row.text }), _jsx("td", { className: "wc-num", children: row.b }), _jsx("td", { className: "wc-code", children: row.text })] }, `s${i}`));
    }
    fold('end');
    return (_jsxs("div", { className: "wc-file-view", children: [_jsxs("div", { className: "wc-file-head", children: [_jsx("b", { className: "mono", children: file.path }), choices] }), _jsx("div", { className: "wc-table-wrap", children: _jsxs("table", { className: "wc-table", children: [_jsxs("colgroup", { children: [_jsx("col", { className: "wc-col-num" }), _jsx("col", {}), _jsx("col", { className: "wc-col-num" }), _jsx("col", {})] }), _jsx("thead", { children: _jsxs("tr", { children: [_jsxs("th", { colSpan: 2, children: ["This site", file.mine === undefined ? ' · not there' : ''] }), _jsxs("th", { colSpan: 2, children: ["Overleaf", file.theirs === undefined ? ' · not there' : ''] })] }) }), _jsx("tbody", { children: body })] }) })] }));
}
const VERSION_LABEL = { mine: 'This site', theirs: 'Overleaf', result: 'The result, as picked' };
/** A version's files, compiled on Cloud Run as one paper: its PDF. */
async function compileVersion(files, main, compiler) {
    const response = await apiFetch('/latex/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: 'cloudrun', files, main, compiler }) });
    const answer = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(answer.error ?? `The compiler answered ${response.status}.`);
    if (!answer.pdf)
        throw new Error(`It didn’t compile: ${(answer.log ?? '').split('\n').filter((line) => line.startsWith('!')).slice(0, 2).join(' ') || 'no PDF came out'}.`);
    return new Blob([Uint8Array.from(atob(answer.pdf), (char) => char.charCodeAt(0))], { type: 'application/pdf' });
}
function filesOf(comparison, version, decisions) {
    const out = [];
    for (const file of comparison.files) {
        const base64 = version === 'mine' ? file.mine : version === 'theirs' ? file.theirs : file.status === 'same' ? file.mine : decisions[file.path] ? finalOf(file, decisions[file.path]) : file.mine;
        if (base64)
            out.push({ path: file.path, base64 });
    }
    return out;
}
/** The two versions compiled and their PDFs compared page by page: removed on the left, added on the right. */
function PdfCompare({ comparison, decisions, main, compiler }) {
    const [left, setLeft] = useState('mine');
    const [right, setRight] = useState('theirs');
    const [busy, setBusy] = useState(null);
    const [problem, setProblem] = useState(null);
    const [diff, setDiff] = useState(null);
    const [onlyChanged, setOnlyChanged] = useState(true);
    const run = async () => {
        setProblem(null);
        setDiff(null);
        try {
            setBusy(`Compiling ${VERSION_LABEL[left].toLowerCase()}’s and ${VERSION_LABEL[right].toLowerCase()}’s on Cloud Run…`);
            const [a, b] = await Promise.all([compileVersion(filesOf(comparison, left, decisions), main, compiler), compileVersion(filesOf(comparison, right, decisions), main, compiler)]);
            setBusy('Comparing the pages…');
            setDiff(await diffPdfs(a, b));
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(null);
        }
    };
    const pages = diff ? diff.pages.map((page, n) => ({ page, n: n + 1 })).filter(({ page }) => !onlyChanged || page.changed) : [];
    return (_jsxs("div", { className: "wc-pdf", children: [_jsxs("div", { className: "wc-pdf-bar", children: [_jsxs("label", { children: [_jsx("span", { className: "wr-quiet", children: "Left" }), _jsx("select", { value: left, onChange: (event) => setLeft(event.target.value), children: Object.keys(VERSION_LABEL).map((version) => (_jsx("option", { value: version, children: VERSION_LABEL[version] }, version))) })] }), _jsxs("label", { children: [_jsx("span", { className: "wr-quiet", children: "Right" }), _jsx("select", { value: right, onChange: (event) => setRight(event.target.value), children: Object.keys(VERSION_LABEL).map((version) => (_jsx("option", { value: version, children: VERSION_LABEL[version] }, version))) })] }), _jsx("button", { type: "button", className: "btn sm primary", disabled: Boolean(busy) || left === right, onClick: () => void run(), children: diff ? 'Compare again' : 'Compile both and compare' }), diff ? (_jsxs("label", { className: "wc-pdf-only", children: [_jsx("input", { type: "checkbox", checked: onlyChanged, onChange: (event) => setOnlyChanged(event.target.checked) }), " Only pages that changed"] })) : null] }), _jsxs("p", { className: "wr-quiet wc-pad", children: ["Both are compiled from ", main, " with ", compiler, ". Red: only in the left one; green: only in the right one. The PDF compare is saurav717/diff-checker\u2019s: by words where the text can be read, by pixels where it can\u2019t."] }), busy ? _jsx("p", { className: "wr-quiet wc-pad", children: busy }) : null, problem ? _jsx("p", { className: "wr-bad wc-pad", children: problem }) : null, diff ? (_jsxs(_Fragment, { children: [_jsxs("p", { className: "wc-pad", children: [diff.stats.add + diff.stats.del ? `${diff.stats.del} removed · ${diff.stats.add} added, across ${diff.pages.filter((page) => page.changed).length} of ${diff.pages.length} pages` : `The PDFs look the same, all ${diff.pages.length} pages.`, diff.usedPixel ? ' · some pages compared by pixels, their text not readable' : ''] }), _jsxs("div", { className: "wc-pdf-pages", children: [_jsxs("div", { className: "wc-pdf-row wc-pdf-heads", children: [_jsx("b", { children: VERSION_LABEL[left] }), _jsx("span", {}), _jsx("b", { children: VERSION_LABEL[right] })] }), pages.map(({ page, n }) => (_jsxs("div", { className: `wc-pdf-row${page.changed ? ' has-change' : ''}`, children: [_jsx(PdfSide, { side: page.a, kind: "del" }), _jsx("span", { className: "wc-pdf-num", children: n }), _jsx(PdfSide, { side: page.b, kind: "add" })] }, n)))] })] })) : null] }));
}
function PdfSide({ side, kind }) {
    if (!side)
        return _jsx("div", { className: "wc-pdf-page is-empty", children: "no page here" });
    return (_jsxs("div", { className: "wc-pdf-page", style: { aspectRatio: `${side.vw} / ${side.vh}` }, children: [_jsx("img", { src: side.url, alt: "", loading: "lazy" }), side.boxes.map((box, n) => {
                const pad = Math.max(box.h * 0.04, 1);
                return (_jsx("i", { className: `wc-hl is-${kind}${box.whole ? ' is-whole' : ''}`, style: box.whole ? undefined : { left: `${((box.x - pad) / side.vw) * 100}%`, top: `${((box.y - pad) / side.vh) * 100}%`, width: `${((box.w + pad * 2) / side.vw) * 100}%`, height: `${((box.h + pad * 2) / side.vh) * 100}%` } }, n));
            })] }));
}
