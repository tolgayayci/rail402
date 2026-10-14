/**
 * A run on screen: the swimlane with its header, the inspector and the code panel side by side. Used
 * by the lab and, under "What happened", by the Pay page.
 */
import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { LabEvent, ScenarioId } from "../engine/events.ts";
import { collectFacts, flowKindOf, type FlowKind } from "../projection/facts.ts";
import { inspectorFor } from "../projection/inspector.ts";
import { lanesFor, type Lane, type LaneOptions } from "../projection/lanes.ts";
import { projectRows, type Row } from "../projection/rows.ts";
import { CodePanel, type CodeTab } from "./CodePanel.tsx";
import { Inspector } from "./Inspector.tsx";
import { Swimlane } from "./Swimlane.tsx";

export interface FlowProjection {
  readonly lanes: readonly Lane[];
  readonly rows: readonly Row[];
  /** What was paid: an MCP tool or HTTP, exact or upto; the inspector's wording follows it. */
  readonly flow: FlowKind;
}

export function useFlowProjection(
  events: readonly LabEvent[],
  scenario: ScenarioId,
  laneOptions: LaneOptions,
  asset: { readonly symbol: string; readonly decimals: number },
): FlowProjection {
  const { sellerHost, sellerLabel, facilitatorLabel } = laneOptions;
  const lanes = useMemo(
    () =>
      lanesFor(scenario, {
        sellerHost,
        ...(sellerLabel === undefined ? {} : { sellerLabel }),
        ...(facilitatorLabel === undefined ? {} : { facilitatorLabel }),
      }),
    [scenario, sellerHost, sellerLabel, facilitatorLabel],
  );
  const { symbol, decimals } = asset;
  const rows = useMemo(
    () => projectRows(events, { asset: { symbol, decimals } }),
    [events, symbol, decimals],
  );
  const flow = useMemo(() => flowKindOf(collectFacts(events)), [events]);
  return { lanes, rows, flow };
}

/**
 * The selected row: the one the visitor clicked, or else the latest, so the inspector follows a run
 * as it happens until the visitor picks a row.
 */
export function useRowSelection(
  rows: readonly Row[],
  runId: string | null,
): { readonly selected: Row | undefined; readonly select: (row: Row) => void } {
  const [pinned, setPinned] = useState<{ readonly runId: string | null; readonly rowId: string } | null>(
    null,
  );
  const pinnedRow =
    pinned !== null && pinned.runId === runId ? rows.find((row) => row.id === pinned.rowId) : undefined;
  return {
    selected: pinnedRow ?? rows.at(-1),
    select: (row) => {
      setPinned({ runId, rowId: row.id });
    },
  };
}

export function FlowLayout({
  scenario,
  projection,
  head,
  idle,
  selected,
  onSelect,
  codeTabs,
  docsUrl,
}: {
  readonly scenario: ScenarioId;
  readonly projection: FlowProjection;
  readonly head: ReactNode;
  readonly idle: ReactElement | null;
  readonly selected: Row | undefined;
  readonly onSelect: (row: Row) => void;
  readonly codeTabs: readonly CodeTab[];
  readonly docsUrl: string;
}): ReactElement {
  const inspector = inspectorFor(selected, projection.lanes, scenario, projection.flow);
  return (
    <div className="flow-layout">
      <section className="card flow" aria-label="Message flow">
        <div className="card-head flow-head">{head}</div>
        <Swimlane
          lanes={projection.lanes}
          rows={projection.rows}
          selectedId={selected?.id ?? null}
          onSelect={onSelect}
          idle={idle}
        />
      </section>
      <aside className="flow-aside" aria-label="Details">
        <Inspector view={inspector} docsUrl={docsUrl} />
        {codeTabs.length > 0 ? <CodePanel tabs={codeTabs} step={selected?.step} /> : null}
      </aside>
    </div>
  );
}
