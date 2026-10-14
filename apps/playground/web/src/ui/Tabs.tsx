import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: ReactNode;
}

/**
 * A tab list with arrow-key movement. The caller renders the panel; `idPrefix` ties tabs to it
 * through `aria-controls`.
 */
export function Tabs<T extends string>({
  label,
  items,
  selected,
  onSelect,
  idPrefix,
  className = "tabs",
}: {
  readonly label: string;
  readonly items: readonly TabItem<T>[];
  readonly selected: T;
  readonly onSelect: (id: T) => void;
  readonly idPrefix: string;
  readonly className?: string;
}): ReactElement {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = items.findIndex((item) => item.id === selected);
    const targets: Readonly<Record<string, number>> = {
      ArrowRight: (index + 1) % items.length,
      ArrowLeft: (index - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const item = items[next];
    if (item === undefined) return;
    onSelect(item.id);
    refs.current.get(item.id)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className} onKeyDown={move}>
      {items.map((item) => (
        <button
          key={item.id}
          ref={(element) => {
            if (element === null) refs.current.delete(item.id);
            else refs.current.set(item.id, element);
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${item.id}`}
          aria-selected={item.id === selected}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={item.id === selected ? 0 : -1}
          onClick={() => {
            onSelect(item.id);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
