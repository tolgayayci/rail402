import type { Kysely } from "kysely";
import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import type { SettlementRow } from "@rail402.dev/x402-index";
import {
  SEARCH_LIMIT,
  accountCounts,
  accountsByPart,
  paymentsByHashPrefix,
  type FoundAccount,
  type TopAccount,
} from "../../api/queries-a.ts";
import type { ExplorerDatabase } from "../../db.ts";
import type { Answer, Listing } from "../bazaar.ts";
import { h, type Child, type Node } from "../components.ts";
import { ago, groupThousands, shortKey, stellarExpertAccount, stellarExpertTx } from "../format.ts";
import { displayText } from "../text.ts";
import { bdg, card, facTone, iconBox, miniCard, page, pager, seg, svgIcon, type IconName } from "../ui.ts";
import { listingPrice, type PageContext } from "./context.ts";
import { facShort, hash8, listingHost, listingName, rowAmount, softly } from "./home.ts";

/** What a search looks like, which decides what it searches. */
export type SearchKind = "empty" | "short" | "tx" | "address" | "hash part" | "address part" | "words";

const KIND_LABELS: Readonly<Record<SearchKind, string>> = {
  empty: "",
  short: "",
  tx: "transaction hash",
  address: "Stellar address",
  "hash part": "part of a hash",
  "address part": "part of an address",
  words: "words",
};

/** Raw path data of the icons the live results draw (the script builds them from these). */
const ICON_PATHS = {
  acc: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  con: "M8 8l-4 4 4 4M16 8l4 4-4 4",
  pay: "M4 8h13l-3-3M20 16H7l3 3",
  svc: "M4 10h16v10H4zM2 10l3-6h14l3 6",
  fac: "M2 15h7M15 15h7M9 6h6v6H9z",
  none: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
} as const;

type IconKey = keyof typeof ICON_PATHS;

const ICON_NAMES: Readonly<Record<IconKey, IconName>> = {
  acc: "user",
  con: "contract",
  pay: "payments",
  svc: "bazaar",
  fac: "facilitators",
  none: "search",
};

/** Registry roles as the pages name them. */
export const ROLE_NAMES: Readonly<Record<string, string>> = {
  sponsor: "fee payer",
  "fee-bump": "fee payer",
  relayer: "fee payer",
  channel: "sender",
  "upto-authority": "upto authority",
};

const isStrkey = (value: string) =>
  StrKey.isValidEd25519PublicKey(value) ||
  StrKey.isValidContract(value) ||
  StrKey.isValidMed25519PublicKey(value);

/** Whether upper-case `up` can be part of a strkey: its start (from 3 characters) or its end (from 4). */
const addressPart = (up: string) => /^[GC][A-Z2-7]{2,54}$/.test(up) || /^[A-Z2-7]{4,55}$/.test(up);

/** The kind of a search: a hash, an address, part of one, or words. */
export function searchKind(raw: string): SearchKind {
  const q = raw.trim();
  if (q === "") return "empty";
  if (/^[0-9a-f]{64}$/i.test(q)) return "tx";
  const up = q.toUpperCase();
  if (isStrkey(up)) return "address";
  if (q.length < 3) return "short";
  const hexish = /^[0-9a-f]{3,63}$/i.test(q);
  const addrish = addressPart(up);
  if (hexish && !addrish) return "hash part";
  // A lower-case word that happens to start with G or C is a word; typed in capitals or with a strkey
  // digit it is part of an address. Both are searched as accounts.
  if (addrish && (q === up || /[2-7]/.test(q))) return "address part";
  return "words";
}

export type GroupId = "accounts" | "payments" | "services" | "facilitators";

const GROUP_LABELS: Readonly<Record<GroupId, string>> = {
  accounts: "Accounts",
  payments: "Payments",
  services: "Services",
  facilitators: "Facilitators",
};

export const GROUP_IDS: readonly GroupId[] = ["accounts", "payments", "services", "facilitators"];

export interface ItemBadge {
  readonly text: string;
  readonly cls: string;
  readonly scheme?: string;
}

