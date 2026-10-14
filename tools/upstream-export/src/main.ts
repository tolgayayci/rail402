/**
 * Exports the Stellar `upto` mechanism and its settlement contract into an x402-foundation/x402
 * checkout, and reports drift between the two.
 *
 *   pnpm upstream:export --target <x402 checkout>           report drift (exit 1 when there is any)
 *   pnpm upstream:export --target <x402 checkout> --write   write the export into the checkout
 *   pnpm upstream:export --target <x402 checkout> --json    print the report as JSON
 *
 * The contract crate and its deployment records are copied byte for byte. `packages/upto`
 * becomes `typescript/packages/mechanisms/stellar/src/upto` and its unit tests, with imports
 * mapped to the mechanism's modules and the checkout's ESLint and prettier rules applied, so the
 * checkout needs `pnpm install` in `typescript/` first. The mechanism's `package.json` exports and
 * tsup entries for `upto/*` are checked but never written, and so is everything the checkout owns
 * on its own (README, integration test, changeset, specification, e2e and examples).
 *
 * Exit codes: 0 in sync (or written), 1 drift, 2 files that cannot be exported as they are.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkoutFormatter } from "./eslint.ts";
import { applyExport, compareExport, planExport, type Comparison } from "./export.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const { values: args } = parseArgs({
  options: {
    target: { type: "string" },
    write: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help || args.target === undefined) {
  console.log("usage: pnpm upstream:export --target <x402 checkout> [--write] [--json]");
  process.exit(args.help ? 0 : 2);
}

// The real path: ESLint matches its configuration against paths below the configuration file.
const target = realpathSync(resolve(args.target));
const plan = await planExport(ROOT, target, checkoutFormatter(target));
if (plan.problems.length > 0) {
  for (const problem of plan.problems) console.error(`error: ${problem}`);
  process.exit(2);
}

let comparison = compareExport(plan, target);
if (args.write) {
  applyExport(plan, comparison, target);
  comparison = compareExport(plan, target);
}

if (args.json) console.log(JSON.stringify(comparison, null, 2));
else printReport(comparison, args.write);

const drifted = comparison.files.some((file) => file.status !== "unchanged") || comparison.wiring.length > 0;
process.exit(drifted ? 1 : 0);

function printReport(result: Comparison, wrote: boolean): void {
  const counts = new Map<string, number>();
  for (const file of result.files) {
    counts.set(file.status, (counts.get(file.status) ?? 0) + 1);
    if (file.status === "unchanged") continue;
    const origin = file.source === undefined ? "" : `  (from ${file.source})`;
    console.log(`${file.status.padEnd(8)} ${file.target}${origin}`);
  }
  for (const finding of result.wiring) console.log(`wiring   ${finding}`);
  const summary = ["unchanged", "changed", "missing", "extra"]
    .map((status) => `${counts.get(status) ?? 0} ${status}`)
    .join(", ");
  console.log(
    `${wrote ? "wrote the export; now " : ""}${summary}; ${result.wiring.length} wiring finding(s)`,
  );
}
