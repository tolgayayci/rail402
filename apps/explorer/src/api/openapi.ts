import { CHECKS, EXCLUSION_REASONS } from "@rail402.dev/x402-index";
import { explorerCodes } from "./codes.ts";
import { MAX_LIMIT, DEFAULT_LIMIT } from "./paging.ts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const strkey = { type: "string", pattern: "^[GC][A-Z2-7]{55}$" };
const atomic = { type: "string", pattern: "^\\d+$", description: "Atomic units, as a decimal string." };

const network = {
  name: "network",
  in: "path",
  required: true,
  schema: { type: "string", enum: ["pubnet", "testnet"] },
};
const cursor = {
  name: "cursor",
  in: "query",
  schema: { type: "string" },
  description: "The `nextCursor` of the previous page. Pages are keyset-based; `offset` is refused.",
};
const limit = {
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
};

const errorResponses = (...codes: (keyof typeof explorerCodes)[]) =>
  Object.fromEntries(
    [...new Set(codes.map((code) => explorerCodes[code].status))].map((status) => [
      String(status),
      {
        description: codes
          .filter((code) => explorerCodes[code].status === status)
          .map((code) => `\`${code}\`: ${explorerCodes[code].reason}`)
          .join(" "),
        content: { "application/json": { schema: ref("Error") } },
      },
    ]),
  );

const ok = (schema: object, description: string) => ({
  "200": { description, content: { "application/json": { schema } } },
});

const common = ["explorer_rate_limited", "explorer_unavailable", "explorer_internal_error"] as const;