/** One result: everything both the dropdown and the results page draw. */
export interface SearchItem {
  readonly icon: IconKey;
  readonly title: string;
  readonly mono: boolean;
  /** The matched part of the title, [start, end). */
  readonly mark: readonly [number, number] | null;
  readonly sub: string;
  readonly badges: readonly ItemBadge[];
  readonly right: string;
  readonly href: string;
}

export interface SearchGroup {
  readonly id: GroupId;
  readonly label: string;
  readonly items: readonly SearchItem[];
}

export interface SearchResult {
  readonly kind: SearchKind;
  readonly q: string;
  readonly groups: readonly SearchGroup[];
  readonly total: number;
  /** The Bazaar was asked and did not answer: services may be missing. */
  readonly bazaarDown: boolean;
}

/** Where a search looks. */
export interface SearchSources {
  readonly db: Kysely<ExplorerDatabase> | undefined;
  readonly epoch: string;
  /** The network's listings; `none` without a Bazaar. */
  readonly listings: Answer<readonly Listing[]>;
}

/** The first place one of `words` occurs in `text`, as a mark. */
function markOf(text: string, words: readonly string[]): readonly [number, number] | null {
  const low = text.toLowerCase();
  for (const word of words) {
    const at = word === "" ? -1 : low.indexOf(word);
    if (at >= 0) return [at, at + word.length];
  }
  return null;
}

/** The mark of an address part in the address's short form: its first or last four characters. */
function addressMark(address: string, part: string): readonly [number, number] | null {
  const short = shortKey(address);
  if (part === "" || short === address) return null;
  if (address.startsWith(part)) return [0, Math.min(4, part.length)];
  if (address.endsWith(part)) return [short.length - Math.min(4, part.length), short.length];
  return null;
}

const schemeBadge = (scheme: string): ItemBadge => ({
  text: scheme === "upto" ? "upto" : "exact",
  cls: "r4-badge",
  scheme: scheme === "upto" ? "upto" : "exact",
});

const facItemBadge = (context: PageContext, id: string | null, suffix = ""): ItemBadge => ({
  text: `${facShort(context, id)}${suffix}`,
  cls: `fac ${facTone(id)}`,
});

/** Registry accounts of the network matching `match`, with their facilitator and role. */
function registryAccounts(context: PageContext, match: (address: string) => boolean) {
  const found = new Map<string, { facilitator: string; role: string }>();
  for (const facilitator of context.registry.document.facilitators)
    for (const account of facilitator.accounts)
      if (match(account.address) && !found.has(account.address))
        found.set(account.address, { facilitator: facilitator.id, role: account.role });
  return found;
}

function accountItem(
  context: PageContext,
  address: string,
  counts: FoundAccount | undefined,
  registered: { facilitator: string; role: string } | undefined,
  part: string,
  host = "",
): SearchItem {
  const view = context.layout.view;
  const received = counts?.received ?? 0;
  const paid = counts?.paid ?? 0;
  const role =
    received > 0 && paid > 0 ? "buyer · seller" : received > 0 ? "seller" : paid > 0 ? "buyer" : undefined;
  return {
    icon: address.startsWith("C") ? "con" : "acc",
    title: shortKey(address),
    mono: true,
    mark: addressMark(address, part),
    sub:
      [
        host,
        received > 0 ? `${groupThousands(received)} received` : "",
        paid > 0 ? `${groupThousands(paid)} paid` : "",
      ]
        .filter((text) => text !== "")
        .join(" · ") || (registered !== undefined ? "registered account" : host || "account"),
    badges: [
      ...(role === undefined ? [] : [{ text: role, cls: "bdg" }]),
      ...(registered === undefined
        ? []
        : [
            facItemBadge(
              context,
              registered.facilitator,
              ` ${ROLE_NAMES[registered.role] ?? displayText(registered.role, 20)}`,
            ),
          ]),
    ],
    right: received + paid > 0 ? groupThousands(received + paid) : "",
    href: `${view.prefix}/account/${address}`,
  };
}

