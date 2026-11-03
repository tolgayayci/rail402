import type { RegistrySnapshot } from "@rail402.dev/x402-index";
import type { ReportDocument } from "../../api/report.ts";
import {
  body,
  copyButton,
  externalLink,
  h,
  layout,
  stat,
  tierBadge,
  type Child,
  type LayoutOptions,
} from "../components.ts";
import { assetName, decimalAmount, groupThousands, shortened, utc, type NetworkView } from "../format.ts";
import { displayText } from "../text.ts";
import type { NetworkWindowDocument } from "../../window/window.ts";

type Totals = ReportDocument["aggregates"]["headline"];

export interface EcosystemContext {
  readonly layout: Omit<LayoutOptions, "title" | "path" | "section">;
  readonly registry: RegistrySnapshot;
  /** Where service availability is reported. */
  readonly statusUrl: string | undefined;
  /** The base for links to the report's JSON and manifest (empty on the site itself). */
  readonly apiOrigin: string;
}

type Assets = ReportDocument["assets"];

function volumeList(
  report: { readonly network: ReportDocument["network"]; readonly assets: Assets },
  totals: Totals,
): Child {
  const entries = Object.entries(totals.volume);
  if (entries.length === 0) return h("p", { class: "muted" }, "No volume.");
  return h(
    "ul",
    null,
    entries.map(([contract, atomic]) => {
      const asset = report.assets[contract];
      return h(
        "li",
        null,
        asset?.verified === true && asset.code !== null
          ? [
              h("strong", null, decimalAmount(atomic)),
              ` ${assetName(report.network, contract, asset.code, asset.issuer)} `,
              h("span", { class: "badge verified" }, "verified"),
              " ",
              h(
                "span",
                { class: "muted" },
                "issuer ",
                h(
                  "span",
                  { class: "mono", title: displayText(asset.issuer ?? "", 56) },
                  shortened(displayText(asset.issuer ?? "", 56)),
                ),
                ", contract ",
                h(
                  "span",
                  { class: "mono", title: displayText(contract, 56) },
                  shortened(displayText(contract, 56)),
                ),
              ),
            ]
          : [
              h("strong", null, atomic),
              " atomic units of custom token ",
              h("span", { class: "mono full" }, displayText(contract, 56)),
            ],
      );
    }),
  );
}

function totalsBlock(report: ReportDocument, totals: Totals): Child[] {
  return [
    h(
      "div",
      { class: "stats framed" },
      stat("Payments", groupThousands(totals.payments)),
      stat("Distinct payers", groupThousands(totals.payers)),
      stat("Distinct sellers", groupThousands(totals.sellers)),
    ),
    h("h3", { class: "volume" }, "Volume per asset"),
    volumeList(report, totals),
  ];
}

function breakdown(view: NetworkView, registry: RegistrySnapshot, report: ReportDocument): Child {
  const rows = Object.entries(report.aggregates.byFacilitator);
  const attributed = rows.filter(([id]) => registry.facilitator(id)?.tier !== "rail402-beta");
  if (attributed.length === 0) return h("p", { class: "muted" }, "No attributed settlements in this range.");
  return h(
    "div",
    { class: "table-scroll" },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col" }, "Facilitator"),
          h("th", { scope: "col" }, "Tier"),
          h("th", { scope: "col", class: "num" }, "Payments"),
          h("th", { scope: "col", class: "num" }, "Payers"),
          h("th", { scope: "col", class: "num" }, "Sellers"),
        ),
      ),
      h(
        "tbody",
        null,
        attributed.map(([id, totals]) => {
          const entry = registry.facilitator(id);
          return h(
            "tr",
            null,
            h(
              "td",
              null,
              h(
                "a",
                { href: `${view.prefix}/facilitator/${displayText(id, 63)}` },
                displayText(entry?.name ?? id, 100),
              ),
              entry?.sharedRelayer === true ? h("span", { class: "muted" }, " (shared relayer)") : null,
            ),
            h("td", null, tierBadge(entry?.tier ?? "facilitator")),
            h("td", { class: "num" }, groupThousands(totals.payments)),
            h("td", { class: "num" }, groupThousands(totals.payers)),
            h("td", { class: "num" }, groupThousands(totals.sellers)),
          );
        }),
      ),
    ),
  );
}

