/**
 * Markdown for one evidence run. Output is deterministic: it depends only on the evidence file, never on
 * the clock, the network or git, so re-rendering committed evidence always reproduces the page.
 */
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import type { Evidence, EvidenceCase } from "./evidence.ts";
import { legacyBenchmark as benchmarkShape } from "./legacy.ts";
import type {
  LegacyBenchmark,
  LegacyCanonical,
  LegacyEvidence,
  LegacyLiveBazaar,
  LegacyLiveMatrix,
  LegacyUpstreamE2e,
} from "./legacy.ts";

export const REPOSITORY_URL = "https://github.com/tolgayayci/rail402";

/** Assets older evidence refers to by contract id only. */
const KNOWN_ASSETS: Readonly<Record<string, { readonly symbol: string; readonly decimals: number }>> = {
  [USDC_TESTNET_ADDRESS]: { symbol: "USDC", decimals: 7 },
  [USDC_PUBNET_ADDRESS]: { symbol: "USDC", decimals: 7 },
};

// --- markdown helpers ----------------------------------------------------------------------------

/** Inline code; the fence grows when the text itself contains backticks. */
export function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** An http(s) URL in evidence text, up to whitespace, a backtick or a `|`; trailing punctuation is trimmed. */
const URL_TEXT = /(https?:\/\/[^\s|`]*[^\s|`.,;:!?'")\]])/g;

/**
 * Plain text safe inside MDX and a table cell. URLs are set as code: escaped in plain text, a URL such
 * as `http://localhost:<port>` would be autolinked with its entities as part of the link.
 */
export function escape(text: string): string {
  return text
    .split(URL_TEXT)
    .map((part, index) =>
      index % 2 === 1
        ? code(part)
        : part.replace(/[\\`*_{}<>[\]|#]/g, (char) =>
            char === "<" ? "&lt;" : char === ">" ? "&gt;" : `\\${char}`,
          ),
    )
    .join("");
}

const IDENTIFIER = /(\/[A-Za-z][\w/.-]*\w|\b[a-z]+(?:\.[a-z]+)*[A-Z]\w*(?:\.\w+)*\b|\b__[a-z_]+\b)/g;

/**
 * A sentence from evidence as prose: capitalised, escaped, with URLs, paths and identifiers
 * (`/supported`, `payTo`, `extra.areFeesSponsored`, `__check_auth`) set as code.
 */
export function prose(text: string): string {
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return sentence
    .split(URL_TEXT)
    .map((piece, index) =>
      index % 2 === 1
        ? code(piece)
        : piece
            .split(IDENTIFIER)
            .map((part, inner) => (inner % 2 === 1 ? code(part) : escape(part)))
            .join(""),
    )
    .join("");
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function integer(value: number | bigint | string): string {
  return BigInt(typeof value === "number" ? Math.round(value) : value).toLocaleString("en-US");
}

export function day(iso: string): string {
  return iso.slice(0, 10);
}

/** An amount in base units as a decimal in whole units, without trailing zeros. */
export function units(amount: string, decimals: number): string {
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

export function commitLink(commit: string): string {
  const dirty = commit.endsWith("-dirty");
  const bare = dirty ? commit.slice(0, -"-dirty".length) : commit;
  if (!/^[0-9a-f]{40}$/.test(bare)) return code(commit);
  const link = `[${code(bare.slice(0, 7))}](${REPOSITORY_URL}/commit/${bare})`;
  return dirty ? `${link} with uncommitted changes` : link;
}

export function txLink(hash: string, explorer: string): string {
  return `[${code(`${hash.slice(0, 8)}…`)}](${explorer})`;
}

/** Package versions grouped by version, in the order the evidence lists them. */
export function packageList(packages: Readonly<Record<string, string>>): string {
  const groups = new Map<string, string[]>();
  for (const [name, version] of Object.entries(packages)) {
    groups.set(version, [...(groups.get(version) ?? []), code(name)]);
  }
  return [...groups].map(([version, names]) => `${names.join(", ")} ${version}`).join("; ");
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function codes(values: readonly string[]): string {
  return distinct(values).map(code).join(", ");
}

// --- current format ------------------------------------------------------------------------------

function caseResult(entry: EvidenceCase): string {
  if (entry.status === "skipped") return `skipped: ${escape(entry.skipReason ?? "")}`;
  const parts = [
    ...(entry.transactions ?? []).map((tx) => `tx ${txLink(tx.hash, tx.explorer)}`),
    ...(entry.rejections === undefined || entry.rejections.length === 0
      ? []
      : [codes(entry.rejections.map((rejection) => rejection.code))]),
  ];
  const detail = parts.length === 0 ? entry.status : parts.join("; ");
  return entry.status === "failed" ? `**failed**${parts.length === 0 ? "" : `: ${detail}`}` : detail;
}

/**
 * The version a run's facilitator reported on `/health`. A local process started without
 * `RAIL402_VERSION` reports `dev`; it ran from the run's own checkout, so its commit names it.
 */
export function reportedVersion(evidence: Evidence): string {
  const { mode, healthVersion } = evidence.target;
  if (mode === "local" && healthVersion === "dev") {
    return `from commit ${code(evidence.harness.commit.slice(0, 12))}`;
  }
  return `version ${code(healthVersion)}`;
}

/** A current-format run's counts and provenance table. */
export function runHeader(path: string, evidence: Evidence): string {
  const { summary } = evidence;
  const settlements = evidence.cases.flatMap((entry) => entry.transactions ?? []).length;
  const rejections = evidence.cases.flatMap((entry) => entry.rejections ?? []).length;
  const counts = [
    `**${summary.passed} of ${summary.total} cases passed**`,
    ...(summary.failed > 0 ? [`${summary.failed} failed`] : []),
    ...(summary.skipped > 0 ? [`${summary.skipped} skipped`] : []),
  ].join(", ");
  const provenance: string[][] = [
    ["Date", `${day(evidence.startedAt)} to ${day(evidence.finishedAt)}`],
    [
      "Facilitator",
      `${code(evidence.target.facilitatorUrl)} (${evidence.target.mode}), ${reportedVersion(evidence)}`,
    ],
    ["Rail402 commit", commitLink(evidence.harness.commit)],
    ...(evidence.upstream === undefined
      ? []
      : [
          [
            "Upstream",
            `${code(evidence.upstream.repository)} ${evidence.upstream.version} (${code(evidence.upstream.ref)}), commit ${code(evidence.upstream.commit)}${evidence.upstream.preMerge ? ", not yet merged upstream" : ""}`,
          ],
        ]),
    ["Packages", packageList(evidence.packages)],
    ["Command", code(evidence.command)],
  ];
  return [
    `From ${code(path)}: ${counts}, with ${settlements} settlements and ${rejections} coded rejections.`,
    table(["Field", "Value"], provenance),
  ].join("\n\n");
}

/** Any run in the current format: provenance, the case table and its counts. */
export function renderCurrent(path: string, evidence: Evidence): string {
  return [
    runHeader(path, evidence),
    table(
      ["Case", "What it proves", "Result"],
      evidence.cases.map((entry) => [code(entry.id), prose(entry.title), caseResult(entry)]),
    ),
  ].join("\n\n");
}

// --- older formats -------------------------------------------------------------------------------

export function renderLegacy(path: string, evidence: LegacyEvidence): string {
  switch (evidence.kind) {
    case "canonical":
      return legacyCanonical(path, evidence.data);
    case "live-matrix":
      return legacyLiveMatrix(path, evidence.data);
    case "live-bazaar":
      return legacyLiveBazaar(path, evidence.data);
    case "benchmark":
      return legacyBenchmark(path, evidence.data);
    case "upstream-e2e":
      return legacyUpstreamE2e(path, evidence.data);
  }
}

function legacyCanonical(path: string, run: LegacyCanonical): string {
  const { settlement, balances } = run;
  const asset = KNOWN_ASSETS[settlement.asset];
  const amount = `${code(settlement.amount)} base units of ${code(settlement.asset)}${
    asset === undefined ? "" : ` (${units(settlement.amount, asset.decimals)} ${asset.symbol})`
  }`;
  const lost = BigInt(balances.buyer.before) - BigInt(balances.buyer.after);
  const gained = BigInt(balances.seller.after) - BigInt(balances.seller.before);
  const price = BigInt(settlement.amount);
  const conclusion =
    lost === price && gained === price
      ? "The buyer lost exactly the price and the seller gained exactly the price: the facilitator paid the fee and moved no funds of its own."
      : `The buyer's balance fell by ${integer(lost)} and the seller's rose by ${integer(gained)} base units, against a price of ${integer(price)}.`;
  return [
    `From ${code(path)}:`,
    table(
      ["Field", "Value"],
      [
        ["Date", day(run.date)],
        [
          "Facilitator",
          `${code(run.facilitator)}, version ${code(run.facilitatorVersion)} (from ${code("/health")})`,
        ],
        ["Rail402 commit", commitLink(run.rail402Commit)],
        ["Packages", packageList(run.packages)],
        // Runs in this format were recorded by a script that tools/conformance/src/canonical.ts replaced.
        ["Command", `${code(run.command)} (a script since replaced by ${code("canonical.ts")})`],
        [
          "Result",
          `${code(run.request.url)} returned ${code(String(run.request.status))} after payment, ${integer(run.request.elapsedMs)} ms end to end`,
        ],
        [
          "Transaction",
          `[${code(settlement.transaction)}](${settlement.explorer}), ledger ${settlement.ledger}`,
        ],
        ["Amount", amount],
        [
          "Fee charged",
          `${integer(settlement.feeChargedStroops)} stroops, paid by the facilitator's sponsor`,
        ],
        [
          "Balances",
          `buyer ${code(balances.buyer.before)} → ${code(balances.buyer.after)}; seller ${code(balances.seller.before)} → ${code(balances.seller.after)}`,
        ],
      ],
    ),
    conclusion,
  ].join("\n\n");
}

function legacyLiveMatrix(path: string, run: LegacyLiveMatrix): string {
  const { summary } = run;
  return [
    `From ${code(path)} (${day(run.date)}, facilitator ${code(run.facilitator)}, version ${code(run.facilitatorVersion)}): **${summary.passed} of ${summary.cases} cases passed**, with ${summary.settlements} settlements and ${summary.rejections} coded rejections.`,
    table(
      ["Case", "What it proves", "Result"],
      run.cases.map((entry) => {
        const parts = [
          ...entry.transactions.map((tx) => `tx ${txLink(tx.hash, tx.explorer)}`),
          ...(entry.rejections.length === 0 ? [] : [codes(entry.rejections.map((r) => r.code))]),
        ];
        const detail = parts.length === 0 ? "passed" : parts.join("; ");
        return [code(entry.id), prose(entry.criterion), entry.passed ? detail : `**failed**: ${detail}`];
      }),
    ),
    "The evidence file holds every transaction hash, fee, rejection code and reason.",
  ].join("\n\n");
}

function bazaarOutcome(entry: LegacyLiveBazaar["cases"][number]): string {
  const outcomes = entry.settlements.map((settlement) => settlement.outcome);
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.code);
  const dropped = distinct(outcomes.flatMap((outcome) => outcome.dropped ?? []));
  const listings = distinct(outcomes.flatMap((outcome) => outcome.listingId ?? [])).length;
  let detail: string;
  if (rejected.length > 0) {
    detail = codes(rejected);
  } else if (dropped.length > 0) {
    detail = `${code(`dropped: [${dropped.join(", ")}]`)}; the payment settled`;
  } else if (listings > 1) {
    detail = countedOutcomes(entry);
  } else if (
    entry.listing !== undefined &&
    entry.versions !== undefined &&
    entry.listing.state !== "published"
  ) {
    detail = `listing ${code(entry.listing.state)}, never published`;
  } else if (entry.listing !== undefined && entry.versions !== undefined) {
    detail = `versions ${entry.versions.map((version) => code(version.cause)).join(" → ")}; trust ${code(entry.listing.trust)}`;
  } else if (outcomes.length > 0) {
    detail = countedOutcomes(entry);
  } else {
    detail = "passed";
  }
  return entry.passed ? detail : `**failed**: ${detail}`;
}

