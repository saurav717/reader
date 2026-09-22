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

export const MoonIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth={1.8}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
  </Icon>
);

export const GoogleMark = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8a10 10 0 0 1-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.5 6.6-16.3z" />
    <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.2l-7.1-5.5a13 13 0 0 1-19.4-6.8H4.7v5.7A22 22 0 0 0 24 46z" />
    <path fill="#FBBC05" d="M11.9 28.5a13 13 0 0 1 0-8.3v-5.7H4.7a22 22 0 0 0 0 19.7z" />
    <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3A21 21 0 0 0 24 2 22 22 0 0 0 4.7 14.5l7.2 5.7A13 13 0 0 1 24 10.8z" />
  </svg>
);