/** Attributed payments per UTC day as columns, with every value in each column's title and in a table. */
function dailyChart(report: ReportDocument): Child {
  const days = Object.entries(report.aggregates.daily);
  if (days.length === 0) return null;
  const width = 720;
  const height = 160;
  const top = 12;
  const bottom = 24;
  const max = Math.max(1, ...days.map(([, day]) => day.headline));
  const slot = width / days.length;
  const bar = Math.max(1, Math.min(28, slot - 2));
  return h(
    "figure",
    null,
    h(
      "svg",
      {
        class: "chart",
        viewBox: `0 0 ${String(width)} ${String(height)}`,
        role: "img",
        "aria-label": `Attributed x402 payments per day, ${days[0]?.[0] ?? ""} to ${days.at(-1)?.[0] ?? ""}; maximum ${String(max)} in a day.`,
      },
      h("line", { class: "axis", x1: 0, x2: width, y1: height - bottom, y2: height - bottom }),
      days.map(([day, counts], index) => {
        const barHeight = ((height - top - bottom) * counts.headline) / max;
        return h(
          "rect",
          {
            class: "bar",
            x: (index * slot + (slot - bar) / 2).toFixed(1),
            y: (height - bottom - barHeight).toFixed(1),
            width: bar.toFixed(1),
            height: barHeight.toFixed(1),
            rx: 2,
          },
          h("title", null, `${day}: ${String(counts.headline)} attributed payments`),
        );
      }),
      h("text", { x: 0, y: height - 6 }, days[0]?.[0] ?? ""),
      h("text", { x: width, y: height - 6, "text-anchor": "end" }, days.at(-1)?.[0] ?? ""),
      h("text", { x: 0, y: top - 2 }, `max ${String(max)}/day`),
    ),
    h(
      "details",
      null,
      h("summary", null, "Daily values as a table"),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          null,
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", { scope: "col" }, "Day (UTC)"),
              h("th", { scope: "col", class: "num" }, "Attributed"),
              h("th", { scope: "col", class: "num" }, "Unattributed shaped (apart)"),
            ),
          ),
          h(
            "tbody",
            null,
            days.map(([day, counts]) =>
              h(
                "tr",
                null,
                h("td", null, day),
                h("td", { class: "num" }, groupThousands(counts.headline)),
                h("td", { class: "num" }, groupThousands(counts.unattributedShaped)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Payments, payers, sellers and volume of one tier as a table row. */
function tierRow(window: NetworkWindowDocument, label: Child, totals: Totals): Child {
  return h(
    "tr",
    null,
    h("th", { scope: "row" }, label),
    h("td", { class: "num" }, groupThousands(totals.payments)),
    h("td", { class: "num" }, groupThousands(totals.payers)),
    h("td", { class: "num" }, groupThousands(totals.sellers)),
    h("td", null, volumeList(window, totals)),
  );
}

/**
 * The network-wide block: a full scan of a recent window, by tier, with the window stated and the command
 * that rebuilds it. Shown only when the window job has published one.
 */
function networkWideSection(context: EcosystemContext, window: NetworkWindowDocument): Child {
  const view = context.layout.view;
  const span = `ledgers ${groupThousands(window.window.from)} to ${groupThousands(window.window.to)}, closed ${utc(window.window.firstClosedAt)} to ${utc(window.window.lastClosedAt)}`;
  return h(
    "section",
    { class: "card", "aria-labelledby": "network-wide" },
    h("h2", { id: "network-wide" }, "Network-wide (sampled window)"),
    h(
      "p",
      { class: "notice", role: "note" },
      `A sample, not lifetime totals: every ledger of one recent window of about ${String(window.window.hours)} hours (${span}; ${groupThousands(window.window.ledgers)} ledgers), read in full from the public Stellar data lake under the same rules. Unlike the totals below, it counts payments of every facilitator, registered or not. Computed ${utc(window.generatedAt)}.`,
    ),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { scope: "col" }, "Settled by"),
            h("th", { scope: "col", class: "num" }, "Payments"),
            h("th", { scope: "col", class: "num" }, "Payers"),
            h("th", { scope: "col", class: "num" }, "Sellers"),
            h("th", { scope: "col" }, "Volume per asset"),
          ),
        ),
        h(
          "tbody",
          null,
          tierRow(window, "The hosted Rail402 service", window.tiers.rail402),
          tierRow(window, "Other registered facilitators", window.tiers.otherRegistered),
          tierRow(window, "Unregistered or unattributed (x402-shaped)", window.tiers.unattributed),
        ),
      ),
    ),
    h(
      "p",
      { class: "muted" },
      "Unregistered or unattributed rows have the exact shape of an x402 settlement but no registry account submitted them: facilitators outside the registry, smart-wallet relays, test scripts, and transfers that only look like x402 payments. ",
      `Self-payments (${groupThousands(window.selfPayments.payments)}), concluded beta calls (${groupThousands(window.rail402Beta.payments)}) and failed attempts (${groupThousands(window.failedAttempts)}) are kept out of these rows.`,
      window.sharedRelayerPayments === 0
        ? ""
        : ` ${groupThousands(window.sharedRelayerPayments)} of the other registered payments went through shared relayers, which also relay transfers that are not x402 payments.`,
    ),
    h(
      "dl",
      { class: "facts" },
      h("dt", null, "Manifest"),
      h(
        "dd",
        null,
        "SHA-256 ",
        h("code", { class: "full" }, window.manifestSha256),
        " · ",
        h("a", { href: `${context.apiOrigin}/api/v1/${view.slug}/network-window/manifest` }, "manifest.json"),
      ),
      h("dt", null, "Rules and registry"),
      h("dd", null, `v${window.rulesVersion} · ${window.registryVersion}`),
    ),
    h(
      "p",
      null,
      "Rebuild this exact window from the public data lake; the command prints the manifest's SHA-256, and equal hashes mean identical results:",
    ),
    h("pre", { class: "command" }, window.rebuildCommand),
    copyButton(window.rebuildCommand, "command"),
  );
}

