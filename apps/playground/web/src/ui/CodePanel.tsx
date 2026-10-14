import { useId, useMemo, useState, type ReactElement } from "react";
import type { StepId } from "../../../src/shared/lab.ts";
import { highlight, parseSnippet } from "../projection/code.ts";
import { Tabs } from "./Tabs.tsx";

export interface CodeTab {
  readonly id: string;
  readonly label: string;
  /** Snippet source with `@step` and `@hide` markers. */
  readonly source: string;
}

/**
 * Code for the same flow from the SDK, the CLI, a seller or an MCP client. Lines tied to the selected
 * row's step are highlighted.
 */
export function CodePanel({
  tabs,
  step,
  hint = "highlights the selected step",
}: {
  readonly tabs: readonly CodeTab[];
  readonly step: StepId | undefined;
  readonly hint?: string;
}): ReactElement | null {
  const idPrefix = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const active = tabs.find((tab) => tab.id === chosen) ?? tabs[0];
  const snippet = useMemo(() => (active === undefined ? undefined : parseSnippet(active.source)), [active]);
  if (active === undefined || snippet === undefined) return null;
  const lines = highlight(snippet, step);
  return (
    <section className="code-panel" aria-label="Code">
      <div className="code-head">
        <Tabs
          label="Code"
          className="code-tabs"
          idPrefix={idPrefix}
          items={tabs.map((tab) => ({ id: tab.id, label: tab.label }))}
          selected={active.id}
          onSelect={setChosen}
        />
        <span className="code-hint">{hint}</span>
      </div>
      <pre
        className="code"
        id={`${idPrefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${active.id}`}
      >
        {lines.map((line, index) => (
          <span key={index} className="code-line" data-on={line.on}>
            {line.text === "" ? " " : line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </section>
  );
}