function paymentItem(context: PageContext, row: SettlementRow, q: string): SearchItem {
  const view = context.layout.view;
  return {
    icon: "pay",
    title: hash8(row.txHash),
    mono: true,
    mark: q === "" ? null : [0, Math.min(8, q.length)],
    sub: `${shortKey(row.payer)} → ${shortKey(row.payTo)} · ${ago(row.closedAt, context.now)}`,
    badges: [schemeBadge(row.scheme), facItemBadge(context, row.attribution.facilitatorId)],
    right: rowAmount(context, row),
    href: `${view.prefix}/tx/${row.txHash}`,
  };
}

function serviceItem(context: PageContext, listing: Listing, words: readonly string[]): SearchItem {
  const view = context.layout.view;
  const title = listingName(listing);
  const host = listingHost(listing);
  const description = listing.description === undefined ? "" : displayText(listing.description, 120);
  return {
    icon: "svc",
    title,
    mono: false,
    mark: markOf(title, words),
    sub: [host, description === title ? "" : description].filter((text) => text !== "").join(" · "),
    badges: [
      listing.type === "mcp"
        ? { text: "tool", cls: "r4-badge", scheme: "agent" }
        : { text: "API", cls: "r4-badge", scheme: "api" },
      schemeBadge(listing.scheme),
    ],
    right: listingPrice(context, listing),
    href: `${view.prefix}/resource/${listing.id}`,
  };
}

/** Searches the index, the registry and the Bazaar for `raw`; every group holds at most 50. */
export async function runSearch(
  context: PageContext,
  raw: string,
  sources: SearchSources,
): Promise<SearchResult> {
  const q = raw.trim().slice(0, 300);
  const kind = searchKind(q);
  if (kind === "empty" || kind === "short") return { kind, q, groups: [], total: 0, bazaarDown: false };
  const network = context.layout.view.network;
  const db = sources.db;
  const low = q.toLowerCase();
  const up = q.toUpperCase();
  const words = low.split(/\s+/).filter((word) => word !== "");
  const hexish = kind === "tx" || /^[0-9a-f]{3,63}$/i.test(q);
  const addrish = addressPart(up);
  const full =
    kind === "address"
      ? StrKey.isValidMed25519PublicKey(up)
        ? MuxedAccount.fromAddress(up, "0").baseAccount().accountId()
        : up
      : undefined;

  const [payments, parts, counts] = await Promise.all([
    hexish && db !== undefined
      ? softly(() => paymentsByHashPrefix(db, network, sources.epoch, low))
      : Promise.resolve(undefined),
    addrish && db !== undefined
      ? softly(() => accountsByPart(db, network, sources.epoch, up))
      : Promise.resolve(undefined),
    full !== undefined && db !== undefined
      ? softly(() => accountCounts(db, network, sources.epoch, full))
      : Promise.resolve(undefined),
  ]);

  // Accounts: the index's, then registry accounts the index has no payment of.
  const accounts: SearchItem[] = [];
  const seen = new Set<string>();
  const registered = registryAccounts(context, (address) =>
    full !== undefined ? address === full : addrish && (address.startsWith(up) || address.endsWith(up)),
  );
  if (full !== undefined) {
    if (counts !== undefined || registered.has(full)) {
      accounts.push(accountItem(context, full, counts, registered.get(full), ""));
      seen.add(full);
    }
  }
  for (const found of parts ?? []) {
    accounts.push(accountItem(context, found.address, found, registered.get(found.address), up));
    seen.add(found.address);
  }
  for (const [address, entry] of registered)
    if (!seen.has(address)) {
      accounts.push(accountItem(context, address, undefined, entry, full === undefined ? up : ""));
      seen.add(address);
    }

  // Words: sellers whose listings' host holds every word, the listings themselves, and facilitators.
  const listings = sources.listings.status === "ok" ? sources.listings.value : [];
  const services: SearchItem[] = [];
  const facilitators: SearchItem[] = [];
  if (kind === "words") {
    const has = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const hosts = new Map<string, string>();
    for (const listing of listings) {
      const host = listingHost(listing);
      if (host !== "" && has(host) && !hosts.has(listing.payTo)) hosts.set(listing.payTo, host);
    }
    const sellers = [...hosts]
      .filter(([payTo]) => !seen.has(payTo) && StrKey.isValidEd25519PublicKey(payTo))
      .slice(0, 10);
    const sellerCounts = await Promise.all(
      sellers.map(([payTo]) =>
        db === undefined
          ? Promise.resolve(undefined)
          : softly(() => accountCounts(db, network, sources.epoch, payTo)),
      ),
    );
    sellers.forEach(([payTo, host], index) => {
      accounts.push(
        accountItem(
          context,
          payTo,
          sellerCounts[index],
          registryAccounts(context, (a) => a === payTo).get(payTo),
          "",
          host,
        ),
      );
      seen.add(payTo);
    });
    for (const listing of listings) {
      const text = [
        listingName(listing),
        listing.description ?? "",
        listing.resource,
        listing.toolName ?? "",
        listing.serviceName ?? "",
      ].join(" ");
      if (has(text)) services.push(serviceItem(context, listing, words));
      if (services.length >= SEARCH_LIMIT) break;
    }
    const by = context.report?.aggregates.byFacilitator ?? {};
    for (const entry of context.registry.document.facilitators) {
      const name = facShort(context, entry.id);
      if (!has(`${entry.id} ${name} ${displayText(entry.name, 100)}`)) continue;
      const payments = by[entry.id]?.payments ?? 0;
      facilitators.push({
        icon: "fac",
        title: name,
        mono: false,
        mark: markOf(name, words),
        sub: displayText(entry.name, 100),
        badges: [
          {
            text: entry.tier === "rail402-beta" ? "concluded" : "registered",
            cls: entry.tier === "rail402-beta" ? "bdg mut" : "bdg ok",
          },
        ],
        right: `${groupThousands(payments)} payment${payments === 1 ? "" : "s"}`,
        href: `${context.layout.view.prefix}/facilitator/${entry.id}`,
      });
    }
  }

  const groups: SearchGroup[] = [
    { id: "accounts" as const, label: GROUP_LABELS.accounts, items: accounts.slice(0, SEARCH_LIMIT) },
    {
      id: "payments" as const,
      label: GROUP_LABELS.payments,
      items: (payments ?? []).map((row) => paymentItem(context, row, low)),
    },
    { id: "services" as const, label: GROUP_LABELS.services, items: services },
    { id: "facilitators" as const, label: GROUP_LABELS.facilitators, items: facilitators },
  ].filter((group) => group.items.length > 0);
  return {
    kind,
    q,
    groups,
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    bazaarDown: kind === "words" && sources.listings.status === "down",
  };
}

