// What shows when a part of the page fails as it draws: without it React drops the whole page and the window
// goes blank. The whole app has one (main.tsx), so a failure says what it was and offers a way back; a part
// that can fail on its own (a dialog, a preview) has its own, so the rest of the page stays.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  /** What to show instead, given the error and a way to try drawing it again. */
  fallback: (error: Error, retry: () => void) => ReactNode;
  /** Where it failed, for the console: "sim picker". */
  name?: string;
  children: ReactNode;
}

export default class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.name ?? 'page'}] failed to draw:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}

/** The message and the first lines of where it happened, to read out or copy. */
export function FailureNote({ error, title, children }: { error: Error; title: string; children?: ReactNode }) {
  const where = (error.stack ?? '').split('\n').slice(0, 6).join('\n');
  return (
    <div className="failure-note" role="alert">
      <h3>{title}</h3>
      <p>
        <b>{error.name}:</b> {error.message}
      </p>
      {where ? <pre className="mono">{where}</pre> : null}
      {children}
    </div>
  );
}
