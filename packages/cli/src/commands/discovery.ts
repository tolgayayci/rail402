import type { SearchHit } from "@rail402.dev/sdk";
import { listFlag, stringFlag } from "../args.ts";
import { usage } from "../codes.ts";
import type { CommandHandler } from "../command.ts";
import { clean, fields, pretty } from "../output.ts";
import { integerFlag, schemeFlag, typeFlag, withBuyer } from "./common.ts";

/** `rail402 search <query>`: natural-language search of the Bazaar. Never signs. */
export const search: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: false }, async ({ buyer }) => {
      const { flags } = input.parsed;
      const query = input.parsed.positionals[0] ?? "";
      const type = typeFlag(flags);
      const scheme = schemeFlag(flags);
      const limit = integerFlag(flags, "limit", 1, 50);
      const maxPrice = stringFlag(flags, "max-price");
      if (maxPrice !== undefined && !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(maxPrice)) {
        throw usage("--max-price is a decimal amount, e.g. 0.05.");
      }
      const filters = {
        type,
        scheme,
        limit,
        maxPrice,
        asset: stringFlag(flags, "asset"),
        payTo: stringFlag(flags, "pay-to"),
        cursor: stringFlag(flags, "cursor"),
      };
      const page = await buyer.search(query, filters, input.signal);
      const result = {
        query,
        hits: page.hits,
        nextCursor: page.nextCursor,
        partialResults: page.partialResults,
        method: page.method ?? null,
      };
      return {
        result,
        human: () => {
          const lines = page.hits.map((hit, index) => hitText(hit, index + 1));
          if (lines.length === 0) lines.push("No results.");
          if (page.partialResults) lines.push("(partial results: part of the search was unavailable)");
          if (page.nextCursor !== null) lines.push(`next page: --cursor ${page.nextCursor}`);
          return lines.join("\n\n");
        },
      };
    }),
};

/** `rail402 resources`: the catalog, with the discovery spec's filters. Never signs. */
export const resources: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: false }, async ({ buyer }) => {
      const { flags } = input.parsed;
      const extensions = listFlag(flags, "extensions").flatMap((item) =>
        item
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== ""),
      );
      const asOf = stringFlag(flags, "as-of");
      if (asOf !== undefined && Number.isNaN(Date.parse(asOf))) {
        throw usage("--as-of is an ISO date-time, e.g. 2026-09-30T12:00:00Z.");
      }
      const filters = {
        type: typeFlag(flags),
        payTo: stringFlag(flags, "pay-to"),
        scheme: schemeFlag(flags),
        extensions: extensions.length === 0 ? undefined : extensions,
        limit: integerFlag(flags, "limit", 1, 100),
        offset: integerFlag(flags, "offset", 0, 1_000_000),
        asOf,
      };
      const page = await buyer.list(filters, input.signal);
      const { pagination } = page;
      return {
        result: { hits: page.hits, pagination },
        human: () => {
          const lines = page.hits.map((hit, index) => hitText(hit, pagination.offset + index + 1));
          const shown = page.hits.length;
          lines.push(
            shown === 0
              ? `No resources (total ${String(pagination.total)}).`
              : `${String(pagination.offset + 1)}-${String(pagination.offset + shown)} of ${String(pagination.total)}${pagination.asOf === undefined ? "" : ` as of ${pagination.asOf}`}`,
          );
          return lines.join("\n\n");
        },
      };
    }),
};

/** `rail402 listing <id> [--versions]`: one listing, and optionally its public version history. */
export const listing: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: false }, async ({ buyer }) => {
      const id = input.parsed.positionals[0] ?? "";
      const withVersions = input.parsed.flags["versions"] === true;
      const [found, versions] = await Promise.all([
        buyer.listing(id, input.signal),
        withVersions ? buyer.listingVersions(id, input.signal) : Promise.resolve(undefined),
      ]);
      return {
        result: { listing: found, ...(versions === undefined ? {} : { versions }) },
        human: () => {
          const lines = [
            hitText(found, undefined),
            fields([
              ["state", found.state],
              ["owner", found.owner],
              ["updated", found.lastUpdated],
            ]),
          ];
          if (found.input.schema !== null && found.input.schema !== undefined) {
            lines.push(`input schema:\n${pretty(found.input.schema)}`);
          }
          if (found.output.example !== null && found.output.example !== undefined) {
            lines.push(`output example:\n${pretty(found.output.example)}`);
          }
          if (versions !== undefined) {
            lines.push(
              [
                "versions:",
                ...versions.map(
                  (version) =>
                    `  v${String(version.version)}  ${clean(version.createdAt)}  ${clean(version.cause)}  ${clean(version.state)}${version.transaction === undefined ? "" : `  ${clean(version.transaction)}`}`,
                ),
              ].join("\n"),
            );
          }
          return lines.join("\n\n");
        },
      };
    }),
};

/** A search hit as a few lines of text. Seller text arrives sanitized from the SDK and is cleaned again. */
export function hitText(hit: SearchHit, position: number | undefined): string {
  const name = hit.seller.serviceName ?? (hit.toolName === null ? hit.resource : hit.toolName);
  const kind = hit.type === "mcp" ? `mcp ${hit.toolName ?? ""}`.trim() : `${hit.type} ${hit.method ?? "GET"}`;
  const price = hit.prices[0];
  const priceText =
    price === undefined ? "no price on this network" : `${price.amount ?? price.atomic} ${price.asset}`;
  const lines = [
    `${position === undefined ? "" : `${String(position)}. `}${clean(name, 120)}  [${clean(kind, 80)}]  ${clean(priceText, 120)}`,
    `   ${clean(hit.resource, 500)}`,
  ];
  if (hit.seller.description !== null) lines.push(`   ${clean(hit.seller.description, 200)}`);
  const notes = [
    `trust ${hit.trust}`,
    `${String(hit.settlements)} settlement${hit.settlements === 1 ? "" : "s"}`,
    hit.withinPolicy ? "within policy" : "outside policy",
    ...(hit.callable ? [] : [`not callable: ${clean(hit.notCallableReason ?? "unknown", 120)}`]),
  ];
  lines.push(`   ${notes.join(", ")}`);
  if (hit.listingId !== null) lines.push(`   listing ${hit.listingId}`);
  return lines.join("\n");
}
