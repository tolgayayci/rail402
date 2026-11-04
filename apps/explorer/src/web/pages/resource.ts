import type { RegistrySnapshot, SettlementRow } from "@rail402.dev/x402-index";
import type { Answer, Listing, ListingVersion, UsageAnswer } from "../bazaar.ts";
import { amountText, h, type Child, type Node } from "../components.ts";
import { ago, baseAccount, dayLabel, decimalAmount, groupThousands, shortHash, shortKey } from "../format.ts";
import { displayText, safeHttpsUrl } from "../text.ts";
import {
  actionLink,
  bdg,
  card,
  checks,
  copyAction,
  copyMini,
  empty,
  facPill,
  kv,
  miniCard,
  networkPill,
  page,
  pageHead,
  payRow,
  schemePill,
  tile,
} from "../ui.ts";
import { verifiedAsset, type PageContext } from "./context.ts";
import { shortName } from "./facilitators.ts";
import {
  hostOf,
  listingIcon,
  listingName,
  listingWhere,
  priceText,
  trustBadge,
  typeLabel,
  type Entry,
} from "./services.ts";

export interface ResourceModel {
  readonly listing: Listing;
  readonly usage: UsageAnswer;
  readonly versions: Answer<readonly ListingVersion[]>;
  /** The indexed settlements of the usage's recent transactions that paid the listing's payTo. */
  readonly recent: readonly SettlementRow[];
  /** The seller's other listings, with their paid calls when the Bazaar gave them. */
  readonly more: readonly Entry[];
  /** How many listings the seller has, this one included; undefined when the Bazaar did not say. */
  readonly sellerCount: number | undefined;
  readonly sellerName: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An untrusted example value as short text; nothing in it is ever markup. */
function valueText(value: unknown, max = 80): string {
  // JSON.stringify gives undefined for undefined and functions, whatever its declared type says.
  const json: unknown = typeof value === "string" ? value : JSON.stringify(value);
  return displayText(typeof json === "string" ? json : "", max);
}

/** What a call sends: each parameter, whether it is required, and the seller's example value. */
interface Param {
  readonly name: string;
  readonly required: boolean;
  readonly example: string | undefined;
}

function callShape(listing: Listing): { readonly sentAs: string; readonly params: readonly Param[] } {
  const input = isObject(listing.input) ? listing.input : {};
  if (listing.type === "mcp") {
    const schema = isObject(input["inputSchema"]) ? input["inputSchema"] : {};
    const properties = isObject(schema["properties"]) ? schema["properties"] : {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    const example = isObject(input["example"])
      ? input["example"]
      : isObject(input["arguments"])
        ? input["arguments"]
        : {};
    const names = [...new Set([...Object.keys(properties), ...Object.keys(example)])].slice(0, 12);
    return {
      sentAs: "As tool arguments",
      params: names.map((name) => ({
        name: displayText(name, 48),
        required: required.includes(name),
        example: example[name] === undefined ? undefined : valueText(example[name], 40),
      })),
    };
  }
  const groups: [string, unknown][] = [
    ["path", input["pathParams"]],
    ["query", input["queryParams"]],
    ["body", input["body"]],
  ];
  const params = groups.flatMap(([, value]) =>
    isObject(value)
      ? Object.entries(value).map(([name, example]) => ({
          name: displayText(name, 48),
          required: true,
          example: valueText(example, 40),
        }))
      : [],
  );
  const inBody = isObject(input["body"]) && Object.keys(input["body"]).length > 0;
  return { sentAs: inBody ? "In the body, as JSON" : "In the address", params: params.slice(0, 12) };
}

const VERSION_WHAT: Readonly<Record<string, string>> = {
  settlement: "Listed after its first payment",
  origin_verification: "Service checked",
  domain_verification: "Domain checked",
  quarantine: "Withdrawn: the service no longer confirms it",
};

/** The listing's public history as a timeline, newest first. */
function historyCard(model: ResourceModel): Node {
  const versions = model.versions.status === "ok" ? [...model.versions.value].reverse().slice(0, 8) : [];
  return card(
    {
      title: "History",
      icon: "clock",
      end:
        model.listing.version === undefined
          ? undefined
          : bdg(`version ${String(model.listing.version)}`, "mut"),
    },
    versions.length === 0
      ? empty(model.versions.status === "down" ? "The Bazaar did not answer" : "No public history")
      : h(
          "ol",
          { class: "tl" },
          versions.map((version, i) =>
            h(
              "li",
              {
                class:
                  [version.state === "published" ? "" : "warn", i === 0 ? "now" : ""].join(" ").trim() ||
                  undefined,
              },
              h("span", { class: "dot" }),
              h(
                "span",
                null,
                h(
                  "b",
                  null,
                  VERSION_WHAT[version.cause] ?? displayText(version.cause, 40).replaceAll("_", " "),
                ),
                h(
                  "small",
                  null,
                  `v${String(version.version)} · ${dayLabel(version.createdAt.slice(0, 10))} · ${displayText(version.trust, 32).replaceAll("_", " ")}`,
                ),
              ),
            ),
          ),
        ),
  );
}

/** The time of the Bazaar's newest check of the service or its domain. */
function checkedAt(model: ResourceModel): string | undefined {
  if (model.listing.domainCheck?.checkedAt !== undefined) return model.listing.domainCheck.checkedAt;
  if (model.versions.status !== "ok") return undefined;
  return [...model.versions.value]
    .reverse()
    .find((version) => version.cause === "origin_verification" || version.cause === "domain_verification")
    ?.createdAt;
}

const facilitatorOf = (registry: RegistrySnapshot, row: SettlementRow) => {
  const id = row.attribution.facilitatorId;
  const entry = id === null ? undefined : registry.facilitator(id);
  return entry === undefined ? facPill("Not registered", null) : facPill(shortName(entry), entry.id);
};

/**
 * A listing the Bazaar does not publish (pending its origin check, or withdrawn): its state, its history
 * and a warning only. Its price, payee and metadata are not confirmed by its origin, so the page shows no
 * price, no seller and no way to call it.
 */
function unpublishedPage(context: PageContext, model: ResourceModel): string {
  const view = context.layout.view;
  const listing = model.listing;
  const state = displayText(listing.state ?? "unknown", 24);
  return page(
    {
      ...context.layout,
      title: "Unpublished listing",
      path: `/resource/${listing.id}`,
      section: "bazaar",
      description: "A Rail402 Bazaar listing that is not published.",
    },
    pageHead({
      crumbs: [
        ["Bazaar", `${view.prefix}/services`],
        ["Unpublished", undefined],
      ],
      title: displayText(
        listing.type === "mcp" ? (listing.toolName ?? listing.resource) : listing.resource,
        300,
      ),
      mono: true,
      badges: [bdg(`not published: ${state}`, "warn"), networkPill(view)],
    }),
    card(
      { title: "Not published", icon: "alert", cls: "dashed" },
      h(
        "p",
        { class: "lede" },
        state === "pending"
          ? "This listing waits for its service to confirm it. Until then its price, seller and description are unconfirmed: do not pay it from here."
          : "The Bazaar withdrew this listing: its service no longer confirms it. Its price, seller and description are not shown: do not pay it from here.",
      ),
    ),
    h("div", { class: "oc-gap" }, historyCard(model)),
  );
}

export function resourcePage(context: PageContext, model: ResourceModel): string {
  if (model.listing.state !== undefined && model.listing.state !== "published") {
    return unpublishedPage(context, model);
  }
  const view = context.layout.view;
  const p = view.prefix;
  const listing = model.listing;
  const usage = model.usage.status === "ok" ? model.usage.value : undefined;
  const code = verifiedAsset(context, listing.asset);
  const name = listingName(listing);
  const host = hostOf(listing.resource) ?? shortKey(listing.payTo);
  const sellerHref = `${p}/seller/${baseAccount(listing.payTo)}`;
  const upto = listing.scheme === "upto";
  const shape = callShape(listing);
  const output = isObject(listing.output) ? listing.output : undefined;
  const example = output !== undefined && isObject(output["example"]) ? output["example"] : undefined;
  const answerKeys = example === undefined ? [] : Object.keys(example).slice(0, 8);
  const description = listing.description === undefined ? undefined : displayText(listing.description, 600);
  const domain = listing.trust === "domain_verified";
  const origin = domain || listing.trust === "origin_verified";
  const checked = checkedAt(model);
  const lastAt = usage?.lastObservedAt ?? null;
  const fresh =
    lastAt === null
      ? undefined
      : context.now - Date.parse(lastAt) <= 86_400_000
        ? bdg("last 24 h", "ok")
        : context.now - Date.parse(lastAt) <= 7 * 86_400_000
          ? bdg("this week", "ok")
          : bdg("quiet", "mut");
  const usageNote =
    model.usage.status === "private"
      ? bdg("private", "mut", "The seller does not publish this listing's usage")
      : model.usage.status === "down"
        ? bdg("not available", "mut")
        : undefined;
  const playground = view.slug === "testnet" ? safeHttpsUrl("https://playground.rail402.dev") : undefined;

  const left: Node[] = [
    card(
      { title: "How to call", icon: "contract" },
      kv([
        [
          "Address",
          h("span", { class: "oc-addr" }, displayText(listing.resource, 300)),
          copyMini(listing.resource, "address"),
        ],
        listing.type === "mcp" && listing.toolName !== undefined
          ? [
              "Tool",
              h("span", { class: "r4-badge", "data-scheme": "agent" }, displayText(listing.toolName, 64)),
            ]
          : null,
        listing.type === "http" ? ["Method", displayText(listing.method ?? "GET", 8)] : null,
        ["Sent as", h("span", { class: "sans" }, shape.sentAs)],
        shape.params.length === 0
          ? null
          : [
              "Asks for",
              ...shape.params.map((param) =>
                bdg(
                  [
                    `${param.name}${param.required ? "" : " · optional"}`,
                    param.example === undefined ? null : h("em", { class: "exv" }, param.example),
                  ],
                  param.required ? undefined : "dash",
                ),
              ),
            ],
        answerKeys.length === 0
          ? null
          : [
              "Answers with",
              ...answerKeys.map((key) => bdg(displayText(key, 40), "mut")),
              output?.["type"] === "json" ? bdg("JSON", "dash") : null,
            ],
      ]),
      example === undefined
        ? null
        : h(
            "div",
            { class: "exa" },
            h("h4", null, "Example answer"),
            h(
              "dl",
              { class: "kv4" },
              answerKeys.map((key) =>
                h(
                  "div",
                  null,
                  h("dt", null, displayText(key, 40)),
                  h("dd", null, valueText(example[key], 60)),
                ),
              ),
            ),
          ),
      listing.contentWithheld === true
        ? h(
            "p",
            { class: "oc-note" },
            "The service has not confirmed this listing's description, so the Bazaar withholds it.",
          )
        : null,
    ),
    card(
      {
        title: "Latest payments",
        icon: "list",
        link: { href: `${p}/account/${listing.payTo}`, label: "All the seller's payments →" },
      },
      model.recent.length === 0
        ? empty(
            model.usage.status === "down"
              ? "The Bazaar did not answer"
              : model.usage.status === "private"
                ? "Usage is private"
                : usage !== undefined && usage.recent.length > 0
                  ? "Not indexed yet"
                  : usage !== undefined && usage.payments > 0
                    ? "Payments are counted only"
                    : "No payment linked yet",
            model.usage.status === "private"
              ? "The seller does not publish which payments bought it."
              : usage !== undefined && usage.recent.length > 0
                ? "Its latest payments show here once the index reads their ledgers."
                : usage !== undefined && usage.payments > 0
                  ? "This network's Bazaar links no payment, and no payer, to a listing."
                  : undefined,
          )
        : h(
            "div",
            { class: "feed2" },
            model.recent.slice(0, 10).map((row) =>
              payRow({
                href: `${p}/tx/${row.txHash}`,
                hash: shortHash(row.txHash),
                sub: ago(row.closedAt, context.now),
                middle: { title: `from ${shortKey(row.payer)}`, sub: "buyer" },
                amount: amountText(row),
                badges: [schemePill(row.scheme), facilitatorOf(context.registry, row)],
              }),
            ),
          ),
    ),
  ];

  const right: Node[] = [
    card(
      { title: "Price", icon: "tag" },
      kv([
        [
          upto ? "Most per call" : "Per call",
          h("b", null, priceText(context, listing).replace(/^up to /, "")),
        ],
        [
          "Pricing",
          schemePill(listing.scheme),
          h("span", { class: "sans muted" }, upto ? "charged for what you use" : "same price every call"),
        ],
        [
          "Token",
          code ?? shortKey(displayText(listing.asset, 56)),
          code === undefined ? bdg("unverified", "warn") : bdg("verified", "ok"),
        ],
        [
          "Network fee",
          listing.feesSponsored === true
            ? bdg("paid by facilitator", "ok")
            : bdg("not declared as sponsored", "mut"),
        ],
        listing.maxTimeoutSeconds === undefined
          ? null
          : [
              "Offer valid",
              listing.maxTimeoutSeconds >= 60
                ? `${String(Math.round(listing.maxTimeoutSeconds / 60))} min`
                : `${String(listing.maxTimeoutSeconds)} s`,
            ],
      ]),
    ),
    card(
      {
        title: "Trust",
        icon: "shield",
        end: checked === undefined ? undefined : bdg(`checked ${ago(checked, context.now)}`, "mut"),
      },
      checks(
        [
          { label: "Listed after a real payment", ok: true },
          { label: "Service confirms this seller", ok: origin },
          ...(model.listing.domainCheck !== undefined
            ? [
                { label: "Domain names this seller", ok: model.listing.domainCheck.claimsOwner },
                { label: "Seller account names the domain", ok: model.listing.domainCheck.homeDomainMatches },
              ]
            : domain
              ? [
                  { label: "Domain names this seller", ok: true },
                  { label: "Seller account names the domain", ok: true },
                ]
              : [{ label: "Domain and seller account name each other", ok: false }]),
        ],
        "why one",
      ),
    ),
    historyCard(model),
  ];

  return page(
    {
      ...context.layout,
      title: name,
      path: `/resource/${listing.id}`,
      section: "bazaar",
      description: "A paid service in the Rail402 Bazaar: price, how to call it, trust and its paid calls.",
    },
    pageHead({
      crumbs: [
        ["Bazaar", `${p}/services`],
        [host, sellerHref],
        [name, undefined],
      ],
      title: name,
      lede: description !== undefined && description !== name ? description : listingWhere(listing),
      badges: [
        typeLabel(listing.type),
        schemePill(listing.scheme),
        trustBadge(listing.trust),
        listing.feesSponsored === true ? bdg("fees sponsored", "ok") : null,
        networkPill(view),
      ],
      actions: [
        copyAction(listing.resource, "Copy address"),
        ...(playground === undefined
          ? []
          : [actionLink(playground, "Try in Playground", "external", true, true)]),
      ],
    }),
    h(
      "div",
      { class: "g4" },
      tile({
        label: "Price",
        icon: "tag",
        value: code === undefined ? listing.amount : decimalAmount(listing.amount),
        unit: code ?? "units",
        badges: [bdg(upto ? "most per call" : "per call", "mut")],
      }),
      tile({
        label: "Paid calls",
        icon: "payments",
        value: usage === undefined ? "—" : groupThousands(usage.payments),
        badges:
          usageNote !== undefined
            ? [usageNote]
            : [
                bdg(
                  `since ${dayLabel((usage?.firstObservedAt ?? listing.firstCataloged ?? listing.lastUpdated).slice(0, 10))}`,
                  "mut",
                ),
              ],
      }),
      tile({
        label: "Buyers",
        icon: "user",
        value: usage === undefined ? "—" : groupThousands(usage.payers),
        badges:
          usage === undefined || usage.payers === 0
            ? usageNote === undefined
              ? []
              : [usageNote]
            : [bdg(`${(usage.payments / usage.payers).toFixed(1)} calls each`, "mut")],
      }),
      tile({
        label: "Last paid",
        icon: "clock",
        value: lastAt === null ? "—" : ago(lastAt, context.now),
        badges: fresh === undefined ? (usageNote === undefined ? [] : [usageNote]) : [fresh],
      }),
    ),
    h(
      "div",
      { class: "g21" },
      h("div", { class: "oc-col" }, ...left),
      h("div", { class: "oc-col" }, ...right),
    ),
    model.more.length === 0
      ? null
      : card(
          {
            title: `More from ${model.sellerName}`,
            icon: "bazaar",
            cls: "oc-gap",
            end: bdg(shortKey(listing.payTo), "mut"),
            link: {
              href: sellerHref,
              label: model.sellerCount === undefined ? "All →" : `All ${groupThousands(model.sellerCount)} →`,
            },
          },
          h(
            "div",
            { class: "g4 oc-more" },
            model.more
              .slice(0, 4)
              .map((entry): Child =>
                miniCard(
                  `${p}/resource/${entry.listing.id}`,
                  listingIcon(entry.listing),
                  listingName(entry.listing),
                  `${priceText(context, entry.listing)}${entry.payments === undefined ? "" : ` · ${groupThousands(entry.payments)} paid`}`,
                ),
              ),
          ),
        ),
  );
}
