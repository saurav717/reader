import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { captchaSiteKey, hasProxy, setCaptchaAnswer } from '../lib/api';
import { prepare as prepareGoogle, SIGN_IN_REQUIRED } from '../lib/google';
import { CheckIcon, CloudCheckIcon, GoogleMark, HighlighterIcon, SearchIcon } from './icons';
export default function Welcome({ onDismiss, onOpenSettings }) {
    const { user, driveConnected, driveRemembered, connectDrive, settings, authError } = useStore();
    const configured = Boolean(settings.googleClientId);
    // A visit that has connected before is reconnecting, not being introduced.
    const returning = driveRemembered && !driveConnected;
    // On the site, signing in with Google is the one way in: no "Not now"
    // until there is someone signed in. See SIGN_IN_REQUIRED.
    const mustSignIn = SIGN_IN_REQUIRED && configured && !user;
    // The proxy's captcha, when it wants one (see TURNSTILE_SITE_KEY in
    // wrangler.toml): the sign-in button waits until it is solved.
    const [siteKey, setSiteKey] = useState(null);
    const [solved, setSolved] = useState(false);
    const signingIn = configured && !user;
    useEffect(() => {
        if (!signingIn)
            return;
        let live = true;
        void captchaSiteKey().then((key) => {
            if (live)
                setSiteKey(key);
        });
        return () => {
            live = false;
        };
    }, [signingIn]);
    const waitingOnCaptcha = signingIn && Boolean(siteKey) && !solved;
    // The script Google's popup needs, fetched while this page is being read
    // rather than inside the click — a popup opened after an awaited download
    // has lost the user gesture that allows it, and the browser blocks it.
    useEffect(() => {
        if (configured)
            prepareGoogle();
    }, [configured]);
    return (_jsx("div", { className: "main", style: { alignItems: 'center', justifyContent: 'center', padding: 24 }, children: _jsxs("div", { style: { maxWidth: 520, width: '100%' }, children: [_jsx("div", { className: "brand", style: { width: 44, height: 44, fontSize: 25, marginBottom: 18 }, children: "R" }), _jsx("h1", { style: { margin: '0 0 8px', fontFamily: 'var(--serif)', fontSize: 34, fontWeight: 600, letterSpacing: '-0.014em' }, children: returning ? 'Reconnect your Drive' : 'Read papers, keep what matters' }), _jsx("p", { style: { margin: '0 0 26px', fontSize: 14, lineHeight: 1.6, color: 'var(--ink-2)' }, children: returning
                        ? 'A sign-in lasts as long as the token Google gives it, about an hour, and this one has run out. One click reconnects, and Google will not ask again what you have already agreed to. Papers you add then go to your Drive as you collect them.'
                        : 'Search arXiv, OpenAlex and Semantic Scholar, collect what you want to read, and highlight it. Sign in with Google and your library lives in your own Drive — every paper, its highlights, and your collections — the same in any browser you sign in from.' }), _jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }, children: [_jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'flex-start' }, children: [_jsx(SearchIcon, { size: 18, style: { color: 'var(--accent)', marginTop: 2, flexShrink: 0 } }), _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.55 }, children: "One search across three sources, or paste an arXiv id." })] }), _jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'flex-start' }, children: [_jsx(HighlighterIcon, { size: 18, style: { color: 'var(--accent)', marginTop: 2, flexShrink: 0 } }), _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.55 }, children: "Four highlight colours with meanings, notes, and a Markdown export." })] }), _jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'flex-start' }, children: [_jsx(CloudCheckIcon, { size: 18, style: { color: 'var(--accent)', marginTop: 2, flexShrink: 0 } }), _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.55 }, children: "A folder per collection in your Drive, holding the PDF and a JSON sidecar of your annotations." })] })] }), authError ? (_jsx("p", { className: "banner error", style: { marginBottom: 14 }, children: authError })) : null, !configured ? (_jsxs("p", { className: "banner warn", style: { marginBottom: 14 }, children: ["Google sign-in needs an OAuth client ID first \u2014 it takes a minute in the Google Cloud Console.", ' ', _jsx("button", { type: "button", className: "btn ghost sm", onClick: onOpenSettings, style: { padding: 0, height: 'auto' }, children: "Add it in Settings" }), "."] })) : null, signingIn && siteKey ? _jsx(Captcha, { siteKey: siteKey, onSolved: setSolved }) : null, _jsxs("div", { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }, children: [!driveConnected ? (
                        // Identity and Drive are asked for together: signing in on its own
                        // saves nothing, and the point of this screen is the saving.
                        _jsxs("button", { type: "button", className: "btn primary", disabled: !configured || waitingOnCaptcha, title: waitingOnCaptcha ? 'Tick the box above first' : undefined, onClick: () => void connectDrive(), style: { height: 42, padding: '0 16px', fontSize: 14 }, children: [_jsx(GoogleMark, { size: 18 }), returning ? 'Reconnect Google Drive' : user ? 'Connect Google Drive' : 'Sign in with Google'] })) : (_jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--accent)' }, children: [_jsx(CheckIcon, { size: 16 }), " Drive connected", user ? ` as ${user.email}` : ''] })), mustSignIn ? null : (_jsx("button", { type: "button", className: "btn ghost", onClick: onDismiss, style: { height: 42, fontSize: 14 }, children: driveConnected ? 'Start reading' : 'Not now — keep everything in this browser' }))] }), configured && !driveConnected && !hasProxy() ? (_jsxs("p", { className: "banner warn", style: { marginTop: 14 }, children: ["No paper proxy is set, so a PDF cannot be fetched and Drive would receive each paper's details without its file.", ' ', _jsx("button", { type: "button", className: "btn ghost sm", onClick: onOpenSettings, style: { padding: 0, height: 'auto' }, children: "Set one in Settings" }), "."] })) : null, _jsxs("p", { style: { margin: '20px 0 0', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }, children: ["One consent covers both: your name and address, and the ", _jsx("code", { children: "drive.file" }), " scope \u2014 which reaches only the files this app creates, never the rest of your Drive.", ' ', mustSignIn
                            ? 'Signing in with Google is the way in.'
                            : "Without signing in the app works the same, with a library in this browser that belongs to no account; signing in opens your own, from your Drive.", ' ', "Nothing is ever sent anywhere else."] })] }) }));
}
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let turnstileLoading = null;
function loadTurnstile() {
    if (window.turnstile)
        return Promise.resolve();
    turnstileLoading ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
            turnstileLoading = null;
            reject(new Error('The captcha could not load.'));
        };
        document.head.appendChild(script);
    });
    return turnstileLoading;
}
/**
 * Cloudflare Turnstile's box — the check that whoever signs in is a person.
 * Its answer goes to the proxy with the sign-in (setCaptchaAnswer) and is
 * checked there; this only draws it and says when it has an answer.
 */