// --- suggestions ---------------------------------------------------------------------------------

/** A ready search the empty box offers. */
export interface SearchTry {
  readonly q: string;
  readonly icon: IconKey;
  readonly title: string;
  readonly mono: boolean;
  readonly sub: string;
}

/** What the empty box offers: the top seller, the latest payment, a word from the Bazaar, a facilitator. */
export function searchTries(
  context: PageContext,
  options: {
    readonly topSeller: TopAccount | undefined;
    readonly latest: SettlementRow | undefined;
    readonly listings: Answer<readonly Listing[]>;
  },
): SearchTry[] {
  const tries: SearchTry[] = [];
  const seller = options.topSeller;
  if (seller !== undefined)
    tries.push({
      q: seller.address,
      icon: seller.address.startsWith("C") ? "con" : "acc",
      title: shortKey(seller.address),
      mono: true,
      sub: `top seller · ${groupThousands(seller.payments)} received`,
    });
  if (options.latest !== undefined)
    tries.push({
      q: options.latest.txHash.slice(0, 8),
      icon: "pay",
      title: hash8(options.latest.txHash),
      mono: true,
      sub: "latest payment",
    });
  const listings = options.listings.status === "ok" ? options.listings.value : [];
  const word = listings
    .map((listing) =>
      listingName(listing)
        .split(/\s+/)
        .find((part) => /^[a-z]{4,}$/i.test(part)),
    )
    .find((part) => part !== undefined)
    ?.toLowerCase();
  if (word !== undefined) {
    const n = listings.filter((listing) => listingName(listing).toLowerCase().includes(word)).length;
    tries.push({
      q: word,
      icon: "svc",
      title: word,
      mono: false,
      sub: `${String(n)} service${n === 1 ? "" : "s"}`,
    });
  }
  const top = Object.entries(context.report?.aggregates.byFacilitator ?? {}).sort(
    (a, b) => b[1].payments - a[1].payments,
  )[0];
  const facilitator = top?.[0] ?? context.registry.document.facilitators[0]?.id;
  if (facilitator !== undefined)
    tries.push({ q: facilitator, icon: "fac", title: facilitator, mono: false, sub: "facilitator" });
  return tries;
}

