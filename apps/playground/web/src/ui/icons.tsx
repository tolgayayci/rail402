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
