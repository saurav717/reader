import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
// Settings → Updates: the two parts of Reader and how each one is updated.
// The website isn't installed anywhere: a new build reaches the Reader app and
// every tab on the next load, and a window left open is offered Reload when a
// newer one is published (src/lib/siteBuild.ts). The Reader Companion is the
// part installed on a computer, so it is updated there: each one this browser
// is paired with, its version, and Update when the site serves a newer one. The
// Companion installs it itself, refreshes the VS Code extension, and starts
// again (/companion/update in companion/reader_companion/extension.py).
import { useEffect, useState } from 'react';
import { COMPANION_VERSION, companionPort, findCompanion, findLocalCompanion, isNewer, normaliseCode, showCompanionCode, startCompanion, updateCompanion, waitForVersion } from '../lib/companion';
import { useServers } from '../lib/playground';
import { pairForAccount } from '../lib/devices';
import { SITE_BUILD, isNewerBuild, publishedBuild } from '../lib/siteBuild';
import { isCompanion } from './VsCodeExtension';
/** The first Companion that can update itself: an older one is updated once the way it was installed. */
const SELF_UPDATING = '0.5.0';
function CompanionRow({ server }) {
    const [row, setRow] = useState({ state: 'looking' });
    useEffect(() => {
        let live = true;
        void findCompanion(server.url, 3000).then((info) => {
            if (!live)
                return;
            if (!info)
                setRow({ state: 'offline' });
            else if (isNewer(SELF_UPDATING, info.version))
                setRow({ state: 'manual', version: info.version });
            else
                setRow({ state: isNewer(COMPANION_VERSION, info.version) ? 'old' : 'current', version: info.version });
        });
        return () => {
            live = false;
        };
    }, [server.url]);
    const start = async () => {
        setRow({ state: 'starting' });
        const info = await startCompanion(server.url);
        if (!info)
            return setRow({ state: 'unstarted' });
        setRow({ state: isNewer(COMPANION_VERSION, info.version) ? 'old' : 'current', version: info.version });
    };
    const update = async () => {
        if (!('version' in row))
            return;
        const from = row.version;
        setRow({ state: 'updating', version: from });
        try {
            const { version, updated } = await updateCompanion(server);
            if (!updated)
                return setRow({ state: 'current', version });
            setRow({ state: 'updating', version: from, to: version });
            const back = await waitForVersion(server.url, version);
            setRow(back ? { state: 'updated', version: back.version } : { state: 'failed', version: from, error: 'It installed the update but hasn’t answered since. Open the Reader app to start it.' });
        }
        catch (error) {
            setRow({ state: 'failed', version: from, error: error instanceof Error ? error.message : String(error) });
        }
    };
    return (_jsxs("div", { className: "companion-update", children: [_jsxs("div", { children: [_jsxs("b", { children: ["Companion on ", server.name] }), _jsx("small", { children: row.state === 'looking'
                            ? 'Looking…'
                            : row.state === 'offline'
                                ? 'Not running (shut down, or the computer is off). Start starts it, through the Reader app.'
                                : row.state === 'starting'
                                    ? 'Starting… your browser may ask whether to open Reader Companion.'
                                    : row.state === 'unstarted'
                                        ? 'It didn’t start from here. Open the Reader app on it, or run reader-companion start in a terminal there.'
                                        : row.state === 'manual'
                                            ? `Companion ${row.version}, from before it could update itself. Update it once the way you installed it (the Reader app's .dmg, or the line on the Playground's Connect this computer card); from then on, Update here does it.`
                                            : row.state === 'current'
                                                ? `Companion ${row.version}: up to date.`
                                                : row.state === 'old'
                                                    ? `Companion ${row.version}. ${COMPANION_VERSION} is out.`
                                                    : row.state === 'updating'
                                                        ? row.to
                                                            ? `Installed ${row.to}; starting it again…`
                                                            : `Updating from ${row.version}: downloading and installing, a minute at most…`
                                                        : row.state === 'updated'
                                                            ? `Updated to ${row.version}, and running.`
                                                            : `Companion ${row.version}. ${row.error}` })] }), row.state === 'old' || row.state === 'failed' ? (_jsx("button", { type: "button", className: "btn sm primary", onClick: () => void update(), children: row.state === 'failed' ? 'Try again' : 'Update' })) : (row.state === 'offline' || row.state === 'unstarted') && server.where === 'pc' && companionPort(server.url) !== null ? (_jsx("button", { type: "button", className: "btn sm", onClick: () => void start(), children: "Start" })) : row.state === 'updating' || row.state === 'starting' ? (_jsx("span", { className: "spinner" })) : null] }));
}
/**
 * No Companion paired in this browser (another browser, or the Reader app's
 * window, may be): the one running on this computer, if any, and its code to
 * pair it here — the Playground's Connect this computer, in short.
 */
