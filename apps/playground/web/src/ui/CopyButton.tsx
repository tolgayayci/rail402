/** Copies a text to the clipboard, then says so: a tick on the button and a polite announcement. */
import { useEffect, useState, type ReactElement } from "react";
import { CopyIcon, TickIcon } from "./icons.tsx";

type CopyState = "idle" | "copied" | "failed";

const ANNOUNCE: Readonly<Record<CopyState, string>> = {
  idle: "",
  copied: "Copied",
  failed: "Could not copy: select the text and copy it instead",
};

export function CopyButton({
  text,
  label,
  className,
}: {
  readonly text: string;
  /** What is copied, as the button's accessible name: "Copy address". */
  readonly label: string;
  readonly className?: string;
}): ReactElement {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = setTimeout(() => {
      setState("idle");
    }, 1_600);
    return () => {
      clearTimeout(timer);
    };
  }, [state]);
  const copy = (): void => {
    // The Clipboard API is missing outside secure contexts.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      setState("failed");
      return;
    }
    clipboard.writeText(text).then(
      () => {
        setState("copied");
      },
      () => {
        setState("failed");
      },
    );
  };
  return (
    <>
      <button
        type="button"
        className={`icon-button copy-button${className === undefined ? "" : ` ${className}`}`}
        aria-label={label}
        data-state={state}
        onClick={copy}
      >
        {state === "copied" ? <TickIcon /> : <CopyIcon />}
      </button>
      <span className="visually-hidden" role="status">
        {ANNOUNCE[state]}
      </span>
    </>
  );
}
