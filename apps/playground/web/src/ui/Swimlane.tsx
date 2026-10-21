/**
 * The swimlane on the dark stage: one column per party, one row per message. A message is an arrow
 * between two lanes with its label on a chip; a step inside one lane is a pill. Steps that have played
 * are grey, the current one glows in the mode's colour, and those still to come are dashed.
 *
 * It is a picture of the run: the step list in the inspector carries the same steps for keyboard and
 * screen-reader users, so this one is hidden from assistive technology and only adds mouse selection.
 * Each row names its step's kind and lanes (`data-step`, `data-lane`), which the browser tests read.
 */
import type { CSSProperties, ReactElement } from "react";
import type { StageLane, StageStep } from "../projection/stage.ts";
import { LaneIcon, Spinner } from "./icons.tsx";

export type StepLook = "pending" | "current" | "done" | "error";

export interface SwimlaneProps {
  readonly lanes: readonly StageLane[];
  readonly steps: readonly StageStep[];
  readonly lookOf: (step: StageStep) => StepLook;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}

/** Row height by how many steps must fit. */
function rowHeight(count: number): number {
  return count <= 8 ? 58 : count <= 10 ? 50 : 44;
}

export function Swimlane({ lanes, steps, lookOf, selected, onSelect }: SwimlaneProps): ReactElement {
  const style = {
    "--lanes": lanes.length,
    "--rows": steps.length,
    "--row": `${String(rowHeight(steps.length))}px`,
  } as CSSProperties;
  return (
    <div className="swimlane-scroll" aria-hidden="true">
      <div className="swimlane" style={style}>
        <div className="swimlane-bands">
          {lanes.map((lane) => (
            <div key={`${lane.tone}-${lane.label}`} className="lane-band" data-tone={lane.tone}>
              <div className="lane-head">
                <span className="lane-head-icon">
                  <LaneIcon icon={lane.icon} />
                </span>
                <span className="lane-head-text">
                  <b>{lane.label}</b>
                  <span>{lane.role}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
        <ol className="swimlane-steps">
          {steps.map((step) => {
            const look = lookOf(step);
            const self = "self" in step.lane;
            const from = "self" in step.lane ? step.lane.self : step.lane.from;
            const to = "self" in step.lane ? step.lane.self : step.lane.to;
            const geometry = { "--a": Math.min(from, to), "--b": Math.max(from, to) } as CSSProperties;
            return (
              <li
                key={step.id}
                className="lane-step"
                data-look={look}
                data-step={step.kind}
                data-lane={self ? `self ${String(from)}` : `${String(from)}→${String(to)}`}
                data-kind={self ? "self" : "message"}
                data-dir={to >= from ? "right" : "left"}
                data-selected={step.id === selected}
                style={geometry}
              >
                {self ? null : <span className="lane-arrow" />}
                <span
                  className="lane-chip"
                  title={step.chip}
                  onClick={() => {
                    onSelect(step.id);
                  }}
                >
                  {look === "current" && step.state === "live" ? <Spinner size={11} /> : null}
                  <span className="lane-chip-text">{step.chip}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