function UnpairedRow() {
    const [found, setFound] = useState(undefined);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    useEffect(() => {
        let live = true;
        void findLocalCompanion().then((reached) => live && setFound(reached));
        return () => {
            live = false;
        };
    }, []);
    const ask = async () => {
        if (!found)
            return;
        const shown = await showCompanionCode(found.base);
        setNote(shown ? 'The code is in a window on this computer’s screen.' : 'This computer can’t show it in a window: run reader-companion pair in a terminal, or open the Reader app.');
    };
    const pair = async () => {
        if (!found)
            return;
        setBusy(true);
        setNote(null);
        try {
            await pairForAccount(code, found.base);
        }
        catch (error) {
            setNote(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx("div", { className: "companion-update companion-unpaired", children: _jsxs("div", { children: [_jsx("b", { children: found ? `Companion on ${found.info.name}` : 'Companion on this computer' }), _jsx("small", { children: found === undefined
                        ? 'Looking for the Reader Companion…'
                        : found
                            ? `Companion ${found.info.version} is running here, but this window isn’t paired with it yet. Pair it to update it, shut it down and start it from here.`
                            : 'No Reader Companion answers on this computer: it is off, or not installed. Open the Reader app to start it, or Playground → Connect this computer to install it.' }), found ? (_jsxs("span", { className: "companion-pair", children: [_jsx("button", { type: "button", className: "btn sm", onClick: () => void ask(), children: "Show the code on this computer" }), _jsx("input", { value: code, placeholder: "ABC-DEF", "aria-label": "The code it shows", onChange: (event) => setCode(event.target.value), onKeyDown: (event) => event.key === 'Enter' && normaliseCode(code).length === 7 && void pair() }), _jsx("button", { type: "button", className: "btn sm primary", disabled: busy || normaliseCode(code).length !== 7, onClick: () => void pair(), children: busy ? 'Pairing…' : 'Pair' })] })) : null, note ? _jsx("small", { children: note }) : null] }) }));
}
const when = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
/** The website: nothing to install, and Reload when a newer build is published than the one this window loaded. */
function WebsiteRow() {
    const [published, setPublished] = useState(undefined);
    useEffect(() => {
        let live = true;
        void publishedBuild().then((build) => live && setPublished(build));
        return () => {
            live = false;
        };
    }, []);
    const newer = published && isNewerBuild(published);
    const loaded = when(SITE_BUILD.time);
    return (_jsxs("div", { className: "companion-update", children: [_jsxs("div", { children: [_jsx("b", { children: "Website" }), _jsx("small", { children: newer
                            ? `A newer version was published ${when(published.time)}. Reload to use it; nothing to download.`
                            : `Up to date${loaded ? `: published ${loaded}` : ''} (${SITE_BUILD.commit}). It updates by itself — the Reader app and every tab load the newest one each time they open.` })] }), newer ? (_jsx("button", { type: "button", className: "btn sm primary", onClick: () => window.location.reload(), children: "Reload" })) : null] }));
}
/** The website, then every Companion this browser is paired with, or the one on this computer to pair with. */
export default function CompanionUpdates() {
    const companions = useServers().filter(isCompanion);
    return (_jsxs("section", { style: { marginBottom: 22 }, children: [_jsx("div", { className: "eyebrow", style: { marginBottom: 10 }, children: "Updates" }), _jsx(WebsiteRow, {}), companions.length ? companions.map((server) => _jsx(CompanionRow, { server: server }, server.id)) : _jsx(UnpairedRow, {}), _jsxs("p", { style: { fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }, children: ["Reader has two parts. The ", _jsx("b", { children: "website" }), " is what you see, here and in the Reader app; nothing of it is installed, so it is always the newest. The ", _jsx("b", { children: "Companion" }), " is the one part installed on your computer: the Jupyter server that runs your playgrounds. A website can\u2019t replace a program on your computer, so the Companion updates when you press Update: it installs the newest one from this site, refreshes the Reader extension in VS Code, and starts again; your files and settings stay as they are."] })] }));
}
