// The local workspace, from the page's side: the proxy on the reader's own
// machine (server/workspace.js) says what the machine is, writes the
// Implementation page's scaffold to a directory there, and runs a command
// in it with the output streamed back. Nothing here works without the
// proxy; a static deployment, or the Worker, answers "not available" and
// the page says what to run instead.
import { apiFetch, hasProxy } from './api';
export const NO_PROXY_WORKSPACE = 'The local workspace needs the reader’s own proxy: `npm start` on your machine with READER_WORKSPACE set to a directory, and its address in Settings → Paper proxy.';
export async function workspaceStatus() {
    if (!hasProxy())
        return { available: false, reason: NO_PROXY_WORKSPACE };
    try {
        const response = await apiFetch('/workspace/status', { headers: { Accept: 'application/json' } });
        const body = (await response.json());
        if (!response.ok)
            return { available: false, reason: body.error || `The proxy answered ${response.status}.` };
        return body;
    }
    catch {
        return { available: false, reason: 'Could not reach the proxy.' };
    }
}
/** Writes the files under the workspace, one folder for the paper; files already there with other content are skipped unless `overwrite`. */
export async function writeScaffold(slug, files, overwrite = false) {
    const response = await apiFetch('/workspace/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, files, overwrite }),
    });
    const body = (await response.json());
    if (!response.ok)
        throw new Error(body.error || `The proxy answered ${response.status}.`);
    return body;
}
/**
 * Runs a command in the project's directory. `onText` gets the output as it
 * arrives, everything so far each time; aborting the signal stops the
 * command, since the proxy kills it when the connection closes.
 */
export async function runInWorkspace(slug, command, onText, signal) {
    const response = await apiFetch('/workspace/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, command }),
        signal,
    });
    if (!response.ok) {
        const body = (await response.json().catch(() => ({})));
        throw new Error(body.error || `The proxy answered ${response.status}.`);
    }
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('The proxy sent no output.');
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done)
            break;
        text += decoder.decode(value, { stream: true });
        onText(text);
    }
    text += decoder.decode();
    onText(text);
}
