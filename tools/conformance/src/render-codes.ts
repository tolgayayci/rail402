/** Markdown for the error-code reference, rendered from the service's and the clients' code registries. */
import type { CodeGroup } from "@rail402.dev/service/codes";
import { cliExitStatus, type ClientCodeGroup } from "./client-codes.ts";
import { code, escape, table } from "./render-evidence.ts";

/** Prose from the registry, where backticks mark code: kept as code, the rest escaped. */
function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, index) => (index % 2 === 1 ? part : escape(part)))
    .join("");
}

export function renderCodeGroups(groups: readonly CodeGroup[]): string {
  const total = groups.reduce((sum, group) => sum + Object.keys(group.codes).length, 0);
  const sections = groups.map((group) => {
    const rows = Object.entries(group.codes).map(([name, spec]) => [
      code(name),
      String(spec.status),
      spec.retryable ? "yes" : "no",
      inline(spec.reason),
    ]);
    return [
      `## ${inline(group.title)}`,
      `${inline(group.where)} Defined in ${code(group.set)} (${code(group.package)}).`,
      table(["Code", "HTTP status", "Retryable", "Default reason"], rows),
    ].join("\n\n");
  });
  return [`${total} codes in ${groups.length} groups.`, ...sections].join("\n\n");
}

/** The client-side groups: the same tables plus the default `paid` value and the CLI exit status. */
export function renderClientCodeGroups(groups: readonly ClientCodeGroup[]): string {
  const total = groups.reduce((sum, group) => sum + Object.keys(group.codes).length, 0);
  const sections = groups.map((group) => {
    const rows = Object.entries(group.codes).map(([name, spec]) => {
      const paid = group.paid(name);
      const exit = cliExitStatus(name, paid);
      return [
        code(name),
        String(spec.status),
        spec.retryable ? "yes" : "no",
        paid === undefined ? "-" : code(paid),
        exit === undefined ? "-" : String(exit),
        inline(spec.reason),
      ];
    });
    return [
      `## ${inline(group.title)}`,
      `${inline(group.where)} Defined in ${code(group.set)} (${code(group.package)}).`,
      table(["Code", "HTTP status", "Retryable", "Paid", "CLI exit", "Default reason"], rows),
    ].join("\n\n");
  });
  return [`${total} codes in ${groups.length} groups.`, ...sections].join("\n\n");
}

/** The part of a coverage record the page shows. */
export interface CoverageView {
  readonly recordedAt: string;
  readonly commit: string;
  readonly registered: readonly string[];
  readonly exercised: {
    readonly unit: readonly string[];
    readonly integration: readonly string[];
    readonly evidence: readonly string[];
    readonly named: readonly string[];
  };
}

/**
 * Which registered codes the test suites and the recorded conformance runs produce, and why each of the
 * others is produced by neither.
 */
export function renderCoverage(
  record: CoverageView | undefined,
  justifications: Readonly<Record<string, string>>,
  registeredNow: readonly string[],
): string {
  if (record === undefined) return "No coverage has been recorded yet (`pnpm codes:coverage --write`).";
  const { unit, integration, evidence, named } = record.exercised;
  const registered = new Set(record.registered);
  const raised = new Set([...unit, ...integration, ...evidence].filter((name) => registered.has(name)));
  const exercised = new Set([...raised, ...named].filter((name) => registered.has(name)));
  const count = (codes: readonly string[]) => codes.filter((name) => registered.has(name)).length;
  const onlyNamed = named.filter((name) => registered.has(name) && !raised.has(name)).length;
  const unexercised = record.registered.filter((name) => !exercised.has(name));
  const added = registeredNow.filter((name) => !registered.has(name));
  return [
    `Recorded on ${record.recordedAt.slice(0, 10)} at commit ${code(record.commit.slice(0, 12))}: ` +
      `**${String(exercised.size)} of ${String(record.registered.length)} registered codes** are produced by a test ` +
      `or a recorded run. Raised while the suites ran: unit tests ${String(count(unit))}, integration tests ` +
      `${String(count(integration))}; reported by conformance runs ${String(count(evidence))}; named only in a test's ` +
      `assertions (refusals built as plain values, which the recorder does not see) ${String(onlyNamed)}.`,
    unexercised.length === 0
      ? "Every registered code is produced by a test or a recorded run."
      : [
          `The ${String(unexercised.length)} codes that neither produces, and why:`,
          table(
            ["Code", "Why no test or run produces it"],
            unexercised.map((name) => [
              code(name),
              inline(justifications[name] ?? "(no justification recorded)"),
            ]),
          ),
        ].join("\n\n"),
    ...(added.length === 0
      ? []
      : [
          `Registered since this record was made, not yet measured: ${added.map((name) => code(name)).join(", ")}.`,
        ]),
  ].join("\n\n");
}
