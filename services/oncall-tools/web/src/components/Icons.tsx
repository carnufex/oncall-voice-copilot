// Small inline SVG icon set — no emoji, no external icon library. Each icon is a plain
// stroke drawing on a 16x16 grid so they sit consistently at 1em next to text.

type IconProps = { className?: string };

function base(children: JSX.Element, className?: string) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return base(
    <>
      <path d="M8 1.6 14.6 13.2H1.4L8 1.6Z" />
      <path d="M8 6.4v3.1" />
      <circle cx="8" cy="11.4" r="0.55" fill="currentColor" stroke="none" />
    </>,
    className,
  );
}

export function ToolIcon({ className }: IconProps) {
  return base(
    <path d="M10.6 2.6a3 3 0 0 0-3.9 3.7L2.4 10.6a1.4 1.4 0 0 0 2 2l4.3-4.3a3 3 0 0 0 3.7-3.9l-1.9 1.9-1.6-.4-.4-1.6 1.9-1.9Z" />,
    className,
  );
}

export function CheckIcon({ className }: IconProps) {
  return base(
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M5.3 8.2 7.2 10l3.4-4" />
    </>,
    className,
  );
}

export function NoteIcon({ className }: IconProps) {
  return base(
    <>
      <path d="M3.4 2.2h9.2v11.6H3.4z" />
      <path d="M5.4 5.4h5.2M5.4 8h5.2M5.4 10.6h3.2" />
    </>,
    className,
  );
}

export function PhoneIcon({ className }: IconProps) {
  return base(
    <path d="M3.1 2.6 5.4 2l1.2 3-1.3 1.1a7 7 0 0 0 3.6 3.6l1.1-1.3 3 1.2-.6 2.3c-.2.7-.9 1.1-1.6 1-3.9-.6-7.1-3.8-7.7-7.7-.1-.7.3-1.4 1-1.6Z" />,
    className,
  );
}

export function CopyIcon({ className }: IconProps) {
  return base(
    <>
      <rect x="5.6" y="5.6" width="8" height="8" rx="1.2" />
      <path d="M10.4 5.6V3.4a1 1 0 0 0-1-1H3.4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.2" />
    </>,
    className,
  );
}

export function CheckSmallIcon({ className }: IconProps) {
  return base(<path d="M3.4 8.4 6.4 11.4 12.6 4.8" />, className);
}

export function ExternalLinkIcon({ className }: IconProps) {
  return base(
    <>
      <path d="M6.6 3.4H3.6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
      <path d="M9.4 2.6h4v4M13 3l-6 6" />
    </>,
    className,
  );
}

export function ChevronLeftIcon({ className }: IconProps) {
  return base(<path d="M10 3 5 8l5 5" />, className);
}

export function CloseIcon({ className }: IconProps) {
  return base(<path d="M4 4 12 12M12 4 4 12" />, className);
}

export const KIND_ICON: Record<"alert" | "tool" | "action" | "note" | "call", (props: IconProps) => JSX.Element> = {
  alert: AlertIcon,
  tool: ToolIcon,
  action: CheckIcon,
  note: NoteIcon,
  call: PhoneIcon,
};
