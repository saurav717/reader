import { jsxs as _jsxs, Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
import { useId, useRef, useState } from 'react';
import { pdfFromFile } from '../lib/pdf';
/**
 * The way through a login wall that needs no proxy at all: you.
 *
 * A browser will not let the page fetch a publisher's PDF, signed in or not —
 * but it will let the page read a file you hand it. So where the proxy cannot
 * get the paper, this says: open it at the publisher in a tab of your own,
 * where your institution's sign-in already holds, download the PDF, and drop
 * it here. The bytes then go to Drive and open like any other copy.
 */
export default function PdfDropIn({ host, url, onFile }) {
    const input = useRef(null);
    const inputId = useId();
    const [over, setOver] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState(null);
    const take = async (file) => {
        if (!file || busy)
            return;
        setProblem(null);
        setBusy(true);
        try {
            const blob = await pdfFromFile(file);
            await onFile(blob, file);
        }
        catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
            if (input.current)
                input.current.value = '';
        }
    };
    const drop = (event) => {
        event.preventDefault();
        setOver(false);
        void take(event.dataTransfer.files?.[0]);
    };
    return (_jsxs("span", { className: `drop-in${over ? ' over' : ''}`, onDragOver: (event) => {
            event.preventDefault();
            setOver(true);
        }, onDragLeave: () => setOver(false), onDrop: drop, children: [' ', "Or hand it over yourself:", ' ', url && host ? (_jsxs(_Fragment, { children: [_jsxs("a", { href: url, target: "_blank", rel: "noreferrer noopener", children: ["open it at ", host] }), ' ', "in a tab of your own \u2014 where your institution\u2019s sign-in already holds \u2014 download the PDF, and"] })) : (_jsx(_Fragment, { children: "download the PDF from wherever you can read it, and" })), ' ', "drop it here or", ' ', _jsx("label", { htmlFor: inputId, className: "link-btn", style: { cursor: busy ? 'wait' : 'pointer' }, children: busy ? 'reading the file…' : 'choose the file' }), _jsx("input", { ref: input, id: inputId, type: "file", accept: "application/pdf,.pdf", className: "vh", disabled: busy, onChange: (event) => void take(event.target.files?.[0]) }), ".", problem ? ` ${problem}` : ''] }));
}
