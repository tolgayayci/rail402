/**
 * The message flow: four lanes, and one row per message or step, projected from lab events. An arrow
 * row runs between two lanes; a step inside one lane is a pill. A row still in flight carries a
 * travelling dot. Clicking a row selects it for the inspector.
 */
import type { ReactElement } from "react";
import type { Source } from "../engine/events.ts";
import type { Lane, LaneTone } from "../projection/lanes.ts";
import type { Row } from "../projection/rows.ts";

const SOURCE_LABEL: Readonly<Record<Source, string>> = {
  you: "seen on your side",
  seller: "reported by the seller",
  chain: "read from the chain",
  bazaar: "read from the Bazaar",
};

export function sourceLabel(source: Source): string {
  return SOURCE_LABEL[source];
}

export function LaneHeader({ lanes }: { readonly lanes: readonly Lane[] }): ReactElement {
  return (
    <div className="lanes" aria-hidden="false">
      {lanes.map((lane, index) => (
        <div key={index} className="lane" data-tone={lane.tone}>
          <span className="lane-chip">{lane.label.charAt(0)}</span>
          <span className="lane-label">{lane.label}</span>
          <span className="lane-role">{lane.role}</span>
        </div>
      ))}
    </div>
  );
}

export function Swimlane({
  lanes,
  rows,
  selectedId,
  onSelect,
  idle,
}: {
  readonly lanes: readonly Lane[];
  readonly rows: readonly Row[];
  readonly selectedId: string | null;
  readonly onSelect: (row: Row) => void;
  /** Shown instead of rows before the first run. */
  readonly idle?: ReactElement | null;
}): ReactElement {
  return (
    <div className="swimlane">
      <LaneHeader lanes={lanes} />
      <div className="rows">
        <div className="lane-lines" aria-hidden="true">
          {lanes.map((lane, index) => (
            <span key={index} data-tone={lane.tone} />
          ))}
        </div>
        <ol className="row-list" aria-label="Messages">
          {rows.map((row) => (
            <li key={row.id} className="row-item">
              <RowButton
                row={row}
                lanes={lanes}
                selected={row.id === selectedId}
                onSelect={() => {
                  onSelect(row);
                }}
              />
            </li>
          ))}
        </ol>
        {rows.length === 0 && idle !== undefined && idle !== null ? (
          <div className="rows-idle">{idle}</div>
        ) : null}
      </div>
    </div>
  );
}

function RowButton({
  row,
  lanes,
  selected,
  onSelect,
}: {
  readonly row: Row;
  readonly lanes: readonly Lane[];
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const error = row.status === "error";
  const live = row.status === "live";
  const laneTone = (index: number): LaneTone => lanes[index]?.tone ?? "you";
  const status =
    row.status === "live"
      ? "in progress"
      : row.status === "pending"
        ? "not finished"
        : row.status === "error"
          ? "failed or refused"
          : "done";
  const common = {
    type: "button" as const,
    className: "row",
    "data-step": row.step,
    "data-lane":
      "self" in row.lane
        ? `self ${String(row.lane.self)}`
        : `${String(row.lane.from)}→${String(row.lane.to)}`,
    "data-status": row.status,
    "data-source": row.source,
    "aria-pressed": selected,
    "aria-label": `Inspect: ${row.label}. ${row.sub}. ${status}, ${sourceLabel(row.source)}.`,
    onClick: onSelect,
  };

  if ("self" in row.lane) {
    const column = row.lane.self + 1;
    return (
      <button {...common}>
        <span className="row-self" style={{ gridColumn: `${String(column)} / ${String(column + 1)}` }}>
          <span
            className={`row-pill${live ? " glow" : ""}`}
            data-tone={error ? "error" : laneTone(row.lane.self)}
          >
            {row.label}
          </span>
          <span className="row-sub">{row.sub}</span>
        </span>
      </button>
    );
  }

  const { from, to } = row.lane;
  const first = Math.min(from, to);
  const last = Math.max(from, to);
  const span = last - first + 1;
  const right = to > from;
  // Each lane's line is at the middle of its column, so the arrow starts and ends half a column in.
  const inset = `${(50 / span).toFixed(3)}%`;
  return (
    <button {...common}>
      <span
        className="row-arrow"
        data-tone={error ? "error" : laneTone(from)}
        data-direction={right ? "right" : "left"}
        style={{ gridColumn: `${String(first + 1)} / ${String(last + 2)}`, paddingInline: inset }}
      >
        <span className="row-label">{row.label}</span>
        <span className="row-track">
          <span className="row-line" />
          <span className="row-head" />
          {live ? <span className={`row-dot ${right ? "travel-right" : "travel-left"}`} /> : null}
        </span>
        <span className="row-sub">{row.sub}</span>
      </span>
    </button>
  );
}
