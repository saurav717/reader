import type { ReactNode } from 'react';

/**
 * The armillary: the one drawing inside the app. Three rings on a tilted
 * axis with a star at the pole, in gold hairlines — the same instrument the
 * loading screen draws. It stands where a page has nothing to show yet, and
 * at the top of Settings.
 */
export function Armillary({ size = 72, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 160 160" width={size} height={size} className={className} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <circle cx="80" cy="84" r="54" opacity="0.9" />
        <ellipse cx="80" cy="84" rx="54" ry="15" opacity="0.8" />
        <ellipse cx="80" cy="84" rx="54" ry="33" transform="rotate(-23.5 80 84)" opacity="0.55" />
        <ellipse cx="80" cy="84" rx="15" ry="54" opacity="0.45" />
        <line x1="80" y1="14" x2="80" y2="154" transform="rotate(-23.5 80 84)" opacity="0.9" />
        <circle cx="80" cy="84" r="68" strokeDasharray="1.5 6" opacity="0.4" />
      </g>
      <g fill="currentColor">
        <circle cx="80" cy="84" r="2.6" />
        <circle cx="26" cy="84" r="2" opacity="0.8" />
        <circle cx="134" cy="84" r="2" opacity="0.8" />
      </g>
      <path fill="currentColor" transform="translate(108 19.6) rotate(-23.5)" d="M0 -9 L1.6 -1.6 L9 0 L1.6 1.6 L0 9 L-1.6 1.6 L-9 0 L-1.6 -1.6 Z" />
    </svg>
  );
}

/**
 * An empty state: the armillary, one of the Titan's lines, and a sentence on
 * what to do. Where the ground is empty is the one place inside the app the
 * name shows.
 */
export function Quiet({ line, children, action, compact }: { line: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`quiet${compact ? ' is-compact' : ''}`}>
      <Armillary size={compact ? 40 : 84} />
      <p className="quiet-line">{line}</p>
      {children ? <p className="quiet-text">{children}</p> : null}
      {action}
    </div>
  );
}
