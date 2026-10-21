/**
 * "Try a refusal": a compact menu on the stage that runs one of the payments your buyer, the relay or
 * Rail402 must refuse. Choosing one runs it at once and plays it on the stage like any other run.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { ChevronIcon } from "../../ui/icons.tsx";
import type { RefusalEntry } from "./refusals.ts";

export function RefusalMenu({
  before,
  after,
  disabled,
  onChoose,
}: {
  readonly before: readonly RefusalEntry[];
  readonly after: readonly RefusalEntry[];
  readonly disabled: boolean;
  readonly onChoose: (entry: RefusalEntry) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    root.current?.querySelector<HTMLButtonElement>(".refusal-item")?.focus();
    const away = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (before.length + after.length === 0) return null;
  const item = (entry: RefusalEntry): ReactElement => (
    <li key={entry.key}>
      <button
        type="button"
        className="refusal-item"
        onClick={() => {
          setOpen(false);
          onChoose(entry);
        }}
      >
        <span className="refusal-item-title">{entry.title}</span>
        <span className="refusal-item-how">{entry.how}</span>
        <code className="refusal-item-code">{entry.expects}</code>
      </button>
    </li>
  );
  return (
    <div className="refusal-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="stage-button stage-button-ghost"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        Try a refusal <ChevronIcon />
      </button>
      {open ? (
        <div id={id} className="refusal-popover" role="group" aria-label="Payments that must be refused">
          {before.length > 0 ? (
            <section aria-labelledby={`${id}-before`}>
              <h3 id={`${id}-before`} className="eyebrow">
                Refused before signing
              </h3>
              <ul>{before.map(item)}</ul>
            </section>
          ) : null}
          {after.length > 0 ? (
            <section aria-labelledby={`${id}-after`}>
              <h3 id={`${id}-after`} className="eyebrow">
                Refused after signing
              </h3>
              <ul>{after.map(item)}</ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