/** Outcome codes with their counts, and how many transactions and listings they involved. */
function countedOutcomes(entry: LegacyLiveBazaar["cases"][number]): string {
  const outcomes = entry.settlements.map((settlement) => settlement.outcome);
  const counted = distinct(outcomes.map((outcome) => outcome.code)).map((outcomeCode) => {
    const count = outcomes.filter((outcome) => outcome.code === outcomeCode).length;
    return count === 1 ? code(outcomeCode) : `${code(outcomeCode)} ×${count}`;
  });
  const transactions = distinct(entry.settlements.map((settlement) => settlement.transaction)).length;
  const listings = distinct(outcomes.flatMap((outcome) => outcome.listingId ?? [])).length;
  return `${counted.join(", ")}; ${plural(transactions, "transaction")}, ${plural(listings, "listing")}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function legacyLiveBazaar(path: string, run: LegacyLiveBazaar): string {
  const { summary } = run;
  return [
    `From ${code(path)} (${day(run.date)}, facilitator ${code(run.facilitator)}, seller ${code(run.seller)}): **${summary.passed} of ${summary.cases} cases passed**, with ${summary.settlements} settlements.`,
    table(
      ["Case", "What it proves", "Outcome"],
      run.cases.map((entry) => [code(entry.id), prose(entry.rule), bazaarOutcome(entry)]),
    ),
    "The evidence file holds every transaction hash and decoded outcome.",
  ].join("\n\n");
}

/**
 * A benchmark run in the current format, as the same table: the workload is in `config` and each case
 * holds one facilitator's measurements. Falls back to the generic case table when a case has none.
 */
export function renderBenchmark(path: string, evidence: Evidence): string {
  const { config } = evidence;
  const run = benchmarkShape.safeParse({
    run: "benchmark",
    network: evidence.network,
    window: { started: evidence.startedAt, finished: evidence.finishedAt },
    harnessCommit: evidence.harness.commit,
    packages: evidence.packages,
    command: evidence.command,
    workload: {
      asset: config["asset"],
      amountBaseUnits: config["amountBaseUnits"],
      samples: config["samples"],
      smartAccountSamples: config["smartAccountSamples"],
      concurrent: { batches: config["batches"], size: config["batchSize"] },
    },
    results: evidence.cases.map((entry) => entry.observations?.["result"]),
  });
  return run.success ? legacyBenchmark(path, run.data) : renderCurrent(path, evidence);
}

function legacyBenchmark(path: string, run: LegacyBenchmark): string {
  const ms = (value: number) => integer(value);
  const pair = (a: number, b: number, unit: string) => `${ms(a)} / ${ms(b)} ${unit}`;
  const columns = run.results.map((result) =>
    code(new URL(result.facilitator).host + new URL(result.facilitator).pathname.replace(/\/$/, "")),
  );
  const { concurrent } = run.workload;
  const rows: string[][] = [
    [
      "Network round trip (`GET /supported`) p50",
      ...run.results.map((r) => `${ms(r.networkRoundTripMs.p50)} ms`),
    ],
    [
      `${code("/verify")} p50 / p95 (${run.workload.samples})`,
      ...run.results.map((r) => pair(r.verify.latencyMs.p50, r.verify.latencyMs.p95, "ms")),
    ],
    [
      `${code("/settle")} to confirmed, ${code("G…")} payer, p50 / p95 (${run.workload.samples})`,
      ...run.results.map((r) => pair(r.settle.latencyMs.p50, r.settle.latencyMs.p95, "ms")),
    ],
    [
      `${code("/settle")} to confirmed, ${code("C…")} payer, p50 / p95 (${run.workload.smartAccountSamples})`,
      ...run.results.map((r) =>
        pair(r.settleSmartAccount.latencyMs.p50, r.settleSmartAccount.latencyMs.p95, "ms"),
      ),
    ],
    [
      "Ledgers to confirm, p50 / p95",
      ...run.results.map(
        (r) => `${ms(r.settle.ledgersToConfirm.p50)} / ${ms(r.settle.ledgersToConfirm.p95)}`,
      ),
    ],
    [
      `Sponsor fee per settlement, ${code("G…")} / ${code("C…")} payer, p50`,
      ...run.results.map((r) =>
        pair(r.settle.sponsorFeeStroops.p50, r.settleSmartAccount.sponsorFeeStroops.p50, "stroops"),
      ),
    ],
    [
      `${concurrent.batches} batches of ${concurrent.size} concurrent settlements`,
      ...run.results.map((r) => {
        if (r.concurrent === undefined) return "not run";
        const batches = r.concurrent.batches;
        const size = batches.reduce((sum, batch) => sum + batch.size, 0);
        const settled = batches.reduce((sum, batch) => sum + batch.succeeded, 0);
        const unique = batches.reduce((sum, batch) => sum + batch.uniqueTransactions, 0);
        const walls = batches.map((batch) => batch.wallMs / 1000);
        return `${settled} of ${size} settled, ${unique} distinct transactions, ${Math.min(...walls).toFixed(1)}–${Math.max(...walls).toFixed(1)} s per batch`;
      }),
    ],
    ["Failures", ...run.results.map((r) => String(r.failures.length))],
  ];
  const asset = KNOWN_ASSETS[run.workload.asset];
  return [
    `From ${code(path)}, ${run.window.started.slice(0, 16).replace("T", " ")}–${run.window.finished.slice(11, 16)} UTC, every payment ${run.workload.amountBaseUnits} base units of ${asset === undefined ? code(run.workload.asset) : `testnet ${asset.symbol}`}, Rail402 commit ${commitLink(run.harnessCommit)}:`,
    table(["Metric", ...columns], rows),
  ].join("\n\n");
}

function legacyUpstreamE2e(path: string, run: LegacyUpstreamE2e): string {
  const { summary } = run;
  const servers = distinct(run.results.map((result) => result.server));
  return [
    `From ${code(path)}:`,
    table(
      ["Field", "Value"],
      [
        ["Date", day(run.run)],
        [
          "Upstream",
          `${code(run.upstream.repository)} ${run.upstream.version}, commit ${code(run.upstream.commit)}`,
        ],
        ["Rail402 commit", commitLink(run.rail402.commit + (run.rail402.uncommittedChanges ? "-dirty" : ""))],
        ["Command", code(run.command)],
        [
          "Result",
          `**${summary.passed} of ${summary.total} passed**, exit code ${run.exitCode}, ${summary.durationMinutes} minutes`,
        ],
        ["Bazaar discovery validation", run.bazaarDiscoveryValidation],
      ],
    ),
    table(
      ["Server", "Clients", "Flows", "Passed"],
      servers.map((server) => {
        const results = run.results.filter((result) => result.server === server);
        const clients = distinct(results.map((result) => result.client.split("/").pop() ?? result.client));
        const flows = distinct(results.map((result) => result.paymentFlow));
        const passed = results.filter((result) => result.passed).length;
        return [code(server), clients.join(", "), flows.join(", "), `${passed} / ${results.length}`];
      }),
    ),
    "Each result in the file carries its settlement transaction hash.",
  ].join("\n\n");
}