const otherView = (context: PageContext) =>
  context.layout.networks.find((view) => view.network !== context.layout.view.network);

function noneWhy(context: PageContext, result: SearchResult): string {
  const label = context.layout.view.label.toLowerCase();
  if (result.kind === "tx")
    return "Not an x402 payment indexed here. It may be a regular Stellar transaction.";
  if (result.kind === "address") return `This address never paid or received an x402 payment on ${label}.`;
  return `Nothing matches “${result.q}”. Try a hash, an address, a service or a facilitator.`;
}

/** The live results the overview's search box shows: the script's JSON, at most three per group. */
export function suggestion(
  context: PageContext,
  result: SearchResult,
  tries: readonly SearchTry[],
): Record<string, unknown> {
  const view = context.layout.view;
  if (result.kind === "empty")
    return {
      kind: "empty",
      tries: tries.map((entry) => ({ ...entry, icon: ICON_PATHS[entry.icon], mark: null })),
    };
  if (result.kind === "short")
    return {
      kind: "short",
      icon: ICON_PATHS.none,
      hint: "At least 3 characters: a hash, an address, a service or a facilitator.",
    };
  const other = otherView(context);
  const query = encodeURIComponent(result.q);
  return {
    kind: result.kind,
    q: result.q,
    total: result.total,
    kindLabel: KIND_LABELS[result.kind],
    searchHref: `${view.prefix}/search?q=${query}`,
    icon: ICON_PATHS.none,
    noneTitle: `No match on ${view.label.toLowerCase()}`,
    noneWhy: noneWhy(context, result),
    links: [
      ...(other === undefined
        ? []
        : [{ label: `Search ${other.label.toLowerCase()} →`, href: `${other.prefix}/search?q=${query}` }]),
      { label: "Latest payments →", href: `${view.prefix}/payments` },
      ...(context.bazaar ? [{ label: "Browse the Bazaar →", href: `${view.prefix}/services` }] : []),
    ],
    groups: result.groups.map((group) => ({
      label: group.label,
      n: group.items.length,
      items: group.items.slice(0, 3).map((item) => ({ ...item, icon: ICON_PATHS[item.icon] })),
    })),
  };
}

// --- the results page ----------------------------------------------------------------------------

export const SEARCH_PER_PAGE = 10;

/** A starting point of the empty search page. */
export interface SearchStart {
  readonly title: string;
  readonly sub: string;
  readonly icon: IconName;
  readonly href: string;
}

export interface SearchPageModel {
  readonly result: SearchResult;
  readonly type: GroupId | "all";
  readonly page: number;
  readonly tries: readonly SearchTry[];
  readonly starts: readonly SearchStart[];
}

