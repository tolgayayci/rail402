/**
 * Code-panel snippets. A snippet is real source text with line markers:
 *
 * - `// @step:<id>` or `// @step:<id>,<id>` at the end of a line ties the line to those swimlane
 *   steps; selecting a row of that step highlights the line.
 * - `// @hide` at the end of a line leaves the line out (imports and setup that make the file compile).
 * - `# @step:<id>` and `# @hide` do the same in shell snippets.
 *
 * Markers are removed from the shown text, with the whitespace before them. Blank lines at the edges
 * are dropped, and a run of blank lines (left by hidden lines) shows as one.
 */
import { STEP_IDS, type StepId } from "../../../src/shared/lab.ts";

export interface CodeLine {
  readonly text: string;
  readonly steps: readonly StepId[];
}

export interface Snippet {
  readonly lines: readonly CodeLine[];
}

const MARKER = /\s*(?:\/\/|#)\s*@(step:([a-z0-9,-]+)|hide)\s*$/;
const KNOWN: ReadonlySet<string> = new Set(STEP_IDS);

/** Parses a snippet's markers. Unknown step ids are an error, so a renamed step cannot go unnoticed. */
export function parseSnippet(source: string): Snippet {
  const lines: CodeLine[] = [];
  const raw = source.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  for (const line of raw) {
    const match = MARKER.exec(line);
    if (match === null) {
      lines.push({ text: line, steps: [] });
      continue;
    }
    if (match[1] === "hide") continue;
    const steps = (match[2] ?? "").split(",").filter((step) => step !== "");
    for (const step of steps) {
      if (!KNOWN.has(step)) throw new Error(`unknown step id "${step}" in a snippet marker`);
    }
    lines.push({ text: line.slice(0, match.index), steps: steps as StepId[] });
  }
  return {
    lines: trimBlankEdges(lines).filter((line, index, all) => !(isBlank(line) && isBlank(all[index - 1]))),
  };
}

/** The lines with whether each is highlighted for a step. */
export function highlight(
  snippet: Snippet,
  step: StepId | undefined,
): readonly { readonly text: string; readonly on: boolean }[] {
  return snippet.lines.map((line) => ({
    text: line.text,
    on: step !== undefined && line.steps.includes(step),
  }));
}

/** The step ids a snippet marks, in first-use order. */
export function markedSteps(snippet: Snippet): readonly StepId[] {
  const seen: StepId[] = [];
  for (const line of snippet.lines) for (const step of line.steps) if (!seen.includes(step)) seen.push(step);
  return seen;
}

/** The text of a snippet as shown, for copying. */
export function snippetText(snippet: Snippet): string {
  return snippet.lines.map((line) => line.text).join("\n");
}

function isBlank(line: CodeLine | undefined): boolean {
  return line !== undefined && line.text.trim() === "";
}

function trimBlankEdges(lines: CodeLine[]): CodeLine[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first]?.text.trim() === "") first += 1;
  while (last > first && lines[last - 1]?.text.trim() === "") last -= 1;
  return lines.slice(first, last);
}
