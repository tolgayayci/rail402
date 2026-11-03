/** Pieces the Sell and Agents pages share: a pressed-state pick button, and a story told in steps. */
import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CodeBlock, type CodeLanguage } from "../../ui/CodeBlock.tsx";

export function PickButton({
  pressed,
  onPick,
  className,
  children,
}: {
  readonly pressed: boolean;
  readonly onPick: () => void;
  readonly className: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button type="button" className={className} aria-pressed={pressed} onClick={onPick}>
      {children}
    </button>
  );
}

/** Who acts in a step; the Sell story colours each party, the Agents tools carry a plain note. */
export type Party = "Agent" | "Your API" | "Rail402" | "Stellar";

export interface Beat {
  /** The step's name on its button. */
  readonly title: string;
  /** A short line under the name: who acts (a Party, drawn in its colour), or what the tool does. */
  readonly party: string;
  /** The heading over the explanation, when it differs from the name. */
  readonly heading?: string;
  readonly body: string;
  /** An example of what goes over the wire at this step. */
  readonly code: string;
  readonly codeTitle?: string;
}

const PARTIES: readonly string[] = ["Agent", "Your API", "Rail402", "Stellar"];

/** Steps as a row of buttons; the pressed one explains itself beside an example. */
export function Story({
  beats,
  start = 0,
  language,
  mono = false,
}: {
  readonly beats: readonly Beat[];
  readonly start?: number;
  readonly language: CodeLanguage;
  /** Names set in the code face, for tool names. */
  readonly mono?: boolean;
}): ReactElement {
  const [index, setIndex] = useState(start);
  const current = beats[index] ?? beats[0];
  return (
    <div className="guide-story">
      <ol className="guide-beats" style={{ "--beats": beats.length } as CSSProperties}>
        {beats.map((beat, at) => (
          <li key={beat.title}>
            <button
              type="button"
              className="guide-beat"
              aria-pressed={at === index}
              onClick={() => {
                setIndex(at);
              }}
            >
              <span className="guide-beat-number">{String(at + 1).padStart(2, "0")}</span>
              <span className="guide-beat-title" data-mono={mono ? "" : undefined}>
                {beat.title}
              </span>
              <span
                className="guide-party"
                data-party={PARTIES.includes(beat.party) ? beat.party : undefined}
              >
                {beat.party}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {current === undefined ? null : (
        <div className="guide-beat-detail" aria-live="polite">
          <div>
            <h3>{current.heading ?? current.title}</h3>
            <p>{current.body}</p>
          </div>
          <CodeBlock
            code={current.code}
            language={language}
            label="Copy the example"
            title={current.codeTitle ?? `${current.party} · example`}
          />
        </div>
      )}
    </div>
  );
}