/** The empty page's starting points: the top seller and buyer, a registered fee payer, the latest payment. */
export function searchStarts(
  context: PageContext,
  options: {
    readonly topSeller: TopAccount | undefined;
    readonly topBuyer: TopAccount | undefined;
    readonly latest: SettlementRow | undefined;
  },
): SearchStart[] {
  const view = context.layout.view;
  const starts: SearchStart[] = [];
  const account = (title: string, entry: TopAccount | undefined, verb: string) => {
    if (entry !== undefined)
      starts.push({
        title,
        sub: `${shortKey(entry.address)} · ${groupThousands(entry.payments)} ${verb}`,
        icon: "user",
        href: `${view.prefix}/account/${entry.address}`,
      });
  };
  account("Top seller", options.topSeller, "received");
  account("Top buyer", options.topBuyer, "paid");
  const payer = context.registry.document.facilitators
    .flatMap((facilitator) =>
      facilitator.accounts
        .filter((entry) => ROLE_NAMES[entry.role] === "fee payer" && entry.validToLedger === null)
        .map((entry) => ({ facilitator, entry })),
    )
    .sort(
      (a, b) =>
        (context.report?.aggregates.byFacilitator[b.facilitator.id]?.payments ?? 0) -
        (context.report?.aggregates.byFacilitator[a.facilitator.id]?.payments ?? 0),
    )[0];
  if (payer !== undefined)
    starts.push({
      title: `${facShort(context, payer.facilitator.id)} fee payer`,
      sub: `${shortKey(payer.entry.address)} · registered`,
      icon: "facilitators",
      href: `${view.prefix}/account/${payer.entry.address}`,
    });
  if (options.latest !== undefined)
    starts.push({
      title: "Latest payment",
      sub: `${hash8(options.latest.txHash)} · ${ago(options.latest.closedAt, context.now)}`,
      icon: "payments",
      href: `${view.prefix}/tx/${options.latest.txHash}`,
    });
  return starts;
}

function title(item: SearchItem): Node {
  const text = item.title;
  const mark = item.mark;
  return h(
    "b",
    { class: item.mono ? "mono" : undefined },
    mark === null
      ? text
      : [text.slice(0, mark[0]), h("mark", null, text.slice(mark[0], mark[1])), text.slice(mark[1])],
  );
}

function badge(entry: ItemBadge): Node {
  return h(
    "span",
    { class: entry.cls, "data-scheme": entry.scheme },
    /\bfac\b/.test(entry.cls) ? h("i", null) : null,
    entry.text,
  );
}

function resultRow(item: SearchItem): Node {
  return h(
    "a",
    { class: "srow", href: item.href },
    iconBox(ICON_NAMES[item.icon]),
    h("span", { class: "sm" }, title(item), h("small", null, item.sub)),
    h("span", { class: "bl2" }, item.badges.map(badge)),
    h("span", { class: "sr2" }, item.right),
  );
}

function searchHref(context: PageContext, q: string, type: GroupId | "all", pageNumber = 1): string {
  const params = new URLSearchParams();
  if (q !== "") params.set("q", q);
  if (type !== "all") params.set("type", type);
  if (pageNumber > 1) params.set("page", String(pageNumber));
  const text = params.toString();
  return `${context.layout.view.prefix}/search${text === "" ? "" : `?${text}`}`;
}

function notFound(context: PageContext, result: SearchResult): Node {
  const view = context.layout.view;
  const other = otherView(context);
  const q = result.q;
  const expert =
    result.kind === "tx"
      ? stellarExpertTx(view, q.toLowerCase())
      : result.kind === "address"
        ? stellarExpertAccount(view, q.toUpperCase())
        : `https://stellar.expert/explorer/${view.expert}`;
  const bazaarPrefix = context.bazaar ? view.prefix : "/testnet";
  return h(
    "section",
    { class: "card nf" },
    h(
      "div",
      { class: "nfh" },
      iconBox("search"),
      h(
        "div",
        null,
        h("h2", null, `No match on ${view.label.toLowerCase()}`),
        h("p", null, noneWhy(context, result)),
      ),
      h("span", { class: "bdg warn a-end" }, "not found"),
    ),
    h(
      "div",
      { class: "g3" },
      other === undefined
        ? null
        : miniCard(
            `${other.prefix}/search?q=${encodeURIComponent(q)}`,
            "globe",
            `Search ${other.label.toLowerCase()}`,
            `same search on ${other.network}`,
          ),
      h(
        "a",
        { class: "mnc", href: expert, target: "_blank", rel: "noopener" },
        iconBox("external"),
        h(
          "span",
          null,
          h("b", null, "Open in stellar.expert"),
          h(
            "small",
            null,
            result.kind === "tx" || result.kind === "address"
              ? "see it on the full ledger"
              : "the full Stellar ledger",
          ),
        ),
      ),
      miniCard(
        `${bazaarPrefix}/services`,
        "bazaar",
        "Browse the Bazaar",
        context.bazaar ? "every listed service" : "on testnet",
      ),
    ),
  );
}