export function Captcha({ siteKey, onSolved }) {
    const box = useRef(null);
    const [problem, setProblem] = useState(null);
    useEffect(() => {
        let widget = null;
        let live = true;
        const answered = (answer) => {
            setCaptchaAnswer(answer);
            onSolved(Boolean(answer));
        };
        // A fresh box is an unticked one, whatever an earlier box said.
        onSolved(false);
        loadTurnstile()
            .then(() => {
            if (!live || !box.current || !window.turnstile)
                return;
            widget = window.turnstile.render(box.current, {
                sitekey: siteKey,
                theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
                callback: (answer) => answered(answer),
                'expired-callback': () => answered(null),
                'error-callback': () => answered(null),
            });
        })
            .catch((error) => {
            if (live)
                setProblem(error.message);
        });
        // The answer outlives the box: the box goes the moment the sign-in lands,
        // and the answer is what that sign-in then hands the proxy.
        return () => {
            live = false;
            if (widget && window.turnstile)
                window.turnstile.remove(widget);
        };
    }, [siteKey, onSolved]);
    return (_jsxs("div", { style: { marginBottom: 14 }, children: [_jsx("div", { ref: box }), problem ? _jsxs("p", { className: "banner error", children: [problem, " Reload the page to try again."] }) : null] }));
}
