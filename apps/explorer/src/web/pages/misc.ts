import { CHECKS, RULES_VERSION, type RegistrySnapshot } from "@rail402.dev/x402-index";
import { FONT_FAMILIES } from "../assets.ts";
import type { Listing } from "../bazaar.ts";
import {
  badge,
  body,
  externalLink,
  h,
  layout,
  listingTitle,
  note,
  pageHead,
  panel,
  rows,
  row,
  schemeBadge,
  shortAddress,
  table,
  tierBadge,
  type Child,
  type LayoutOptions,
} from "../components.ts";
import type { NetworkView } from "../format.ts";
import { displayText } from "../text.ts";
import { listingPrice, type PageContext } from "./context.ts";
import { bigSearch, type SearchScope } from "./home.ts";

type Base = Omit<LayoutOptions, "title" | "path" | "section">;

export function methodologyPage(
  options: Base,
  registries: readonly RegistrySnapshot[],
  views: readonly NetworkView[],
): string {
  const checks = Object.entries(CHECKS);
  return layout(
    { ...options, section: "methodology", title: "Methodology", path: "/methodology" },
    body(
      pageHead(
        { eyebrow: "Methodology" },
        h("h1", null, "How the Explorer decides what is an x402 payment"),
        h(
          "p",
          null,
          "The Explorer reads ledgers from the public Stellar data lake and RPC, checks each one against its own hashes and the ledger before it, and classifies its transactions under published, versioned indexing rules. The rules, the facilitator registry and the code are public; anyone can rebuild every row and every total from the same ledgers. ",
          externalLink("https://docs.rail402.dev/reference/indexing-rules", "Read the full rules"),
          " · ",
          externalLink("https://docs.rail402.dev/reference/explorer-rebuild", "rebuild the data"),
          ".",
        ),
      ),
      panel(
        { title: `Rule checks (rules v${RULES_VERSION})`, id: "checks" },
        note(
          "E checks define an exact settlement (R-EXACT), U checks an upto settlement through a registered contract (R-UPTO), B checks the concluded beta's contract (R-UPTO-BETA).",
        ),
        checks.map(([id, text]) =>
          h("div", { class: "check" }, h("span", { class: "id" }, id), h("span", { class: "text" }, text)),
        ),
      ),
      panel(
        { title: "Attribution tiers", id: "tiers" },
        rows(
          undefined,
          row(
            "Rail402 hosted",
            tierBadge("rail402"),
            "The fee payer or a source is an account of the hosted Rail402 service in that ledger. Counted in the registered-facilitator totals and shown on its own.",
          ),
          row(
            "Facilitator",
            tierBadge("facilitator"),
            "The account belongs to another facilitator, backed by public evidence archived with its SHA-256. Counted in the registered-facilitator totals.",
          ),
          row(
            "Concluded beta",
            tierBadge("rail402-beta"),
            "The account belongs to the concluded Rail402 beta. Shown as history only.",
          ),
          row(
            "Unattributed",
            tierBadge("shaped"),
            "No registry account matched. The exact scheme leaves no on-chain x402 marker, so these are shown apart and never counted in the totals. The index reads only the ledgers of registry accounts, so their count is a lower bound.",
          ),
        ),
        note(
          "An asset is marked verified only when the token's contract id is the Stellar Asset Contract of the asset its events name. Any other token is a custom token, whatever it calls itself.",
        ),
      ),
      panel(
        { title: "Three kinds of data, labelled", id: "sources" },
        rows(
          undefined,
          row(
            "Ledger index",
            "Every count, total and payment row: classified from verified ledger bytes, rebuildable from public data.",
          ),
          row(
            "Bazaar",
            badge("off chain", "grey"),
            "What a payment paid for, listings, prices and their history, read from the Rail402 Bazaar's public API. Never counted.",
          ),
          row(
            "Live",
            badge("Live · not audited", "live"),
            "Current balances from Lumeus, refreshed every few minutes. Context only, never counted.",
          ),
        ),
      ),
      panel(
        { title: "Registries", id: "registries" },
        rows(
          undefined,
          registries.map((registry, index) =>
            row(
              views[index]?.label ?? registry.network,
              `Registry ${registry.registryVersion}: ${String(registry.document.facilitators.length)} facilitators, ${String(registry.document.uptoContracts.length)} upto contracts`,
              h("a", { href: `${views[index]?.prefix ?? ""}/ecosystem` }, "report"),
            ),
          ),
        ),
        note(
          "Registry entries change only by reviewed commit, each with public evidence and a ledger range, so adding a facilitator later attributes past ledgers the same way on every rebuild.",
        ),
      ),
      panel(
        { title: "Typefaces", id: "fonts" },
        rows(
          undefined,
          FONT_FAMILIES.map((entry) =>
            row(
              entry.family,
              "SIL Open Font License 1.1 · ",
              h("a", { href: entry.licence.path }, "licence text"),
            ),
          ),
        ),
        note("Served from this site; no third-party font service is contacted."),
      ),
    ),
  );
}

export function errorPage(
  options: Base & { readonly path: string },
  status: number,
  code: string,
  reason: string,
  extra?: Child,
): string {
  return layout(
    { ...options, title: status === 404 ? "Not found" : "Unavailable" },
    body(
      pageHead(
        { eyebrow: `Error ${String(status)}` },
        h("h1", null, status === 404 ? "Nothing here" : "Try again shortly"),
        h("p", null, displayText(reason, 300)),
      ),
      extra ?? null,
      h("p", { class: "muted" }, "Code ", h("code", null, code)),
    ),
  );
}

/** Search results: listings that match an endpoint URL, an MCP tool name or a word. */
export function searchPage(
  context: PageContext,
  query: string,
  scope: SearchScope,
  matches: readonly Listing[],
  bazaarDown: boolean,
): string {
  const view = context.layout.view;
  return layout(
    { ...context.layout, title: "Search", path: "/search" },
    h("section", { class: "hero" }, h("div", { class: "wrap" }, bigSearch(view, query, scope))),
    body(
      pageHead(
        { eyebrow: "Search" },
        h(
          "h1",
          null,
          matches.length === 0
            ? "No match"
            : `${String(matches.length)} listing${matches.length === 1 ? "" : "s"} match`,
        ),
        h(
          "p",
          { class: "muted" },
          "Hashes open their payment and G…, C… or M… addresses their account. Endpoint URLs, MCP tool names and words are matched against the Bazaar's listings (off chain).",
        ),
      ),
      bazaarDown
        ? h(
            "p",
            { class: "notice", role: "status" },
            "The Bazaar did not answer, so listings could not be searched.",
          )
        : null,
      matches.length === 0
        ? null
        : panel(
            { title: "Listings", id: "matches" },
            table(
              "mid",
              [
                { label: "Resource" },
                { label: "Seller" },
                { label: "Scheme" },
                { label: "Price", num: true },
              ],
              matches.map((listing) =>
                h(
                  "tr",
                  null,
                  h(
                    "td",
                    null,
                    h(
                      "div",
                      { class: "cell" },
                      h(
                        "a",
                        { class: "mono", href: `${view.prefix}/resource/${listing.id}` },
                        listingTitle(listing),
                      ),
                      listing.description === undefined
                        ? null
                        : h("span", { class: "small muted" }, displayText(listing.description, 160)),
                    ),
                  ),
                  h("td", null, shortAddress(view, listing.payTo)),
                  h("td", null, schemeBadge(listing.scheme)),
                  h("td", { class: "num" }, listingPrice(context, listing)),
                ),
              ),
            ),
          ),
    ),
  );
}