export function searchResultsPage(context: PageContext, model: SearchPageModel): string {
  const view = context.layout.view;
  const result = model.result;
  const q = result.q;
  const counts = new Map(result.groups.map((group) => [group.id, group.items.length]));
  const shown =
    model.type === "all" ? result.groups : result.groups.filter((group) => group.id === model.type);
  const flat = shown.flatMap((group) =>
    group.items.map((item, index) => ({
      item,
      head: model.type === "all" && index === 0 ? group : undefined,
    })),
  );
  const pages = Math.max(1, Math.ceil(flat.length / SEARCH_PER_PAGE));
  const current = Math.min(model.page, pages);
  const rows = flat.slice((current - 1) * SEARCH_PER_PAGE, current * SEARCH_PER_PAGE);
  const content: Child[] = [];
  if (result.kind === "short")
    content.push(
      card(
        { title: "Keep typing", icon: "search" },
        h("p", { class: "muted" }, "At least 3 characters: a hash, an address, a service or a facilitator."),
      ),
    );
  else if (result.total > 0)
    content.push(
      h(
        "section",
        { class: "card res" },
        h(
          "div",
          { class: "rhead" },
          h(
            "h2",
            null,
            groupThousands(result.total),
            " ",
            h("span", { class: "muted a-rq" }, `results for “${q}”`),
          ),
          seg("Result type", [
            {
              label: "All",
              href: searchHref(context, q, "all"),
              on: model.type === "all",
              count: result.total,
            },
            ...result.groups.map((group) => ({
              label: group.label,
              href: searchHref(context, q, group.id),
              on: model.type === group.id,
              count: counts.get(group.id) ?? 0,
            })),
          ]),
        ),
        result.bazaarDown
          ? h("p", { class: "muted a-sub" }, "The Bazaar did not answer: services may be missing.")
          : null,
        h(
          "div",
          { class: "slist" },
          rows.map(({ item, head }) => [
            head === undefined
              ? null
              : h("div", { class: "shd" }, `${head.label} · ${groupThousands(head.items.length)}`),
            resultRow(item),
          ]),
        ),
        pager({
          page: current,
          pages,
          total: flat.length,
          perPage: SEARCH_PER_PAGE,
          href: (n) => searchHref(context, q, model.type, n),
        }),
      ),
    );
  else if (result.kind !== "empty") content.push(notFound(context, result));
  else
    content.push(
      h(
        "div",
        { class: "g4" },
        model.starts.map((start) => miniCard(start.href, start.icon, start.title, start.sub)),
      ),
    );
  return page(
    {
      ...context.layout,
      title: q === "" ? "Search" : `Search “${displayText(q, 60)}”`,
      path: `/search${q === "" ? "" : `?q=${encodeURIComponent(q)}`}`,
      section: "search",
    },
    h(
      "section",
      { class: "ph2 sh2" },
      h(
        "div",
        { class: "a-full" },
        h("h1", null, "Search"),
        h(
          "form",
          { role: "search", class: "sbox", action: `${view.prefix}/search`, method: "get" },
          svgIcon("search"),
          h("label", { class: "sr", for: "sq" }, `Search ${view.label}`),
          h("input", {
            id: "sq",
            name: "q",
            type: "search",
            value: q === "" ? undefined : q,
            maxlength: 300,
            autocomplete: "off",
            spellcheck: "false",
            placeholder: "Transaction, account, service or facilitator",
          }),
          q === ""
            ? null
            : h(
                "a",
                { class: "sclr", href: `${view.prefix}/search`, "aria-label": "Clear search" },
                svgIcon("cross"),
              ),
        ),
        h(
          "div",
          { class: "bl" },
          q === "" || KIND_LABELS[result.kind] === ""
            ? null
            : bdg(`looks like: ${KIND_LABELS[result.kind]}`, "info"),
          model.tries.length === 0 ? null : h("span", { class: "muted a-try" }, "Try"),
          model.tries.map((entry) =>
            h("a", { class: "tryb", href: searchHref(context, entry.q, "all") }, entry.title),
          ),
        ),
      ),
    ),
    ...content,
  );
}
