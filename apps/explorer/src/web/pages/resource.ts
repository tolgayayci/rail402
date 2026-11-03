import type { SettlementRow } from "@rail402.dev/x402-index";
import type { Answer, Listing, ListingVersion, UsageAnswer } from "../bazaar.ts";
import {
  amountText,
  badge,
  body,
  copyButton,
  h,
  layout,
  monogram,
  note,
  pageHead,
  panel,
  rows,
  row,
  shortAddress,
  stat,
  table,
  txLink,
  type Child,
} from "../components.ts";
import { ago, day, decimalAmount, groupThousands, shortKey } from "../format.ts";
import { displayText } from "../text.ts";
import { listingPrice, verifiedAsset, type PageContext } from "./context.ts";

export interface ResourceModel {
  readonly listing: Listing;
  readonly usage: UsageAnswer;
  readonly versions: Answer<readonly ListingVersion[]>;
  /** The indexed settlements of the usage's recent transactions. */
  readonly recent: readonly SettlementRow[];
  /** The seller's other listings (for its card), and the payments it received on the ledger. */
  readonly sellerListings: number | undefined;
  readonly sellerPayments: number | undefined;
  readonly sellerName: string;
}

const MAX_JSON = 4_000;

/** Untrusted JSON as indented text, bounded; nothing in it is ever markup. */
function json(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
  return displayText(text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}\n…` : text, MAX_JSON + 2);
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A listing's example input as string pairs, by kind (query, path, body, MCP arguments). */
function examples(
  listing: Listing,
): { readonly kind: string; readonly pairs: readonly [string, string][] }[] {
  const input = isObject(listing.input) ? listing.input : {};
  const groups: [string, unknown][] = [
    ["path", input["pathParams"]],
    ["query", input["queryParams"]],
    ["body", input["body"]],
    ["argument", input["arguments"] ?? input["args"]],
  ];
  return groups.flatMap(([kind, value]) => {
    if (!isObject(value)) return [];
    const pairs = Object.entries(value)
      .slice(0, 20)
      .map(([key, entry]): [string, string] => [
        displayText(key, 64),
        displayText(typeof entry === "string" ? entry : JSON.stringify(entry), 200),
      ]);
    return pairs.length === 0 ? [] : [{ kind, pairs }];
  });
}

/** The URL a call example uses: the listing's resource with its example path and query filled in. */
export function exampleUrl(listing: Listing): string {
  const groups = examples(listing);
  const path = new Map(groups.find((group) => group.kind === "path")?.pairs ?? []);
  const query = groups.find((group) => group.kind === "query")?.pairs ?? [];
  let url = listing.resource.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
    encodeURIComponent(path.get(name) ?? whole),
  );
  if (query.length > 0 && !url.includes("?")) {
    url += `?${new URLSearchParams(query).toString()}`;
  }
  return displayText(url, 1_000);
}

/** A value as one shell word: bare when it holds only safe characters, else single-quoted. */
export const shellQuote = (value: string) =>
  /^[A-Za-z0-9._:/=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/** The price in whole units, as `--max` and `maxAmount` take it. */
function maxAmount(context: PageContext, listing: Listing): string | undefined {
  return verifiedAsset(context, listing.asset) === undefined
    ? undefined
    : decimalAmount(listing.amount).replaceAll(",", "");
}

/** Copy-paste ways to call a listing: the CLI, TypeScript, the MCP server and the Playground. */
function callIt(context: PageContext, listing: Listing): Child {
  const view = context.layout.view;
  const max = maxAmount(context, listing) ?? "<max>";
  const code = verifiedAsset(context, listing.asset);
  const network = view.network;
  const pubnet = view.slug === "pubnet" ? "--network stellar:pubnet " : "";
  const args = examples(listing).find((group) => group.kind === "argument")?.pairs ?? [];
  const argsJson = JSON.stringify(Object.fromEntries(args));
  const url = exampleUrl(listing);
  const cli =
    listing.type === "mcp"
      ? `rail402 ${pubnet}pay ${shellQuote(listing.resource)} \\\n    --tool ${shellQuote(listing.toolName ?? "")} --args ${shellQuote(argsJson)} \\\n    --max ${shellQuote(max)}`
      : `rail402 ${pubnet}pay ${shellQuote(url)}${listing.method !== undefined && listing.method !== "GET" ? ` --method ${shellQuote(listing.method)}` : ""} \\\n    --max ${shellQuote(max)}`;
  const typescript =
    listing.type === "http" && listing.scheme === "exact" && (listing.method ?? "GET") === "GET"
      ? [
          'import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";',
          'import { createEd25519Signer } from "@x402/stellar";',
          'import { ExactStellarScheme } from "@x402/stellar/exact/client";',
          "",
          `const NETWORK = "${network}";`,
          "const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {",
          "  schemes: [{ network: NETWORK, client: new ExactStellarScheme(createEd25519Signer(process.env.BUYER_SECRET!, NETWORK)) }],",
          "});",
          `const response = await fetchWithPayment(${JSON.stringify(url)});`,
          "console.log(response.status, await response.json());",
        ].join("\n")
      : [
          'import { createBuyer } from "@rail402.dev/sdk";',
          "",
          `const buyer = await createBuyer({ network: "${network}", signer: { secretFile: "~/.config/rail402/keys/stellar-${view.slug}.key" } });`,
          listing.type === "mcp"
            ? `const result = await buyer.pay(\n  { kind: "mcp", url: ${JSON.stringify(listing.resource)}, toolName: ${JSON.stringify(listing.toolName ?? "")}, arguments: ${argsJson} },\n  { maxAmount: { amount: "${max}" } },\n);`
            : `const result = await buyer.pay(\n  { kind: "http", url: ${JSON.stringify(url)} },\n  { maxAmount: { amount: "${max}" } },\n);`,
          "console.log(result.payment?.transaction);",
        ].join("\n");
  const mcp = JSON.stringify(
    {
      tool: "pay_and_call",
      arguments: {
        listingId: listing.id,
        spendingCap: { amount: max },
        ...(listing.type === "mcp" ? { arguments: Object.fromEntries(args) } : {}),
      },
    },
    null,
    2,
  );
  const tab = (id: string, label: string) =>
    h("button", { type: "button", role: "tab", "data-tab": id, "aria-selected": "false" }, label);
  const tabPanel = (id: string, label: string, ...content: Child[]) =>
    h("div", { class: "tabpanel", role: "tabpanel", "data-panel": id }, h("h3", null, label), ...content);
  const pays = `Pays ${listing.scheme === "upto" ? "at most " : ""}${code === undefined ? "the listed amount" : `${decimalAmount(listing.amount)} ${code}`} on ${view.label.toLowerCase()}.${listing.feesSponsored === true ? " The facilitator sponsors the fee." : ""}`;
  return panel(
    { title: "Call it", id: "call", cls: "dark" },
    h(
      "div",
      { class: "tabs", "data-tabs": "true" },
      h(
        "div",
        { class: "tablist", role: "tablist", "aria-label": "Client", hidden: true },
        tab("cli", "CLI"),
        tab("ts", "TypeScript"),
        tab("mcp", "MCP"),
        view.slug === "testnet" ? tab("playground", "Playground") : null,
      ),
      tabPanel(
        "cli",
        "CLI",
        h("pre", { class: "dark" }, `$ ${cli}`),
        copyButton(cli.replaceAll("\\\n    ", ""), "command"),
        h("span", { class: "small" }, pays),
      ),
      tabPanel("ts", "TypeScript", h("pre", { class: "dark" }, typescript), copyButton(typescript, "code")),
      tabPanel(
        "mcp",
        "MCP",
        h("pre", { class: "dark" }, mcp),
        h(
          "span",
          { class: "small" },
          "The rail402-mcp server's pay_and_call tool, bound to this listing and its owner.",
        ),
      ),
      view.slug === "testnet"
        ? tabPanel(
            "playground",
            "Playground",
            h(
              "p",
              { class: "small" },
              "Pay it step by step in the browser, with a throwaway testnet account: ",
              h(
                "a",
                { href: "https://playground.rail402.dev", rel: "noopener noreferrer" },
                "playground.rail402.dev",
              ),
              ".",
            ),
          )
        : null,
    ),
  );
}

/** The listing's public version history, newest first. */
function historyPanel(context: PageContext, model: ResourceModel): Child {
  const view = context.layout.view;
  const versions = model.versions.status === "ok" ? [...model.versions.value].reverse() : [];
  return panel(
    { title: "Listing history", id: "history" },
    versions.length === 0
      ? h(
          "p",
          { class: "empty" },
          model.versions.status === "down" ? "The Bazaar did not answer." : "No public history.",
        )
      : h(
          "ol",
          { class: "history" },
          versions
            .slice(0, 12)
            .map((version) =>
              h(
                "li",
                null,
                h(
                  "svg",
                  { viewBox: "0 0 10 10", "aria-hidden": "true" },
                  h("rect", { x: 0, y: 0, width: 10, height: 10 }),
                ),
                h(
                  "div",
                  { class: "cell" },
                  h(
                    "span",
                    { class: "strong" },
                    `${version.version === model.listing.version ? "Current version" : "Version"} ${String(version.version)}`,
                  ),
                  h(
                    "span",
                    { class: "small muted" },
                    `${day(version.createdAt)} · ${displayText(version.cause, 40).replaceAll("_", " ")} · ${displayText(version.trust, 32).replaceAll("_", " ")}${version.state === "published" ? "" : ` · ${displayText(version.state, 24)}`}`,
                  ),
                  version.transaction === undefined
                    ? null
                    : h("span", { class: "small" }, "After payment ", txLink(view, version.transaction)),
                ),
              ),
            ),
        ),
    note("From the Bazaar's public version history (the first 25 versions)."),
  );
}

/**
 * A listing the Bazaar does not publish (pending its origin check, or withdrawn): its state, its history
 * and a warning only. Its price, payee and metadata are not confirmed by its origin, so the page shows no
 * price, no seller and no way to call it.
 */
function unpublishedPage(context: PageContext, model: ResourceModel): string {
  const listing = model.listing;
  const state = displayText(listing.state ?? "unknown", 24);
  return layout(
    {
      ...context.layout,
      section: "services",
      title: "Unpublished listing",
      path: `/resource/${listing.id}`,
      description: "A Rail402 Bazaar listing that is not published.",
    },
    body(
      pageHead({ eyebrow: "Bazaar listing" }, [
        h(
          "h1",
          { class: "url" },
          displayText(
            listing.type === "mcp" ? (listing.toolName ?? listing.resource) : listing.resource,
            1_000,
          ),
        ),
        badge(`Not published: ${state}`, "warn"),
      ]),
      h(
        "p",
        { class: "notice", role: "status" },
        state === "pending"
          ? "This listing waits for its resource's own 402 answer to confirm it. Until then the Bazaar does not publish it: its price, payee and description are unconfirmed, so they are not shown and it should not be paid from here."
          : "The Bazaar withdrew this listing: its resource's own answer no longer confirms it. Its price, payee and description are not shown, and it should not be paid from here.",
      ),
      historyPanel(context, model),
    ),
  );
}

export function resourcePage(context: PageContext, model: ResourceModel): string {
  if (model.listing.state !== undefined && model.listing.state !== "published") {
    return unpublishedPage(context, model);
  }
  const view = context.layout.view;
  const listing = model.listing;
  const usage = model.usage.status === "ok" ? model.usage.value : undefined;
  const code = verifiedAsset(context, listing.asset);
  const groups = examples(listing);
  const output = isObject(listing.output) ? listing.output : undefined;
  const inputLine =
    listing.type === "mcp"
      ? `tools/call ${displayText(listing.toolName ?? "", 128)}`
      : `${displayText(listing.method ?? "GET", 8)} ${(() => {
          try {
            const url = new URL(exampleUrl(listing));
            return `${url.pathname}${url.search}`;
          } catch {
            return exampleUrl(listing);
          }
        })()}`;
  return layout(
    {
      ...context.layout,
      section: "services",
      title:
        listing.type === "mcp"
          ? `${displayText(listing.toolName ?? "", 64)} (MCP tool)`
          : displayText(listing.resource, 120),
      path: `/resource/${listing.id}`,
      description:
        "A paid resource in the Rail402 Bazaar: price, payment requirements, usage and how to call it.",
    },
    body(
      h(
        "div",
        { class: "page-head" },
        h(
          "div",
          { class: "titles" },
          h(
            "nav",
            { class: "eyebrow", "aria-label": "Breadcrumb" },
            h("a", { href: `${view.prefix}/account/${listing.payTo}` }, model.sellerName.toUpperCase()),
            " / Listing",
          ),
          h(
            "div",
            { class: "line" },
            badge(listing.type === "mcp" ? "MCP" : displayText(listing.method ?? "HTTP", 8), "accent"),
            h(
              "h1",
              { class: "url" },
              listing.type === "mcp"
                ? displayText(listing.toolName ?? listing.resource, 128)
                : displayText(listing.resource, 1_000),
            ),
            copyButton(listing.resource, "URL"),
          ),
          listing.type === "mcp"
            ? h("p", { class: "mono soft" }, displayText(listing.resource, 1_000))
            : null,
          listing.description === undefined
            ? null
            : h("p", { class: "lede" }, displayText(listing.description, 1_000)),
          h(
            "div",
            { class: "badges" },
            badge(listing.type),
            listing.mimeType === undefined ? null : badge(displayText(listing.mimeType, 64)),
            badge(listing.scheme, listing.scheme === "upto" ? "upto" : "exact"),
            listing.x402Version === undefined ? null : badge(`x402 v${String(listing.x402Version)}`),
            listing.state === undefined || listing.state === "published"
              ? badge(`In the Bazaar · updated ${day(listing.lastUpdated, false)}`, "dark")
              : badge(`Bazaar state: ${displayText(listing.state, 24)}`, "warn"),
            listing.trust === undefined
              ? null
              : badge(`Trust: ${displayText(listing.trust, 24).replaceAll("_", " ")}`, "grey"),
          ),
        ),
      ),
      listing.contentWithheld === true
        ? h(
            "p",
            { class: "notice", role: "status" },
            "Its origin has not confirmed this listing's description, so the Bazaar withholds it.",
          )
        : null,
      h(
        "section",
        { class: "panel stats", "aria-label": "Usage" },
        stat(
          "Price",
          listingPrice(context, listing),
          listing.scheme === "upto" ? "upto: the most a call can cost" : "exact, per call",
        ),
        stat(
          "Payments",
          usage === undefined ? "—" : groupThousands(usage.payments),
          model.usage.status === "private"
            ? "usage private: the seller does not publish it"
            : usage === undefined
              ? "usage not published by the Bazaar"
              : "settled, linked by the Bazaar",
        ),
        stat("Distinct payers", usage === undefined ? "—" : groupThousands(usage.payers), "all time"),
        stat(
          "Last paid",
          usage?.lastObservedAt === undefined || usage.lastObservedAt === null
            ? "—"
            : ago(usage.lastObservedAt, context.now),
          usage?.lastObservedAt === undefined || usage.lastObservedAt === null
            ? ""
            : day(usage.lastObservedAt),
        ),
      ),
      h(
        "div",
        { class: "columns" },
        h(
          "div",
          { class: "wide" },
          panel(
            {
              title: "Payment requirements",
              id: "requirements",
              aside: h("span", { class: "aside" }, `accepts · ${view.network}`),
            },
            rows(
              undefined,
              row("Scheme", h("span", { class: "mono" }, displayText(listing.scheme, 16))),
              row("Network", h("span", { class: "mono" }, displayText(listing.network, 32))),
              row(
                "Amount",
                h(
                  "span",
                  { class: "mono" },
                  `${listing.amount}${code === undefined ? " atomic units" : ` (${decimalAmount(listing.amount)} ${code})`}`,
                ),
              ),
              row(
                "Asset",
                h("span", { class: "mono full" }, displayText(listing.asset, 56)),
                code === undefined
                  ? badge("not a verified asset", "custom")
                  : badge(`${code} · verified`, "ok"),
              ),
              row(
                "Pay to",
                h(
                  "a",
                  { class: "mono full", href: `${view.prefix}/account/${listing.payTo}` },
                  displayText(listing.payTo, 56),
                ),
              ),
              listing.maxTimeoutSeconds === undefined
                ? null
                : row("Max timeout", h("span", { class: "mono" }, `${String(listing.maxTimeoutSeconds)} s`)),
              row(
                "Fees",
                listing.feesSponsored === true ? "Sponsored by the facilitator" : "Not declared as sponsored",
              ),
            ),
            note("As the seller's 402 answer states them, recorded by the Bazaar (off chain)."),
          ),
          groups.length === 0 && output === undefined
            ? null
            : panel(
                { title: "Input and output", id: "io" },
                h(
                  "div",
                  { class: "io" },
                  h(
                    "div",
                    null,
                    h("span", { class: "label" }, "Input"),
                    h("pre", { class: "code" }, inputLine),
                    groups.flatMap((group) =>
                      group.pairs.map(([key, value]) =>
                        h(
                          "div",
                          { class: "kv" },
                          h("span", null, `${group.kind} · ${key}`),
                          h("span", null, value),
                        ),
                      ),
                    ),
                  ),
                  output === undefined
                    ? null
                    : h(
                        "div",
                        null,
                        h(
                          "span",
                          { class: "label" },
                          `Output example${typeof output["type"] === "string" ? ` · ${displayText(output["type"], 16)}` : ""}`,
                        ),
                        h("pre", { class: "code" }, json(output["example"] ?? output)),
                      ),
                ),
                note("The seller's own example (Bazaar metadata, untrusted)."),
              ),
          panel(
            {
              title: "Latest payments for this listing",
              id: "payments",
              aside: h(
                "a",
                { href: `${view.prefix}/account/${listing.payTo}#payments` },
                "All the seller's payments",
              ),
            },
            model.usage.status === "down"
              ? h("p", { class: "empty" }, "The Bazaar did not answer; try again shortly.")
              : model.recent.length === 0
                ? h(
                    "p",
                    { class: "empty" },
                    model.usage.status === "private"
                      ? "Usage private: the Bazaar does not publish the payments linked to this listing."
                      : usage === undefined
                        ? "The Bazaar does not publish which payments bought this listing yet."
                        : usage.recent.length === 0 && usage.payments > 0
                          ? "This network's Bazaar publishes payment counts only: it links no payment, and no payer, to a listing."
                          : "No indexed payment is linked to this listing yet.",
                  )
                : table(
                    "narrow",
                    [
                      { label: "Payment" },
                      { label: "Age" },
                      { label: "Payer" },
                      { label: "Amount", num: true },
                    ],
                    model.recent.map((settlement) =>
                      h(
                        "tr",
                        null,
                        h("td", null, txLink(view, settlement.txHash)),
                        h("td", { class: "muted nowrap" }, ago(settlement.closedAt, context.now)),
                        h("td", null, shortAddress(view, settlement.payer)),
                        h("td", { class: "num" }, amountText(settlement)),
                      ),
                    ),
                  ),
            usage === undefined || usage.recent.length === model.recent.length
              ? null
              : note(
                  `${String(usage.recent.length - model.recent.length)} more recent payments the Bazaar linked are not indexed yet.`,
                ),
          ),
        ),
        h(
          "aside",
          { class: "side" },
          callIt(context, listing),
          panel(
            { title: "Seller", id: "seller" },
            h(
              "div",
              { class: "item" },
              h("span", { class: "avatar small accent", "aria-hidden": "true" }, monogram(model.sellerName)),
              h(
                "div",
                { class: "main" },
                h(
                  "a",
                  { href: `${view.prefix}/account/${listing.payTo}`, class: "strong" },
                  model.sellerName,
                ),
                h(
                  "span",
                  { class: "small muted mono" },
                  [
                    shortKey(listing.payTo),
                    model.sellerListings === undefined
                      ? ""
                      : `${String(model.sellerListings)} listing${model.sellerListings === 1 ? "" : "s"}`,
                    model.sellerPayments === undefined
                      ? ""
                      : `${groupThousands(model.sellerPayments)} payments`,
                  ]
                    .filter((part) => part !== "")
                    .join(" · "),
                ),
              ),
            ),
          ),
          historyPanel(context, model),
        ),
      ),
    ),
  );
}
