// Messages sent while an agent is still working, shown above the box they were
// typed in: each can be taken back, and "Stop & send now" doesn't wait for the
// run to end. The agent panes (ProjectAgent, CliAgent) and Ask AI use it.

import { CloseIcon } from './icons';

export default function QueuedMessages({
  items,
  running,
  when,
  onRemove,
  onSendNow,
}: {
  items: string[];
  /** Whether the run they wait for is still going. */
  running: boolean;
  /** When they go, in words: "at its next step", "when this answer ends". */
  when: string;
  onRemove: (index: number) => void;
  /** Running: stop the run and send them; not running (it was stopped or failed): send them. */
  onSendNow: () => void;
}) {
  if (!items.length) return null;
  return (
    <div className="queued-msgs" aria-label="Messages waiting to be sent">
      <div className="queued-head">
        <span>{running ? `Waiting · sent ${when}` : 'Waiting · the run ended before it read these'}</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={onSendNow} title={running ? 'Stop the run now, and send these as the next message' : 'Send them now'}>
          {running ? 'Stop & send now' : 'Send now'}
        </button>
      </div>
      {items.map((text, index) => (
        <div key={`${index}-${text.slice(0, 20)}`} className="queued-msg">
          <p>{text}</p>
          <button type="button" className="win-btn" onClick={() => onRemove(index)} aria-label="Take this message back" title="Take it back">
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