/** The read API's OpenAPI 3.1 document, served at /api/v1/openapi.json. */
export function openApiDocument(publicUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Rail402 Explorer read API",
      version: "1",
      description:
        "Read-only, unauthenticated access to x402 settlements on Stellar indexed from public ledgers under the published indexing rules. Every response is an audit aid: verify the transaction on chain. Rate-limited per client; lists are keyset-paginated with at most 100 items.",
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: publicUrl }],
    paths: {
      "/api/v1/{network}/transactions/{hash}": {
        get: {
          summary: "One transaction by its outer or inner hash",
          description:
            "Looks the hash up in the index; a hash not indexed yet is read live from the network's RPC and classified with the same rules (`source: live`, never cached). Upper-case hashes redirect (301) to lower case.",
          parameters: [
            network,
            {
              name: "hash",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
          ],
          responses: {
            ...ok(ref("TransactionAnswer"), "The transaction as the rules classify it."),
            ...errorResponses(
              "explorer_not_found",
              "explorer_lookup_busy",
              "explorer_lookup_unavailable",
              ...common,
            ),
          },
        },
      },
      "/api/v1/{network}/accounts/{address}": {
        get: {
          summary: "An account's totals per asset and registry entries",
          parameters: [network, { name: "address", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            ...ok(ref("AccountAnswer"), "Totals as payer and as seller, per asset."),
            ...errorResponses("explorer_not_found", ...common),
          },
        },
      },
      "/api/v1/{network}/accounts/{address}/settlements": {
        get: {
          summary: "An account's settlements, newest first",
          parameters: [
            network,
            { name: "address", in: "path", required: true, schema: { type: "string" } },
            {
              name: "role",
              in: "query",
              schema: { type: "string", enum: ["any", "payer", "payTo"], default: "any" },
            },
            {
              name: "muxed",
              in: "query",
              schema: { type: "string", pattern: "^\\d{1,20}$" },
              description: "Only payments to this muxed id of the account.",
            },
            cursor,
            limit,
          ],
          responses: {
            ...ok(ref("SettlementPage"), "One page."),
            ...errorResponses(
              "explorer_not_found",
              "explorer_invalid_parameter",
              "explorer_invalid_limit",
              "explorer_offset_unsupported",
              "explorer_invalid_cursor",
              ...common,
            ),
          },
        },
      },
      "/api/v1/{network}/facilitators": {
        get: {
          summary: "The facilitator registry with each facilitator's report totals",
          parameters: [network],
          responses: {
            ...ok({ type: "object" }, "Registry entries."),
            ...errorResponses("explorer_not_found", ...common),
          },
        },
      },
      "/api/v1/{network}/facilitators/{id}": {
        get: {
          summary: "One facilitator: registry entry, accounts with evidence, totals",
          parameters: [
            network,
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
            },
          ],
          responses: {
            ...ok({ type: "object" }, "The facilitator."),
            ...errorResponses("explorer_not_found", ...common),
          },
        },
      },
      "/api/v1/{network}/facilitators/{id}/settlements": {
        get: {
          summary: "A facilitator's settlements, newest first",
          parameters: [
            network,
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            cursor,
            limit,
          ],
          responses: {
            ...ok(ref("SettlementPage"), "One page."),
            ...errorResponses(
              "explorer_not_found",
              "explorer_invalid_limit",
              "explorer_offset_unsupported",
              "explorer_invalid_cursor",
              ...common,
            ),
          },
        },
      },
      "/api/v1/{network}/settlements": {
        get: {
          summary: "Payments newest first, by facilitator, scheme, asset and time",
          description:
            "Without `facilitator`, attributed payments (registered facilitators, Rail402 included); `facilitator=shaped` lists unattributed x402-shaped payments apart. A cursor is bound to its filters.",
          parameters: [
            network,
            {
              name: "facilitator",
              in: "query",
              schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$" },
              description: "A registry facilitator id, or `shaped` for unattributed x402-shaped payments.",
            },
            { name: "scheme", in: "query", schema: { type: "string", enum: ["exact", "upto"] } },
            {
              name: "asset",
              in: "query",
              schema: { type: "string", pattern: "^C[A-Z2-7]{55}$" },
              description: "A token contract id.",
            },
            {
              name: "time",
              in: "query",
              schema: { type: "string", enum: ["24h", "7d", "30d"] },
              description: "Only payments closed within this window.",
            },
            cursor,
            limit,
          ],
          responses: {
            ...ok(ref("SettlementPage"), "One page."),
            ...errorResponses(
              "explorer_not_found",
              "explorer_invalid_parameter",
              "explorer_invalid_limit",
              "explorer_offset_unsupported",
              "explorer_invalid_cursor",
              ...common,
            ),
          },
        },
      },
      "/api/v1/{network}/report": {
        get: {
          summary: "The Ecosystem Report's numbers",
          description:
            "Totals for the indexed ledger range, computed exactly as `pnpm explorer:rebuild` computes them for the same range; `manifestSha256` equals the hash that command prints.",
          parameters: [network],
          responses: {
            ...ok(ref("Report"), "The report."),
            ...errorResponses("explorer_not_found", "explorer_report_unavailable", ...common),
          },
        },
      },
      "/api/v1/{network}/manifest": {
        get: {
          summary: "The report's manifest.json, byte for byte as a rebuild writes it",
          parameters: [network],
          responses: {
            ...ok({ type: "object" }, "The manifest."),
            ...errorResponses("explorer_not_found", "explorer_report_unavailable", ...common),
          },
        },
      },
      "/api/v1/{network}/network-window/manifest": {
        get: {
          summary:
            "The network-wide window's manifest.json, byte for byte as its rebuildCommand writes it; explorer_not_found while no window is published",
          parameters: [network],
          responses: {
            ...ok({ type: "object" }, "The window's manifest."),
            ...errorResponses("explorer_not_found", "explorer_report_unavailable", ...common),
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "reason", "retryable"],
              properties: {
                code: { type: "string", enum: Object.keys(explorerCodes) },
                reason: { type: "string", minLength: 1 },
                retryable: { type: "boolean" },
              },
            },
          },
        },
        Settlement: {
          type: "object",
          description: "One settlement row, as `@rail402.dev/x402-index` classifies it.",
          properties: {
            network: { type: "string", enum: ["stellar:testnet", "stellar:pubnet"] },
            epoch: { type: "string" },
            ledger: { type: "integer" },
            txIndex: { type: "integer" },
            txHash: { type: "string" },
            innerHash: nullable({ type: "string" }),
            closedAt: { type: "string", format: "date-time" },
            scheme: { type: "string", enum: ["exact", "upto"] },
            ruleId: { type: "string", enum: ["R-EXACT", "R-UPTO", "R-UPTO-BETA"] },
            rulesVersion: { type: "string" },
            registryVersion: { type: "string" },
            asset: {
              type: "object",
              description:
                "`code` and `issuer` are set only when `verified`: the token's contract id is that asset's Stellar Asset Contract.",
              properties: {
                contract: strkey,
                code: nullable({ type: "string" }),
                issuer: nullable(strkey),
                verified: { type: "boolean" },
              },
            },
            payer: strkey,
            payerKind: { type: "string", enum: ["G", "C"] },
            payTo: strkey,
            payToMuxedId: nullable({ type: "string" }),
            amount: atomic,
            maxAmount: nullable(atomic),
            upto: nullable({ type: "object", properties: { contract: strkey, authority: strkey } }),
            fee: {
              type: "object",
              properties: {
                bump: { type: "boolean" },
                payer: strkey,
                innerSource: strkey,
                opSource: strkey,
                chargedStroops: atomic,
                sponsored: { type: "boolean" },
              },
            },
            attribution: {
              type: "object",
              properties: {
                tier: { type: "string", enum: ["rail402", "rail402-beta", "facilitator", "shaped"] },
                facilitatorId: nullable({ type: "string" }),
                evidenceUrl: nullable({ type: "string", format: "uri" }),
              },
            },
            checks: { type: "array", items: { type: "string", enum: Object.keys(CHECKS) } },
          },
        },
        TransactionAnswer: {
          type: "object",
          required: ["network", "hash", "source", "kind", "versions", "links"],
          properties: {
            network: { type: "string" },
            hash: { type: "string" },
            source: { type: "string", enum: ["index", "live"] },
            kind: { type: "string", enum: ["settlement", "failed_attempt", "not_x402"] },
            settlement: ref("Settlement"),
            failedAttempt: { type: "object" },
            notX402: {
              type: "object",
              properties: {
                ledger: { type: "integer" },
                closedAt: { type: "string" },
                exclusion: nullable({ type: "string", enum: [...EXCLUSION_REASONS] }),
              },
            },
            versions: {
              type: "object",
              properties: { rules: { type: "string" }, registry: { type: "string" } },
            },
            links: { type: "object" },
          },
        },
        AccountAnswer: {
          type: "object",
          properties: {
            totals: {
              type: "array",
              description:
                "Totals per asset, at most 100 per side (payer, payTo): verified Stellar assets first, then by payments.",
              items: { type: "object" },
            },
            moreTotals: {
              type: "object",
              description: "How many assets each side has beyond those listed in totals.",
              properties: { payer: { type: "integer" }, payTo: { type: "integer" } },
            },
          },
        },
        SettlementPage: {
          type: "object",
          required: ["items", "nextCursor"],
          properties: {
            items: { type: "array", maxItems: MAX_LIMIT, items: ref("Settlement") },
            nextCursor: nullable({ type: "string" }),
          },
        },
        Report: {
          type: "object",
          required: [
            "network",
            "scope",
            "headlineScope",
            "range",
            "aggregates",
            "manifestSha256",
            "rebuildCommand",
            "auditCommand",
          ],
          properties: {
            network: { type: "string" },
            epoch: { type: "string" },
            scope: {
              type: "string",
              enum: ["registry"],
              description:
                "registry: only the ledgers that hold transactions of the registry's facilitator accounts and upto contracts are read. Unattributed shaped totals across every ledger of the range come only from a full-scan rebuild (auditCommand).",
            },
            headlineScope: {
              type: "string",
              enum: ["registered-facilitators"],
              description:
                "What aggregates.headline measures: settlements of the facilitators in the public registry, Rail402 included (aggregates.rail402 on its own). A facilitator outside the registry is never read, so this is not every x402 payment on the network.",
            },
            range: { type: "object", properties: { from: { type: "integer" }, to: { type: "integer" } } },
            aggregates: {
              type: "object",
              description:
                "The rebuild's aggregates.json for the ledgers the manifest lists: headline (registered facilitators, Rail402 included), rail402, unattributedShaped (a lower bound), rail402Beta and selfPayments, each apart.",
            },
            manifestSha256: { type: "string" },
            detachedFrom: nullable({
              type: "integer",
              description: "The first candidate ledger the report leaves out, or null.",
            }),
            coverageStop: nullable({
              type: "string",
              enum: ["pending", "failed"],
              description:
                "Why the range stops before detachedFrom: a candidate ledger not read yet, or one that failed an integrity check.",
            }),
            failedLedgers: {
              type: "array",
              items: { type: "integer" },
              description:
                "Candidate ledgers of the epoch that failed an integrity check; the report stops before the first.",
            },
            discovery: {
              type: "object",
              description:
                "How the ledgers were selected (source, routes, the source's index generations and decoders), how many of them held no attributed row (ledgersWithoutAttributedRow), and where their bytes came from (data lake or RPC; each verified against its own hashes).",
            },
            reproducible: {
              type: "boolean",
              description:
                "Every covered row carries the current rules and registry versions and no candidate ledger failed, so a rebuild of the manifest's ledger list gives the same totals and files.",
            },
            rebuildCommand: {
              type: "string",
              description: "Rebuilds this manifest from the public data lake, from the ledgers it lists.",
            },
            networkWide: nullable({
              type: "object",
              description:
                "Network-wide (sampled window): every ledger of a recent window (window.from to window.to, closed window.firstClosedAt to window.lastClosedAt) rebuilt in full from the public data lake, so it counts every facilitator, registered or not. tiers.rail402, tiers.otherRegistered and tiers.unattributed (x402-shaped with no registry account; may include transfers that are not x402 payments), self-payments apart. rebuildCommand reproduces manifestSha256 (the manifest is at /api/v1/{network}/network-window/manifest). Null while the window job is off or has not run.",
              required: ["label", "scope", "window", "tiers", "manifestSha256", "rebuildCommand"],
              properties: {
                label: { type: "string", enum: ["network-wide (sampled window)"] },
                scope: { type: "string", enum: ["full"] },
                window: {
                  type: "object",
                  properties: {
                    hours: { type: "integer" },
                    from: { type: "integer" },
                    to: { type: "integer" },
                    ledgers: { type: "integer" },
                    firstClosedAt: { type: "string" },
                    lastClosedAt: { type: "string" },
                  },
                },
                tiers: {
                  type: "object",
                  properties: {
                    rail402: { type: "object" },
                    otherRegistered: { type: "object" },
                    unattributed: { type: "object" },
                  },
                },
                manifestSha256: { type: "string" },
                rebuildCommand: { type: "string" },
              },
            }),
            auditCommand: {
              type: "string",
              description:
                "Rebuilds every ledger of the range from the public data lake: a superset whose attributed rows must equal the report's.",
            },
          },
        },
      },
    },
  };
}
