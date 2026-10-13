// Two sequences compared, as Git compares lines: what is the same, what was
// removed from the first, what was added in the second. Myers' O((N+M)D)
// algorithm, after the common start and end are set aside, so two near-copies
// of a long file cost little. Words for the PDF compare (pdfDiff.ts), lines for
// a file's.
/** The parts of `a` and `b`, in order: same, removed (only in a), added (only in b). */
export function diffSequences(a, b, equal = (x, y) => x === y) {
    let start = 0;
    while (start < a.length && start < b.length && equal(a[start], b[start]))
        start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && equal(a[endA - 1], b[endB - 1]))
        (endA -= 1), (endB -= 1);
    const parts = [];
    const push = (kind, item) => {
        const last = parts[parts.length - 1];
        if (last?.kind === kind)
            last.items.push(item);
        else
            parts.push({ kind, items: [item] });
    };
    for (let i = 0; i < start; i += 1)
        push('same', a[i]);
    for (const [kind, item] of middle(a.slice(start, endA), b.slice(start, endB), equal))
        push(kind, item);
    for (let i = endA; i < a.length; i += 1)
        push('same', a[i]);
    return parts;
}
/** Myers' shortest edit script between the two, as a list of steps. */
function middle(a, b, equal) {
    const n = a.length;
    const m = b.length;
    if (!n)
        return b.map((item) => ['added', item]);
    if (!m)
        return a.map((item) => ['removed', item]);
    const max = n + m;
    const offset = max;
    let v = new Int32Array(2 * max + 2);
    const trace = [];
    outer: for (let d = 0; d <= max; d += 1) {
        // Each step keeps a copy of the frontier: past ~64 MB of them, the two are too unlike to be worth it.
        if ((d + 1) * v.length > 16_000_000)
            return [...a.map((item) => ['removed', item]), ...b.map((item) => ['added', item])];
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && equal(a[x], b[y]))
                (x += 1), (y += 1);
            v[offset + k] = x;
            if (x >= n && y >= m) {
                trace.push(v.slice());
                break outer;
            }
        }
    }
    // Back through the trace, from the end: each step a diagonal run, then one removal or addition.
    const steps = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d -= 1) {
        v = trace[d];
        const k = x - y;
        const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
        const prevK = down ? k + 1 : k - 1;
        const prevX = v[offset + prevK];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY)
            (x -= 1), (y -= 1), steps.push(['same', a[x]]);
        if (d > 0) {
            if (down)
                (y -= 1), steps.push(['added', b[y]]);
            else
                (x -= 1), steps.push(['removed', a[x]]);
        }
    }
    while (x > 0 && y > 0)
        (x -= 1), (y -= 1), steps.push(['same', a[x]]);
    return steps.reverse();
}
export function diffLines(a, b) {
    const rows = [];
    let ia = 0;
    let ib = 0;
    for (const part of diffSequences(a.split('\n'), b.split('\n'))) {
        for (const text of part.items) {
            if (part.kind === 'same')
                rows.push({ kind: 'same', a: ++ia, b: ++ib, text });
            else if (part.kind === 'removed')
                rows.push({ kind: 'removed', a: ++ia, text });
            else
                rows.push({ kind: 'added', b: ++ib, text });
        }
    }
    return rows;
}
export function hunksOf(rows) {
    const hunks = [];
    for (let i = 0; i < rows.length; i += 1) {
        if (rows[i].kind === 'same')
            continue;
        const hunk = { from: i, to: i, mine: [], theirs: [] };
        while (i < rows.length && rows[i].kind !== 'same') {
            (rows[i].kind === 'removed' ? hunk.mine : hunk.theirs).push(rows[i].text);
            hunk.to = i;
            i += 1;
        }
        hunks.push(hunk);
    }
    return hunks;
}
/** The file as picked: the lines both have, and for each change the side picked (A's when none is). */
export function mergeLines(rows, picks) {
    const out = [];
    const hunks = hunksOf(rows);
    let at = 0;
    hunks.forEach((hunk, n) => {
        for (; at < hunk.from; at += 1)
            out.push(rows[at].text);
        const pick = picks[n] ?? 'mine';
        if (pick !== 'theirs')
            out.push(...hunk.mine);
        if (pick !== 'mine')
            out.push(...hunk.theirs);
        at = hunk.to + 1;
    });
    for (; at < rows.length; at += 1)
        out.push(rows[at].text);
    return out.join('\n');
}