/** Why ledgers after the covered range are left out of the report. */
function detachedText(report: ReportDocument): string {
  const from = groupThousands(report.detachedFrom ?? 0);
  return report.coverageStop === "failed"
    ? `Ledger ${from} failed an integrity check; the report stops before it until it is read again.`
    : `Ledger ${from} is still being read; the report covers the ledgers before it.`;
}

/** The notice of a report whose manifest a rebuild would not match yet. */
function notReproducibleText(report: ReportDocument): string {
  if (report.failedLedgers.length > 0) {
    return "A ledger of this epoch failed an integrity check; the totals below cover only the ledgers before it until it is read again.";
  }
  return `Some rows in this range were attributed under registry ${report.rowRegistryVersions.join(", ")}; they are being indexed again under ${report.registryVersion}.`;
}

/** The Ecosystem Report body for one network, shared by the page and the snapshot export. */
export function ecosystemContent(context: EcosystemContext, report: ReportDocument | undefined): Child[] {
  const view = context.layout.view;
  const heading = [
    h("p", { class: "eyebrow" }, `${view.label} · Ecosystem report`),
    h("h1", null, `x402 on Stellar ${view.label.toLowerCase()}`),
  ];
  const availability = h(
    "section",
    { class: "card", "aria-labelledby": "availability" },
    h("h2", { id: "availability" }, "Service availability"),
    h(
      "p",
      null,
      "This report counts payments settled on chain. It says nothing about whether a service is up right now. ",
      context.statusUrl === undefined
        ? "Each facilitator reports its own availability."
        : [
            "Current availability of the hosted Rail402 service: ",
            externalLink(context.statusUrl, "status page"),
            ".",
          ],
    ),
  );
  if (report === undefined) {
    return [
      ...heading,
      h(
        "p",
        { class: "notice", role: "status" },
        `No ${view.label.toLowerCase()} ledgers are indexed yet, so there is no report for this network.`,
      ),
      availability,
    ];
  }
  const agg = report.aggregates;
  const rowsCurrent = report.reproducible;
  return [
    ...heading,
    h(
      "p",
      { class: "muted" },
      `Ledgers ${groupThousands(report.range.from)} to ${groupThousands(report.range.to)} of epoch ${report.epoch}, computed ${utc(report.generatedAt)}. `,
      `Registry scope: the ${groupThousands(report.discovery.ledgersRead)} ledgers in this range that hold transactions of the registry's facilitator accounts or upto contracts, each read in full and verified.`,
      report.detachedFrom === null ? "" : ` ${detachedText(report)}`,
    ),
    rowsCurrent ? null : h("p", { class: "notice", role: "status" }, notReproducibleText(report)),
    h(
      "section",
      { class: "card", "aria-labelledby": "rail402" },
      h("h2", { id: "rail402" }, "Settled by the hosted Rail402 service"),
      h(
        "p",
        { class: "muted" },
        "Payments whose fee payer or source is an account of the hosted Rail402 facilitator in that ledger (its sponsor, channel accounts and upto settlement authority). Self-hosted Rail402 instances are not counted here.",
      ),
      ...totalsBlock(report, agg.rail402),
    ),
    report.networkWide === undefined || report.networkWide === null
      ? null
      : networkWideSection(context, report.networkWide),
    h(
      "section",
      { class: "card", "aria-labelledby": "registered" },
      h("h2", { id: "registered" }, "Registered facilitators (Rail402 included)"),
      h(
        "p",
        { class: "muted" },
        "Every settlement attributed to a facilitator in the public registry, Rail402 included. Self-payments, unattributed look-alikes and the concluded beta are not in these numbers.",
      ),
      h(
        "p",
        { class: "notice", role: "note" },
        "This is not every x402 payment on the network: the index reads only the ledgers that hold transactions of registered facilitator accounts and upto contracts, so payments settled by a facilitator outside the registry are not counted here.",
      ),
      ...totalsBlock(report, agg.headline),
      agg.headlineSharedRelayer.payments === 0
        ? null
        : h(
            "p",
            { class: "notice", role: "note" },
            `Of these, ${groupThousands(agg.headlineSharedRelayer.payments)} payments went through shared relayers, which also relay transfers that are not x402 payments; such rows may not be x402 payments.`,
          ),
      h("h3", null, "By facilitator"),
      breakdown(view, context.registry, report),
      h("h3", null, "By scheme"),
      h(
        "ul",
        null,
        Object.entries(agg.byScheme).map(([scheme, totals]) =>
          h(
            "li",
            null,
            h("code", null, displayText(scheme, 16)),
            `: ${groupThousands(totals.payments)} payments`,
          ),
        ),
      ),
      h("h3", null, "Per day"),
      dailyChart(report),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "shaped" },
      h("h2", { id: "shaped" }, "Unattributed x402-shaped (not counted above)"),
      h(
        "p",
        { class: "notice", role: "note" },
        "These transactions have the exact shape of an x402 settlement, but no registered facilitator account submitted them. Smart-wallet relays, test scripts and unknown facilitators produce the same shape, so they are shown apart and never added to the totals above.",
      ),
      h(
        "p",
        { class: "notice", role: "status" },
        "Not measured across the network here. This report reads only the ledgers that hold transactions of registry accounts and upto contracts, so it counts upto look-alikes through registry contracts but sees exact-scheme look-alikes only when they share a ledger with a registry transaction. Every look-alike of the range is counted only by a full-scan rebuild from the public data lake:",
      ),
      h("pre", { class: "command" }, report.auditCommand),
      copyButton(report.auditCommand, "command"),
      h(
        "p",
        { class: "muted" },
        "Found in the ledgers read (a lower bound, not a count of the whole network):",
      ),
      ...totalsBlock(report, agg.unattributedShaped),
      h(
        "p",
        { class: "muted" },
        `Self-payments (payer and seller are the same account), in every tier, also stay out of the totals: ${groupThousands(agg.selfPayments.payments)}.`,
      ),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "beta" },
      h("h2", { id: "beta" }, "Concluded Rail402 beta"),
      h(
        "p",
        null,
        "The Rail402 beta ran from August to October 2026 and ended on 22 October 2026. Its own explorer's totals came from a live database with no defined ledger range and mixed attributed and heuristic rows; they cannot be reproduced and are superseded by these rules. Its settlement contracts cannot be changed and anyone can still call them, so the registry counts calls through them only up to the beta's end, whoever submitted them. They emit no event of their own, so discovery finds them by the token approve events that name a beta contract as the spender, which each beta settlement carries in the same transaction. Only beta transactions found on chain in this range are counted here:",
      ),
      ...totalsBlock(report, agg.rail402Beta),
    ),
    h(
      "section",
      { class: "card", "aria-labelledby": "method" },
      h("h2", { id: "method" }, "Methodology and rebuild"),
      h(
        "dl",
        { class: "facts" },
        h("dt", null, "Indexing rules"),
        h(
          "dd",
          null,
          `v${report.rulesVersion} · `,
          h("a", { href: `${context.apiOrigin}/methodology` }, "what each check means"),
        ),
        h("dt", null, "Registry"),
        h(
          "dd",
          null,
          `${report.registryVersion} · SHA-256 `,
          h("code", { class: "full" }, report.registrySha256),
        ),
        h("dt", null, "Manifest"),
        h(
          "dd",
          null,
          "SHA-256 ",
          h("code", { class: "full" }, report.manifestSha256),
          " · ",
          h("a", { href: `${context.apiOrigin}/api/v1/${view.slug}/manifest` }, "manifest.json"),
          " · ",
          h("a", { href: `${context.apiOrigin}/api/v1/${view.slug}/report` }, "report JSON"),
        ),
        h("dt", null, "Failed attempts"),
        h("dd", null, `${groupThousands(agg.failedAttempts)} (never counted)`),
        h("dt", null, "Ledgers read"),
        h(
          "dd",
          null,
          `${groupThousands(report.discovery.ledgersRead)} selected by ${report.discovery.source} discovery over ${groupThousands(report.discovery.routes)} registry routes; bytes from the data lake ${groupThousands(report.discovery.bytes.lake)}, from RPC ${groupThousands(report.discovery.bytes.rpc)}, each verified against its own hashes. ${groupThousands(report.discovery.ledgersWithoutAttributedRow)} of them held no attributed row; their transactions count only in the lower-bound sections.`,
        ),
        h("dt", null, "Near misses (in the ledgers read)"),
        h(
          "dd",
          null,
          Object.keys(agg.excluded).length === 0
            ? "none"
            : Object.entries(agg.excluded).map(([reason, count]) => [
                h("code", null, displayText(reason, 40)),
                ` ${groupThousands(count)} `,
              ]),
        ),
      ),
      h(
        "p",
        null,
        "Anyone can recompute these numbers from the public Stellar data lake, with no account, no discovery service and no access to this site: save the manifest, then run the command. It reads the ledgers the manifest lists and prints the manifest's SHA-256; equal hashes mean identical results:",
      ),
      h("pre", { class: "command" }, report.rebuildCommand),
      copyButton(report.rebuildCommand, "command"),
      h(
        "p",
        null,
        "To check that discovery missed nothing, rebuild every ledger of the range: its rail402, facilitator and beta rows must equal this report's.",
      ),
      report.reproducible
        ? null
        : h(
            "p",
            { class: "notice", role: "status" },
            "Until the notice above clears, this manifest's totals can differ from a rebuild's.",
          ),
    ),
    availability,
  ];
}

export function ecosystemPage(context: EcosystemContext, report: ReportDocument | undefined): string {
  return layout(
    {
      ...context.layout,
      section: "ecosystem",
      title: `Ecosystem report (${context.layout.view.label})`,
      path: "/ecosystem",
      description:
        "x402 payments on Stellar: Rail402-settled, settled by registered facilitators, and unattributed look-alikes, each apart, rebuildable from public ledgers.",
    },
    body(...ecosystemContent(context, report)),
  );
}
