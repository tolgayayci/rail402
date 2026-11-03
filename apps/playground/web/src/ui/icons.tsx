/** Small inline icons. Each is decorative: the control or text next to it carries the meaning. */
import type { ReactElement } from "react";

export function ExternalIcon(): ReactElement {
  return (
    <svg className="external-icon" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path
        d="M4 2 H9 V7 M9 2 L3 8"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CopyIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect
        x="4.5"
        y="4.5"
        width="7"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
      />
      <path
        d="M9.5 2.5 H3.5 A1 1 0 0 0 2.5 3.5 V9.5"
        stroke="currentColor"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A tick on its own, for small confirmations such as "copied". */
export function TickIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M3 7.4 L5.8 10 L11 4.4"
        stroke="currentColor"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A filled circle with a tick: a step that is done. */
export function DoneIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path
        d="M4.6 8.2 L7 10.5 L11.4 5.8"
        stroke="#ffffff"
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A filled circle with a cross: a step that failed. */
export function FailedIcon({ size = 16 }: { readonly size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="currentColor" />
      <path
        d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A spinning arc; its colour is the current text colour. */
export function Spinner({ size = 14 }: { readonly size?: number }): ReactElement {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" fill="none" />
      <path
        d="M7 1.5 A5.5 5.5 0 0 1 12.5 7"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The icon of a party on the stage: you, an API, Rail402, the chain, an agent, the Bazaar, a tool. */
export function LaneIcon({
  icon,
}: {
  readonly icon: "user" | "server" | "rail" | "chain" | "agent" | "grid" | "tool";
}): ReactElement {
  const line = {
    stroke: "currentColor",
    strokeWidth: 1.6,
    fill: "none",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <svg className="lane-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {icon === "user" ? (
        <>
          <circle cx="8" cy="5.5" r="2.8" {...line} />
          <path d="M2.8 14 C3.6 10.8 12.4 10.8 13.2 14" {...line} />
        </>
      ) : icon === "server" ? (
        <>
          <rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2" {...line} />
          <rect x="2.5" y="9" width="11" height="4.5" rx="1.2" {...line} />
          <path d="M5 4.75 H5.01 M5 11.25 H5.01" {...line} />
        </>
      ) : icon === "rail" ? (
        <>
          <rect x="2" y="2" width="12" height="12" rx="2" fill="currentColor" />
          <path
            d="M5.5 11 V5 H8.6 C10.2 5 10.2 7.8 8.6 7.8 H5.5 M8 7.8 L10.5 11"
            stroke="#0e0e10"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : icon === "chain" ? (
        <>
          <circle cx="8" cy="8" r="5.5" {...line} />
          <path d="M2.5 8 H13.5 M8 2.5 C6 5 6 11 8 13.5 C10 11 10 5 8 2.5" {...line} />
        </>
      ) : icon === "agent" ? (
        <path d="M8 1.8 L9.6 6.4 L14.2 8 L9.6 9.6 L8 14.2 L6.4 9.6 L1.8 8 L6.4 6.4 Z" {...line} />
      ) : icon === "grid" ? (
        <>
          <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" {...line} />
          <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" {...line} />
          <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" {...line} />
          <rect x="9" y="9" width="4.5" height="4.5" rx="1" {...line} />
        </>
      ) : (
        <path
          d="M10.5 2.5 A3 3 0 0 0 9.8 7.3 L3 14 L2 13 L8.7 6.2 A3 3 0 0 0 13.5 5.5 L11.6 5.9 L10.1 4.4 Z"
          {...line}
        />
      )}
    </svg>
  );
}

/** A small chevron for a menu button. */
export function ChevronIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A page arrow: one chevron for the next or previous page, two for the first or last. */
export function PagerIcon({
  direction,
  double = false,
}: {
  readonly direction: "left" | "right";
  readonly double?: boolean;
}): ReactElement {
  const flip = direction === "left" ? "matrix(-1 0 0 1 14 0)" : undefined;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d={double ? "M3.5 3.5 L7 7 L3.5 10.5 M7.5 3.5 L11 7 L7.5 10.5" : "M5.5 3.5 L9 7 L5.5 10.5"}
        transform={flip}
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The 16px line icons of the header links, the page tabs and the menu: one stroke style for all. */
function NavIcon({ children }: { readonly children: ReactElement | readonly ReactElement[] }): ReactElement {
  return (
    <svg
      className="nav-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function DocsIcon(): ReactElement {
  return (
    <NavIcon>
      <path d="M3 13V3.5A1.5 1.5 0 0 1 4.5 2H13v9.5H4.5A1.5 1.5 0 0 0 3 13a1.5 1.5 0 0 0 1.5 1.5H13" />
      <path d="M6 5h4" />
    </NavIcon>
  );
}

export function ExplorerIcon(): ReactElement {
  return (
    <NavIcon>
      <circle cx="8" cy="8" r="6" />
      <path d="m10.5 5.5-1.6 3.4-3.4 1.6 1.6-3.4z" />
    </NavIcon>
  );
}

export function GitHubIcon(): ReactElement {
  return (
    <svg
      className="nav-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function LabIcon(): ReactElement {
  return (
    <NavIcon>
      <path d="M6 2h4" />
      <path d="M7 2v4.2L3.2 12.6A1 1 0 0 0 4.1 14h7.8a1 1 0 0 0 .9-1.4L9 6.2V2" />
      <path d="M4.8 10h6.4" />
    </NavIcon>
  );
}

export function BazaarIcon(): ReactElement {
  return (
    <NavIcon>
      <path d="M2.5 6.5 3.6 2.5h8.8l1.1 4" />
      <path d="M2.5 6.5h11a1.8 1.8 0 0 1-3.7 0 1.8 1.8 0 0 1-3.6 0 1.8 1.8 0 0 1-3.7 0z" />
      <path d="M3.5 8.5v5h9v-5" />
      <path d="M6.5 13.5v-3h3v3" />
    </NavIcon>
  );
}

export function SellIcon(): ReactElement {
  return (
    <NavIcon>
      <path d="M8.5 2.5h5v5l-6.3 6.3a1 1 0 0 1-1.4 0L2.2 10.2a1 1 0 0 1 0-1.4z" />
      <circle cx="11" cy="5" r="1" />
    </NavIcon>
  );
}

export function AgentsIcon(): ReactElement {
  return (
    <NavIcon>
      <rect x="2.5" y="5" width="11" height="8.5" rx="2" />
      <path d="M8 2.5V5" />
      <path d="M6 9h.01M10 9h.01" />
    </NavIcon>
  );
}

/** Three lines, or a cross while the menu is open. */
export function MenuIcon({ open }: { readonly open: boolean }): ReactElement {
  return (
    <NavIcon>
      {open ? <path d="m4 4 8 8M12 4l-8 8" /> : <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />}
    </NavIcon>
  );
}
