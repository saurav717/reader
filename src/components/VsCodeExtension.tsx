// The Reader extension for VS Code, installed through the Companion: the
// extension isn't on the Marketplace, and a page can't run
// `code --install-extension`, but the Companion on that computer can
// (/companion/vscode in companion/reader_companion/extension.py).

import { useEffect, useState } from 'react';
import type { JupyterServer } from '../lib/colab';
import type { VsCodeStatus } from '../lib/companion';
import { companionPort, companionVsCode } from '../lib/companion';

/** VS Code's mark, drawn small in the bar's ink. */
export function VsCodeMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M17 2.8 21 4.8v14.4l-4 2-11-9.2L17 2.8Z" />
      <path d="M17 7.6 10.6 12 17 16.4" />
      <path d="M3 9.2 5.4 8 17 17.4M3 14.8 5.4 16 17 6.6" />
    </svg>
  );
}

export const isCompanion = (server: JupyterServer) => Boolean(server.companionId || companionPort(server.url));

/**
 * "Add Reader to VS Code" for a Companion's computer. In a project's bar
 * (`compact`) it shows only while there is something to do; under Your compute
 * it also says where the extension already is.
 */
export default function VsCodeExtension({ server, compact = false }: { server: JupyterServer; compact?: boolean }) {
  const [status, setStatus] = useState<VsCodeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!isCompanion(server)) return;
    let live = true;
    companionVsCode(server)
      .then((answer) => live && setStatus(answer))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.url, server.token]);
  if (!isCompanion(server) || !status) return null;
  const missing = status.editors.filter((editor) => !editor.installed);
  const install = async () => {
    setBusy(true);
    setProblem(null);
    try {
      setStatus(await companionVsCode(server, true));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (compact) {
    if (!missing.length) return null;
    return (
      <button type="button" className="btn sm ghost" onClick={() => void install()} disabled={busy} title={problem ?? 'Installs the Reader extension into VS Code on this computer, through the Companion: the projects, the papers they cite and this Python in its side bar'}>
        <VsCodeMark /> {busy ? 'Adding…' : problem ? 'Try again' : 'Add Reader to VS Code'}
      </button>
    );
  }
  return (
    <div className="pg-vscode">
      <VsCodeMark />
      {!status.editors.length ? (
        <small>No VS Code on this computer. Once it’s installed, this adds the Reader extension to it.</small>
      ) : missing.length ? (
        <>
          <small>VS Code is here without the Reader extension.</small>
          <button type="button" className="btn sm primary" onClick={() => void install()} disabled={busy}>
            {busy ? 'Adding…' : 'Add Reader to VS Code'}
          </button>
        </>
      ) : (
        <small>The Reader extension is in {status.editors.map((editor) => editor.name).join(', ')}.</small>
      )}
      {problem ? <p className="pg-bad">{problem}</p> : null}
    </div>
  );
}
