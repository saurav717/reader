import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { captchaStatus, finishCaptcha, showCaptcha, waitForCaptcha } from '../lib/scholar';
/**
 * The offer to be shown the captcha, where Google Scholar answered with one.
 *
 * One button opens a real browser window — on the proxy's machine, which is
 * this one when the proxy is `npm start` — at the very page Scholar refused,
 * captcha and all. The person solves it there. Scholar sends the window on to
 * the results the moment it accepts the answer, the proxy notices and closes
 * the window, and the caller asks the same question again — this time
 * through the browser that solved it, which is what Scholar now trusts.
 *
 * Where the proxy cannot open a window — a Cloudflare Worker has no screen —
 * this says so instead, with what to run to get one.
 */
export default function CaptchaPrompt({ url, onSolved }) {
    const [status, setStatus] = useState(null);
    const [stage, setStage] = useState('idle');
    const [problem, setProblem] = useState(null);
    const waiting = useRef(null);
    useEffect(() => {
        let live = true;
        captchaStatus().then((answer) => {
            if (live)
                setStatus(answer);
        });
        return () => {
            live = false;
            waiting.current?.abort();
        };
    }, []);
    const show = async () => {
        setStage('opening');
        setProblem(null);
        try {
            await showCaptcha(url);
        }
        catch (error) {
            setStage('failed');
            setProblem(error instanceof Error ? error.message : String(error));
            return;
        }
        setStage('open');
        const controller = new AbortController();
        waiting.current = controller;
        try {
            await waitForCaptcha(controller.signal);
        }
        catch {
            return; // unmounted
        }
        waiting.current = null;
        setStage('idle');
        onSolved();
    };
    const done = async () => {
        await finishCaptcha();
        // The poll notices the window is closed on its next turn; this only
        // shortens the wait.
    };
    if (!status)
        return null;
    if (!status.available) {
        return (_jsxs("span", { className: "sign-in-note", children: [' ', "The proxy could show you the captcha to solve, but this one cannot open a browser window. ", status.reason] }));
    }
    if (stage === 'open') {
        return (_jsxs("span", { className: "sign-in-note", children: [' ', "A browser window has opened at Google Scholar. Solve the captcha there; the window closes on its own the moment Scholar accepts it, and the search runs again. If Scholar simply answers the browser with no captcha, the window closes by itself just the same.", ' ', _jsx("button", { type: "button", className: "link-btn", onClick: () => void done(), children: "I have solved it" })] }));
    }
    return (_jsxs("span", { className: "sign-in-note", children: [' ', _jsx("button", { type: "button", className: "link-btn", disabled: stage === 'opening', onClick: () => void show(), children: stage === 'opening' ? 'Opening a window…' : 'Show me the captcha' }), problem ? ` Could not open the window: ${problem}` : ''] }));
}
