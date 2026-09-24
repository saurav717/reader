import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.5 16.5 21 21" />
  </Icon>
);

export const LibraryIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="4" width="5" height="16" rx="1.4" />
    <rect x="10" y="4" width="5" height="16" rx="1.4" />
    <path d="m17.4 5.6 3 .8-3.3 13-1.6-.5" />
  </Icon>
);

export const HighlighterIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14.8 3.8 20.2 9.2 11.6 17.8H6.2v-5.4z" />
    <path d="M3.5 21h17" />
  </Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7.5h9M17.5 7.5H20M4 16.5h3.5M12 16.5h8" />
    <circle cx="15.2" cy="7.5" r="2.3" />
    <circle cx="9.7" cy="16.5" r="2.3" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={2}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={2.4}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.9}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={2}>
    <path d="m6 9.5 6 6 6-6" />
  </Icon>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M20 12H4.5m6.5-7-7 7 7 7" />
  </Icon>
);

export const PanelLeftIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <path d="M9 4.5v15" />
  </Icon>
);

export const PanelRightIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <path d="M15 4.5v15" />
  </Icon>
);

export const NoteIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M20.5 14.5a3 3 0 0 1-3 3H9.8L5 21V6.5a3 3 0 0 1 3-3h9.5a3 3 0 0 1 3 3z" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2" />
    <path d="M15.5 5.5A1.5 1.5 0 0 0 14 4H5.5A1.5 1.5 0 0 0 4 5.5V14a1.5 1.5 0 0 0 1.5 1.5" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
    <path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5" />
  </Icon>
);

export const FileIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5" />
  </Icon>
);

export const BookIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 5.2A1.7 1.7 0 0 1 5.7 3.5H10a2.4 2.4 0 0 1 2 1.2 2.4 2.4 0 0 1 2-1.2h4.3A1.7 1.7 0 0 1 20 5.2v11.4a1.7 1.7 0 0 1-1.7 1.7H14a2.4 2.4 0 0 0-2 1.2 2.4 2.4 0 0 0-2-1.2H5.7A1.7 1.7 0 0 1 4 16.6z" />
    <path d="M12 6.9v12.6" />
  </Icon>
);

export const TreeIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="4.8" r="2.1" />
    <circle cx="6" cy="19.2" r="2.1" />
    <circle cx="18" cy="19.2" r="2.1" />
    <path d="M12 6.9v4.6M6 17.1v-2.3a3.3 3.3 0 0 1 3.3-3.3h5.4a3.3 3.3 0 0 1 3.3 3.3v2.3" />
  </Icon>
);

export const ExternalIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.9}>
    <path d="M6 18 18 6M9 6h9v9" />
  </Icon>
);

export const CloudIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <path d="M7 19.5a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.6a4 4 0 0 1-.6 9.9z" />
  </Icon>
);

export const CloudCheckIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <path d="M7.4 18.5a4.5 4.5 0 0 1-.8-8.9A6 6 0 0 1 18 9.6a4 4 0 0 1 .6 7.9" />
    <path d="m9.5 15.8 2.2 2.2 4.3-4.3" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);

export const InboxIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <path d="M4.5 7.5a2 2 0 0 1 2-2h3l2 2.5h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z" />
  </Icon>
);

export const StackIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.7}>
    <rect x="4" y="4" width="16" height="16" rx="2.4" />
    <path d="M4 9.5h16" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.8v2.4M12 18.8v2.4M4.5 12H2.1M21.9 12h-2.4M6.7 6.7 5 5M19 19l-1.7-1.7M6.7 17.3 5 19M19 5l-1.7 1.7" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M12 3.6v11.2" />
    <path d="m7.6 10.6 4.4 4.4 4.4-4.4" />
    <path d="M4.4 17.2v1.6a1.6 1.6 0 0 0 1.6 1.6h12a1.6 1.6 0 0 0 1.6-1.6v-1.6" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
  </Icon>
);

/** Drive's own triangle mark, for the link out to a paper's folder. */
export const DriveMark = ({ size = 16, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 87.3 78" aria-hidden="true" focusable="false" {...rest}>
    <path fill="#0066da" d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" />
    <path fill="#00ac47" d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" />
    <path fill="#ea4335" d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.5l5.85 11.5z" />
    <path fill="#00832d" d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" />
    <path fill="#2684fc" d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" />
    <path fill="#ffba00" d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" />
  </svg>
);

export const GoogleMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8a10 10 0 0 1-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.5 6.6-16.3z" />
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.2l-7.1-5.5a13 13 0 0 1-19.4-6.8H4.7v5.7A22 22 0 0 0 24 46z" />
    <path fill="#FBBC05" d="M11.9 28.5a13 13 0 0 1 0-8.3v-5.7H4.7a22 22 0 0 0 0 19.7z" />
    <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3A21 21 0 0 0 24 2 22 22 0 0 0 4.7 14.5l7.2 5.7A13 13 0 0 1 24 10.8z" />
  </svg>
);

export const OpenBookIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 6.5C10.4 5.2 8 4.5 3.5 4.5v14c4.5 0 6.9.7 8.5 2 1.6-1.3 4-2 8.5-2v-14c-4.5 0-6.9.7-8.5 2Z" />
    <path d="M12 6.5v14" />
  </Icon>
);

export const ScrollPageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.5" y="3.5" width="13" height="17" rx="2" />
    <path d="M9 8h6M9 12h6M9 16h4" />
  </Icon>
);

export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15 6-6 6 6 6" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const SparkleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3.5c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5 3.9-.5 6-2.6 6.5-6.5Z" />
    <path d="M18.5 15.5c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5Z" />
  </Icon>
);

export const ListIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.8" cy="6.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.8" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.8" cy="17.5" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const GridIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
  </Icon>
);

export const RestoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
    <path d="M4.5 4.5V9H9" />
  </Icon>
);

export const FolderMoveIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7.5a2 2 0 0 1 2-2h3.2l2 2.3H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M10 13.5h5.5M13.5 11.3l2.2 2.2-2.2 2.2" />
  </Icon>
);

export const FlagIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.5 20.5V4.5M5.5 5h11l-2.2 3.6 2.2 3.6h-11" />
  </Icon>
);

export const TableIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M3.5 14.5h17M9 9.5v10" />
  </Icon>
);

export const SlidersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const CameraIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
    <circle cx="12" cy="13" r="3.5" />
  </Icon>
);

/** Zen mode: the page alone, the panes pulled back to the edges. */
export const ZenIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M3.5 8.5v-2a2 2 0 0 1 2-2h2M16.5 4.5h2a2 2 0 0 1 2 2v2M20.5 15.5v2a2 2 0 0 1-2 2h-2M7.5 19.5h-2a2 2 0 0 1-2-2v-2" />
    <path d="M9 12h6" />
  </Icon>
);

/** An open book with a spark over it: the paper, explained. */
export const ExplainIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 6.5c2.8-.9 5.6-.6 8.5 1.2v11.5c-2.9-1.8-5.7-2.1-8.5-1.2V6.5Z" />
    <path d="M12 7.7c1-.6 1.9-1 2.9-1.2" />
    <path d="M12 19.2c2.9-1.8 5.7-2.1 8.5-1.2v-5" />
    <path d="M18.5 2.8c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z" />
  </Icon>
);
