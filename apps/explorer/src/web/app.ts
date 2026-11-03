import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { routePath } from "hono/route";
import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { isRail402Error, type Rail402Error } from "@rail402.dev/errors";
import { RULES_VERSION, type IndexNetwork, type RegistrySnapshot } from "@rail402.dev/x402-index";
import { explorerCodes } from "../api/codes.ts";
import { openApiDocument } from "../api/openapi.ts";
import { explorerError, keyset } from "../api/paging.ts";
import {
  accountList,
  facilitatorList,
  paymentsList,
  type AccountRole,
  type ExplorerReader,
  type PaymentFilter,
} from "../api/queries.ts";
import { underCurrentRules, type ComputedReport } from "../api/report.ts";
import type { Epoch } from "../epoch.ts";
import { ASSETS, FAVICON_ASSET, LICENCE_ASSETS } from "./assets.ts";
import type { Answer, BazaarClient, BazaarSession, Listing, PaidFor } from "./bazaar.ts";
import { cacheHeaders, matchesEtag, type CacheKind, type Versions } from "./cache.ts";
import type { LayoutOptions } from "./components.ts";
import { securityHeaders } from "./csp.ts";
import {
  NETWORK_VIEWS,
  baseAccount,
  rpcCommand,
  stellarExpertTx,
  viewOfSlug,
  type NetworkView,
} from "./format.ts";
import type { HoldingsClient } from "./holdings.ts";
import type { LiveLookup } from "./live-lookup.ts";
import { TokenBuckets } from "./live-lookup.ts";
import type { WebMetrics } from "./metrics.ts";
import { accountPage } from "./pages/account.ts";
import type { PageContext } from "./pages/context.ts";
import { ecosystemPage } from "./pages/ecosystem.ts";
import { facilitatorPage, facilitatorsPage } from "./pages/facilitators.ts";
import { homePage, SEARCH_SCOPES, type SearchScope } from "./pages/home.ts";
import { errorPage, methodologyPage, searchPage } from "./pages/misc.ts";
import {
  paymentsCsv,
  paymentsPage,
  TIME_WINDOWS,
  type PaymentQuery,
  type TimeWindow,
} from "./pages/payments.ts";
import { resourcePage } from "./pages/resource.ts";
import { groupServices, serviceName, servicesPage, type Service } from "./pages/services.ts";
import { txPage, type TxModel } from "./pages/tx.ts";
import { clientKey } from "./client-key.ts";
import { HASH } from "./text.ts";

/** One network the Explorer serves. */
export interface ServedNetwork {
  readonly network: IndexNetwork;
  readonly registry: RegistrySnapshot;
  /** The epoch pages and lists show: the registry's newest. */
  readonly epoch: Epoch;
  /** Live lookups of hashes not indexed yet; off when undefined. */
  readonly lookup: LiveLookup | undefined;
  readonly publicRpcUrl: string;
  /** The Bazaar's read API: what payments bought, listings; no Bazaar data when undefined. */
  readonly bazaar?: BazaarClient | undefined;
  /** Live holdings (Lumeus Assets); off when undefined. */
  readonly holdings?: HoldingsClient | undefined;
}

/** The reads the pages and API make. */
export type ExplorerReads = Pick<
  ExplorerReader,
  | "settlement"
  | "failedAttempt"
  | "accountSettlements"
  | "accountTotals"
  | "facilitatorSettlements"
  | "payments"
  | "firstLedgerSince"
  | "settlementsByHash"
  | "sellerSummary"
  | "uptoReceived"
  | "sellerTotals"
  | "ping"
>;

export interface ExplorerAppOptions {
  readonly reader: ExplorerReads;
  readonly reports: { get(network: IndexNetwork): ComputedReport | undefined };
  readonly networks: readonly ServedNetwork[];
  /** Requests per client per minute, pages and API together. */
  readonly ratePerMinute: number;
  readonly trustedProxyHops?: number;
  /**
   * Requests served at once (default 32). Beyond it the Explorer answers 503 `explorer_unavailable`
   * with Retry-After instead of queueing without bound behind the database pool.
   */
  readonly maxInFlight?: number;
  /** `/health` asks the database at most once per this many milliseconds (default 2,000). */
  readonly healthIntervalMs?: number;
  readonly statusUrl?: string | undefined;
  /** The Explorer's public origin, for absolute links in API answers. */
  readonly publicUrl: string;
  readonly metrics?: WebMetrics;
  readonly now?: () => number;
  /** All Bazaar calls of one page request together wait at most this long (default 3,000 ms). */
  readonly bazaarBudgetMs?: number;
}

interface Served extends ServedNetwork {
  readonly view: NetworkView;
  readonly epochs: readonly string[];
  readonly versions: Versions;
}

const FACILITATOR_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EXEMPT = new Set([
  "/health",
  "/robots.txt",
  FAVICON_ASSET.path,
  ...ASSETS.map((asset) => asset.path),
  ...LICENCE_ASSETS.map((asset) => asset.path),
]);
/** How long after a payment the Bazaar may still link it to a listing. */
const CATALOG_GRACE_MS = 10 * 60_000;
/** Rows a CSV download holds at most. */
const CSV_ROWS = 500;

/** The client address: X-Forwarded-For as the outermost trusted proxy saw it, else the socket's peer. */
export function clientAddress(c: Context, trustedHops: number): string {
  if (trustedHops > 0) {
    const forwarded = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const address = forwarded[forwarded.length - trustedHops];
    if (address !== undefined) return address;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Rejects when `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("timed out"));
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/** The Explorer's public pages and read API. Read-only: every handler only reads. */
export function createExplorerApp(options: ExplorerAppOptions): Hono {
  const app = new Hono({ strict: false });
  const served = new Map<IndexNetwork, Served>(
    options.networks.map((entry) => [
      entry.network,
      {
        ...entry,
        view: NETWORK_VIEWS[entry.network],
        epochs: [...entry.registry.document.epochs].reverse().map((epoch) => epoch.id),
        versions: { rules: RULES_VERSION, registry: entry.registry.registryVersion },
      },
    ]),
  );
  /**
   * The network's report, only when it was computed under the current rules, and without a network
   * window of other rules: totals of other rules can count payers these rules never proved.
   */
  const currentReport = (network: IndexNetwork): ComputedReport | undefined => {
    const report = options.reports.get(network);
    if (report === undefined || !underCurrentRules(report)) return undefined;
    const window = report.document.networkWide;
    if (window === undefined || window === null || window.rulesVersion === RULES_VERSION) return report;
    return {
      document: { ...report.document, networkWide: null },
      manifest: report.manifest,
      manifestText: report.manifestText,
      aggregatesText: report.aggregatesText,
    };
  };
  const views = [...served.values()].map((entry) => entry.view).sort((a) => (a.slug === "pubnet" ? -1 : 1));
  const limiter = new TokenBuckets(
    options.ratePerMinute,
    options.now === undefined ? {} : { now: options.now },
  );
  const sweeper = setInterval(() => {
    limiter.sweep();
  }, 60_000);
  sweeper.unref();
  const hops = options.trustedProxyHops ?? 0;
  const isApi = (c: Context) => c.req.path.startsWith("/api/");

  const layoutFor = (entry: Served): Omit<LayoutOptions, "title" | "path"> => ({
    view: entry.view,
    networks: views,
    versions: entry.versions,
  });
  const defaultServed = served.get("stellar:pubnet") ?? [...served.values()][0];

  function send(
    c: Context,
    body: string,
    type: "html" | "json" | "text" | "csv",
    kind: CacheKind,
    versions: Versions,
    status = 200,
  ) {
    const headers = cacheHeaders(kind, versions, body);
    c.header("Cache-Control", headers["Cache-Control"]);
    if (headers.ETag !== undefined) {
      c.header("ETag", headers.ETag);
      if (status === 200 && matchesEtag(c.req.header("if-none-match"), headers.ETag))
        return c.body(null, 304);
    }
    c.header(
      "Content-Type",
      type === "html"
        ? "text/html; charset=utf-8"
        : type === "json"
          ? "application/json; charset=utf-8"
          : type === "csv"
            ? "text/csv; charset=utf-8"
            : "text/plain; charset=utf-8",
    );
    return c.body(body, status as 200);
  }
  const json = (c: Context, value: unknown, kind: CacheKind, versions: Versions) =>
    send(c, JSON.stringify(value), "json", kind, versions);

  /** The served network of an API path segment, or not found. */
  function apiNetwork(slug: string): Served {
    const view = viewOfSlug(slug);
    const entry = view === undefined ? undefined : served.get(view.network);
    if (entry === undefined)
      throw explorerError("explorer_not_found", { reason: "This Explorer does not serve that network." });
    return entry;
  }

  // --- every request -----------------------------------------------------------------------------
  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const matched = routePath(c as Context, -1);
    const route = matched === "*" || matched === "" ? "unmatched" : matched;
    options.metrics?.requests.inc({ route, status: String(c.res.status) });
    options.metrics?.seconds.observe({ route }, (performance.now() - started) / 1000);
  });
  app.use("*", securityHeaders());
  let inFlight = 0;
  const maxInFlight = options.maxInFlight ?? 32;
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") throw explorerError("explorer_method_not_allowed");
    if (EXEMPT.has(c.req.path)) {
      await next();
      return;
    }
    const wait = limiter.take(clientKey(clientAddress(c as Context, hops)));
    if (wait > 0) {
      options.metrics?.rateLimited.inc();
      throw explorerError("explorer_rate_limited", { details: { retryAfter: wait } });
    }
    if (inFlight >= maxInFlight) {
      throw explorerError("explorer_unavailable", {
        reason: "The Explorer is answering as many requests as it can; retry shortly.",
        details: { retryAfter: 1 },
      });
    }
    inFlight++;
    try {
      await next();
    } finally {
      inFlight--;
    }
  });

  app.onError((error, c) => {
    const known: Rail402Error =
      isRail402Error(error) && Object.hasOwn(explorerCodes, error.code)
        ? error
        : explorerError("explorer_internal_error", { cause: error });
    const retryAfter = known.details?.["retryAfter"];
    if (typeof retryAfter === "number") c.header("Retry-After", String(retryAfter));
    const body = { error: { code: known.code, reason: known.reason, retryable: known.retryable } };
    const versions = { rules: RULES_VERSION, registry: "none" };
    if (isApi(c)) return send(c, JSON.stringify(body), "json", "volatile", versions, known.status);
    const entry =
      (c.req.path.startsWith("/testnet") ? served.get("stellar:testnet") : undefined) ?? defaultServed;
    if (entry === undefined) return send(c, known.reason, "text", "volatile", versions, known.status);
    return send(
      c,
      errorPage({ ...layoutFor(entry), path: "" }, known.status, known.code, known.reason),
      "html",
      "volatile",
      versions,
      known.status,
    );
  });
  app.notFound(() => {
    throw explorerError("explorer_not_found");
  });

  // --- static --------------------------------------------------------------------------------------
  for (const asset of ASSETS) {
    app.get(asset.path, (c) => {
      c.header("Cache-Control", "public, max-age=31536000, immutable, no-transform");
      c.header("Content-Type", asset.type);
      return typeof asset.body === "string" ? c.body(asset.body) : c.body(asset.body);
    });
  }
  for (const asset of LICENCE_ASSETS) {
    app.get(asset.path, (c) => {
      c.header("Cache-Control", "public, max-age=86400, no-transform");
      c.header("Content-Type", asset.type);
      return typeof asset.body === "string" ? c.body(asset.body) : c.body(asset.body);
    });
  }
  app.get(FAVICON_ASSET.path, (c) => {
    c.header("Cache-Control", "public, max-age=86400, no-transform");
    c.header("Content-Type", FAVICON_ASSET.type);
    return c.body(FAVICON_ASSET.body as string);
  });
  app.get("/robots.txt", (c) => {
    c.header("Cache-Control", "public, max-age=86400, no-transform");
    return c.text(
      "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /search\nDisallow: /testnet/search\nDisallow: /payments.csv\nDisallow: /testnet/payments.csv\nDisallow: /*?*cursor=\n",
    );
  });
  // /health is not rate-limited, so it shares one database probe per interval: a flood of health
  // checks takes at most one pool connection, and each probe gives the database one second.
  const healthInterval = options.healthIntervalMs ?? 2_000;
  let probe: { readonly at: number; readonly ok: Promise<boolean> } | undefined;
  const databaseOk = (): Promise<boolean> => {
    const now = (options.now ?? Date.now)();
    if (probe === undefined || now - probe.at >= healthInterval) {
      probe = {
        at: now,
        ok: withTimeout(options.reader.ping(), 1_000).then(
          () => true,
          () => false,
        ),
      };
    }
    return probe.ok;
  };
  app.get("/health", async (c) => {
    const database = (await databaseOk()) ? "ok" : "unavailable";
    const reports = Object.fromEntries(
      [...served.values()].map((entry) => {
        const report = currentReport(entry.network)?.document;
        return [
          entry.view.slug,
          report === undefined ? null : { to: report.range.to, generatedAt: report.generatedAt },
        ];
      }),
    );
    c.header("Cache-Control", "no-store");
    return c.json(
      { status: database === "ok" ? "ok" : "unavailable", database, reports },
      database === "ok" ? 200 : 503,
    );
  });

  // --- redirects ---------------------------------------------------------------------------------
  for (const alias of ["public", "pubnet", "mainnet"]) {
    const redirect = (c: Context) => {
      const url = new URL(c.req.url);
      // Only a same-origin path: leading slashes or backslashes would make `//host`, another origin.
      const rest = url.pathname.slice(alias.length + 1).replace(/^[/\\]+/, "");
      return c.redirect(`/${rest}${url.search}`, 301);
    };
    app.get(`/${alias}`, redirect);
    app.get(`/${alias}/*`, redirect);
  }

  // --- shared lookups ----------------------------------------------------------------------------
  async function resolveTx(entry: Served, hash: string, client: string): Promise<TxModel> {
    const row = await options.reader.settlement(entry.network, entry.epochs, hash);
    // A row of other rules is never shown as a settlement: it may name a payer these rules do not prove.
    // Until its ledger is indexed again, the transaction is looked up live and classified afresh.
    if (row !== undefined && row.rulesVersion === RULES_VERSION)
      return { kind: "settlement", row, live: false };
    const failed = await options.reader.failedAttempt(entry.network, entry.epochs, hash);
    if (failed !== undefined) return { kind: "failed", row: failed, live: false };
    if (entry.lookup === undefined) {
      throw explorerError("explorer_not_found", {
        reason: `This hash is not in the ${entry.view.label.toLowerCase()} index, and live lookups are off for this network.`,
      });
    }
    let outcome;
    try {
      outcome = await entry.lookup.lookup(hash, client);
    } catch (error) {
      options.metrics?.lookups.inc({
        network: entry.view.slug,
        outcome: isRail402Error(error) ? error.code : "error",
      });
      throw error;
    }
    if (outcome.kind === "not_found") {
      options.metrics?.lookups.inc({
        network: entry.view.slug,
        outcome: outcome.cached ? "cached_miss" : "miss",
      });
      throw explorerError("explorer_not_found", {
        reason: `Neither the ${entry.view.label.toLowerCase()} index nor the network's RPC (which keeps about the last seven days) knows this transaction. Check the network and the hash.`,
      });
    }
    options.metrics?.lookups.inc({ network: entry.view.slug, outcome: "found" });
    const { classification, ledger, closedAt } = outcome.result;
    if (classification.kind === "settlement")
      return { kind: "settlement", row: classification.row, live: true };
    if (classification.kind === "failed_attempt")
      return { kind: "failed", row: classification.row, live: true };
    return {
      kind: "not_x402",
      hash,
      ledger,
      closedAt,
      reason: classification.kind === "excluded" ? classification.reason : null,
    };
  }

  /**
   * How a transaction answer may be cached. A live lookup is never stored. An indexed settlement is
   * `final` only when its row carries the served rules and registry versions, with an ETag naming the
   * row's own versions; a row awaiting re-attribution, and a failed attempt, revalidate like a listing.
   */
  function txCaching(entry: Served, model: TxModel): { kind: CacheKind; versions: Versions } {
    if (model.kind === "not_x402" || model.live) return { kind: "volatile", versions: entry.versions };
    if (model.kind === "settlement") {
      const versions = { rules: model.row.rulesVersion, registry: model.row.registryVersion };
      const current =
        versions.rules === entry.versions.rules && versions.registry === entry.versions.registry;
      return { kind: current ? "final" : "listing", versions };
    }
    return { kind: "listing", versions: entry.versions };
  }

  /** A G… or C… address, a muxed M… address as its base account and id, or not found. */
  function parseAddress(raw: string): { address: string; muxedId?: string } {
    if (StrKey.isValidEd25519PublicKey(raw) || StrKey.isValidContract(raw)) return { address: raw };
    if (StrKey.isValidMed25519PublicKey(raw)) {
      const muxed = MuxedAccount.fromAddress(raw, "0");
      return { address: muxed.baseAccount().accountId(), muxedId: muxed.id() };
    }
    throw explorerError("explorer_not_found", {
      reason: "Accounts are G… or C… strkeys (an M… address opens its base account).",
    });
  }

  const queryOf = (c: Context): Record<string, string> => c.req.query();

  function accountRole(raw: string | undefined): AccountRole {
    if (raw === undefined || raw === "any") return "any";
    if (raw === "payer" || raw === "payTo") return raw;
    throw explorerError("explorer_invalid_parameter", { reason: "role is any, payer or payTo." });
  }

  /**
   * A muxed id names a receiving sub-account, so it filters the receiving side only: role `any` lists
   * payments to that muxed id, and `payer` with a muxed id is refused.
   */
  function muxedRole(role: AccountRole, muxedId: string | undefined): AccountRole {
    if (muxedId === undefined) return role;
    if (role === "payer") {
      throw explorerError("explorer_invalid_parameter", {
        reason: "muxed filters payments received by a muxed id; it cannot be combined with role=payer.",
      });
    }
    return "payTo";
  }

  function muxedParam(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    if (!/^\d{1,20}$/.test(raw) || BigInt(raw) > 18446744073709551615n) {
      throw explorerError("explorer_invalid_parameter", { reason: "muxed is a 64-bit unsigned integer." });
    }
    return raw;
  }

  function memberships(entry: Served, address: string) {
    return entry.registry.document.facilitators.flatMap((facilitator) =>
      facilitator.accounts
        .filter((account) => account.address === address)
        .map((account) => ({
          facilitatorId: facilitator.id,
          tier: facilitator.tier,
          role: account.role,
          epoch: account.epoch,
          validFromLedger: account.validFromLedger,
          validToLedger: account.validToLedger,
          evidence: account.evidence.map((item) => item.url),
        })),
    );
  }

  // --- JSON API ----------------------------------------------------------------------------------
  app.get("/api/v1/openapi.json", (c) =>
    json(c, openApiDocument(options.publicUrl), "listing", { rules: RULES_VERSION, registry: "api" }),
  );

  app.get("/api/v1/:network/transactions/:hash", async (c) => {
    const entry = apiNetwork(c.req.param("network"));
    const raw = c.req.param("hash");
    if (/^[0-9a-fA-F]{64}$/.test(raw) && raw !== raw.toLowerCase()) {
      return c.redirect(`/api/v1/${entry.view.slug}/transactions/${raw.toLowerCase()}`, 301);
    }
    if (!HASH.test(raw))
      throw explorerError("explorer_not_found", { reason: "A transaction hash is 64 hex characters." });
    keyset("tx", queryOf(c));
    const model = await resolveTx(entry, raw, clientAddress(c, hops));
    const live = model.kind === "not_x402" || model.live;
    const caching = txCaching(entry, model);
    return json(
      c,
      {
        network: entry.network,
        hash: raw,
        source: live ? "live" : "index",
        kind:
          model.kind === "settlement"
            ? "settlement"
            : model.kind === "failed"
              ? "failed_attempt"
              : "not_x402",
        ...(model.kind === "settlement" ? { settlement: model.row } : {}),
        ...(model.kind === "failed" ? { failedAttempt: model.row } : {}),
        ...(model.kind === "not_x402"
          ? { notX402: { ledger: model.ledger, closedAt: model.closedAt, exclusion: model.reason } }
          : {}),
        versions: entry.versions,
        links: {
          page: `${options.publicUrl}${entry.view.prefix}/tx/${raw}`,
          stellarExpert: stellarExpertTx(entry.view, raw),
          rpcCommand: rpcCommand(entry.publicRpcUrl, raw),
        },
      },
      caching.kind,
      caching.versions,
    );
  });

  app.get("/api/v1/:network/accounts/:address", async (c) => {
    const entry = apiNetwork(c.req.param("network"));
    const { address, muxedId } = parseAddress(c.req.param("address"));
    keyset("account", queryOf(c));
    const totals = await options.reader.accountTotals(entry.network, entry.epoch.id, address);
    return json(
      c,
      {
        network: entry.network,
        epoch: entry.epoch.id,
        account: address,
        ...(muxedId === undefined ? {} : { muxedId }),
        totals: totals.items,
        moreTotals: totals.more,
        registry: memberships(entry, address),
        versions: entry.versions,
      },
      "listing",
      entry.versions,
    );
  });

  app.get("/api/v1/:network/accounts/:address/settlements", async (c) => {
    const entry = apiNetwork(c.req.param("network"));
    const parsed = parseAddress(c.req.param("address"));
    const query = queryOf(c);
    const muxedId = muxedParam(query["muxed"]) ?? parsed.muxedId;
    const role = muxedRole(accountRole(query["role"]), muxedId);
    const page = keyset(accountList(entry.network, entry.epoch.id, parsed.address, role, muxedId), query, [
      "role",
      "muxed",
    ]);
    const result = await options.reader.accountSettlements(
      entry.network,
      entry.epoch.id,
      parsed.address,
      role,
      page,
      muxedId,
    );
    return json(
      c,
      {
        network: entry.network,
        epoch: entry.epoch.id,
        account: parsed.address,
        role,
        limit: page.limit,
        ...result,
      },
      "listing",
      entry.versions,
    );
  });

  app.get("/api/v1/:network/facilitators", (c) => {
    const entry = apiNetwork(c.req.param("network"));
    keyset("facilitators", queryOf(c));
    const report = currentReport(entry.network)?.document;
    return json(
      c,
      {
        network: entry.network,
        registryVersion: entry.registry.registryVersion,
        items: entry.registry.document.facilitators.map((facilitator) => ({
          id: facilitator.id,
          name: facilitator.name,
          tier: facilitator.tier,
          sharedRelayer: facilitator.sharedRelayer,
          totals: report?.aggregates.byFacilitator[facilitator.id] ?? null,
        })),
      },
      "listing",
      entry.versions,
    );
  });

  function facilitatorOf(entry: Served, id: string) {
    const facilitator = FACILITATOR_ID.test(id) ? entry.registry.facilitator(id) : undefined;
    if (facilitator === undefined)
      throw explorerError("explorer_not_found", {
        reason: "No facilitator with this id is in the registry.",
      });
    return facilitator;
  }

  app.get("/api/v1/:network/facilitators/:id", (c) => {
    const entry = apiNetwork(c.req.param("network"));
    const facilitator = facilitatorOf(entry, c.req.param("id"));
    keyset("facilitator", queryOf(c));
    const report = currentReport(entry.network)?.document;
    return json(
      c,
      {
        network: entry.network,
        registryVersion: entry.registry.registryVersion,
        facilitator,
        totals: report?.aggregates.byFacilitator[facilitator.id] ?? null,
        range: report?.range ?? null,
      },
      "listing",
      entry.versions,
    );
  });

  app.get("/api/v1/:network/facilitators/:id/settlements", async (c) => {
    const entry = apiNetwork(c.req.param("network"));
    const facilitator = facilitatorOf(entry, c.req.param("id"));
    const page = keyset(facilitatorList(entry.network, entry.epoch.id, facilitator.id), queryOf(c));
    const result = await options.reader.facilitatorSettlements(
      entry.network,
      entry.epoch.id,
      facilitator.id,
      page,
    );
    return json(
      c,
      {
        network: entry.network,
        epoch: entry.epoch.id,
        facilitator: facilitator.id,
        limit: page.limit,
        ...result,
      },
      "listing",
      entry.versions,
    );
  });

  /**
   * The payments list's filters from GET parameters: `facilitator` (a registry id, or `shaped`),
   * `scheme`, `asset` (a C… contract) and `time` (24h, 7d, 30d). Anything else is refused.
   */
  function paymentQuery(entry: Served, query: Readonly<Record<string, string>>): PaymentQuery {
    const out: { -readonly [K in keyof PaymentQuery]: PaymentQuery[K] } = {};
    const facilitator = query["facilitator"];
    if (facilitator !== undefined && facilitator !== "") {
      if (
        facilitator !== "shaped" &&
        (!FACILITATOR_ID.test(facilitator) || entry.registry.facilitator(facilitator) === undefined)
      )
        throw explorerError("explorer_invalid_parameter", {
          reason: "facilitator is a registry facilitator id or shaped.",
        });
      out.facilitator = facilitator;
    }
    const scheme = query["scheme"];
    if (scheme !== undefined && scheme !== "") {
      if (scheme !== "exact" && scheme !== "upto")
        throw explorerError("explorer_invalid_parameter", { reason: "scheme is exact or upto." });
      out.scheme = scheme;
    }
    const asset = query["asset"];
    if (asset !== undefined && asset !== "") {
      if (!StrKey.isValidContract(asset))
        throw explorerError("explorer_invalid_parameter", { reason: "asset is a token contract id (C…)." });
      out.asset = asset;
    }
    const time = query["time"];
    if (time !== undefined && time !== "") {
      if (!Object.hasOwn(TIME_WINDOWS, time))
        throw explorerError("explorer_invalid_parameter", { reason: "time is 24h, 7d or 30d." });
      out.time = time as TimeWindow;
    }
    return out;
  }

  /** The reader's filter of a payments query: a time window becomes the first ledger inside it. */
  async function paymentFilter(entry: Served, query: PaymentQuery): Promise<PaymentFilter> {
    const filter: { -readonly [K in keyof PaymentFilter]: PaymentFilter[K] } = {};
    if (query.facilitator === "shaped") filter.shaped = true;
    else if (query.facilitator !== undefined) filter.facilitator = query.facilitator;
    if (query.scheme !== undefined) filter.scheme = query.scheme;
    if (query.asset !== undefined) filter.asset = query.asset;
    if (query.time !== undefined) {
      const since = new Date((options.now ?? Date.now)() - TIME_WINDOWS[query.time].ms).toISOString();
      const ledger = await options.reader.firstLedgerSince(entry.network, entry.epoch.id, since);
      // No row is that recent: a bound past every ledger lists nothing.
      filter.fromLedger = ledger ?? 0xffffffff;
      filter.window = query.time;
    }
    return filter;
  }

  const PAYMENT_PARAMS = ["facilitator", "scheme", "asset", "time"];

  app.get("/api/v1/:network/settlements", async (c) => {
    const entry = apiNetwork(c.req.param("network"));
    const raw = queryOf(c);
    keyset(
      "payments-params",
      Object.fromEntries(Object.entries(raw).filter(([name]) => name !== "cursor")),
      PAYMENT_PARAMS,
    );
    const query = paymentQuery(entry, raw);
    const filter = await paymentFilter(entry, query);
    const page = keyset(paymentsList(entry.network, entry.epoch.id, filter), raw, PAYMENT_PARAMS);
    const result = await options.reader.payments(entry.network, entry.epoch.id, filter, page);
    return json(
      c,
      { network: entry.network, epoch: entry.epoch.id, filter: query, limit: page.limit, ...result },
      "listing",
      entry.versions,
    );
  });

  function reportOf(entry: Served): ComputedReport {
    const report = currentReport(entry.network);
    if (report === undefined) throw explorerError("explorer_report_unavailable");
    return report;
  }

  app.get("/api/v1/:network/report", (c) => {
    const entry = apiNetwork(c.req.param("network"));
    keyset("report", queryOf(c));
    return json(c, reportOf(entry).document, "report", entry.versions);
  });

  app.get("/api/v1/:network/manifest", (c) => {
    const entry = apiNetwork(c.req.param("network"));
    keyset("manifest", queryOf(c));
    return send(c, reportOf(entry).manifestText, "json", "report", entry.versions);
  });

  // The network-wide window's manifest: absent (explorer_not_found) while the window job is off.
  app.get("/api/v1/:network/network-window/manifest", (c) => {
    const entry = apiNetwork(c.req.param("network"));
    keyset("manifest", queryOf(c));
    const manifest = reportOf(entry).networkWindowManifest;
    if (manifest === undefined) throw explorerError("explorer_not_found");
    return send(c, manifest, "json", "report", entry.versions);
  });

  // --- pages -------------------------------------------------------------------------------------
  const now = () => (options.now ?? Date.now)();

  function pageContext(entry: Served): PageContext {
    return {
      layout: { ...layoutFor(entry), statusUrl: options.statusUrl },
      registry: entry.registry,
      report: currentReport(entry.network)?.document,
      now: now(),
      bazaar: entry.bazaar !== undefined,
    };
  }

  /** The Bazaar of `entry` for this page request: the visitor's budget and one deadline. */
  function bazaarFor(c: Context, entry: Served): BazaarSession | undefined {
    return entry.bazaar?.forRequest(clientKey(clientAddress(c, hops)), options.bazaarBudgetMs);
  }

  /**
   * What each row paid for, from the Bazaar (both hashes of a fee bump, 100 per call, in parallel). A
   * link counts only when the listing's payTo is the account the settlement paid on chain, so a link the
   * Bazaar holds for another payee is never shown.
   */
  async function paidFor(
    bazaar: BazaarSession | undefined,
    rows: readonly { readonly txHash: string; readonly innerHash: string | null; readonly payTo: string }[],
  ): Promise<Answer<ReadonlyMap<string, PaidFor>> | undefined> {
    if (bazaar === undefined) return undefined;
    const hashes = rows.flatMap((row) =>
      row.innerHash === null ? [row.txHash] : [row.txHash, row.innerHash],
    );
    const chunks: string[][] = [];
    for (let start = 0; start < hashes.length; start += 100) chunks.push(hashes.slice(start, start + 100));
    const answers = await Promise.all(chunks.map((chunk) => bazaar.paidFor(chunk)));
    const found = new Map<string, PaidFor>();
    for (const answer of answers) {
      if (answer.status !== "ok") return answer;
      for (const [hash, value] of answer.value) found.set(hash, value);
    }
    const checked = new Map<string, PaidFor>();
    for (const row of rows) {
      const hit = found.get(row.txHash) ?? (row.innerHash === null ? undefined : found.get(row.innerHash));
      if (hit === undefined || baseAccount(hit.listing.payTo) !== baseAccount(row.payTo)) continue;
      checked.set(row.txHash, hit);
      if (row.innerHash !== null) checked.set(row.innerHash, hit);
    }
    return { status: "ok", value: checked };
  }

  /** The Bazaar's listings of this network, or `none` when it has no Bazaar. */
  function listingsOf(bazaar: BazaarSession | undefined): Promise<Answer<Listing[]>> {
    return bazaar === undefined ? Promise.resolve({ status: "none" }) : bazaar.listings();
  }

  /** Listings grouped by seller, with each seller's received payments from the index. */
  async function servicesOf(
    entry: Served,
    bazaar: BazaarSession | undefined,
  ): Promise<Answer<readonly Service[]>> {
    const listings = await listingsOf(bazaar);
    if (listings.status !== "ok") return listings;
    let totals;
    try {
      totals = await options.reader.sellerTotals(
        entry.network,
        entry.epoch.id,
        listings.value.map((listing) => baseAccount(listing.payTo)),
      );
    } catch {
      totals = undefined;
    }
    return { status: "ok", value: groupServices(listings.value, totals) };
  }

  /** A read whose failure the page survives: undefined instead of an error page. */
  async function soft<T>(run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch {
      return undefined;
    }
  }

  app.get("/methodology", (c) => {
    if (defaultServed === undefined) throw explorerError("explorer_not_found");
    const list = [...served.values()];
    return send(
      c,
      methodologyPage(
        { ...layoutFor(defaultServed), statusUrl: options.statusUrl },
        list.map((entry) => entry.registry),
        list.map((entry) => entry.view),
      ),
      "html",
      "listing",
      defaultServed.versions,
    );
  });

  // Without mainnet the root has no home page of its own: send it to the testnet home. Temporary, so a
  // later mainnet home at "/" is never shadowed by a cached redirect.
  if (!served.has("stellar:pubnet") && served.has("stellar:testnet")) {
    app.get("/", (c) => c.redirect(NETWORK_VIEWS["stellar:testnet"].prefix, 302));
  }

  for (const view of Object.values(NETWORK_VIEWS)) {
    const entry = served.get(view.network);
    const p = view.prefix;
    if (entry === undefined) continue;

    app.get(p === "" ? "/" : p, async (c) => {
      const bazaar = bazaarFor(c, entry);
      const raw = c.req.query("scheme");
      const scheme = raw === "exact" || raw === "upto" ? raw : undefined;
      const [latest, services] = await Promise.all([
        options.reader.payments(entry.network, entry.epoch.id, scheme === undefined ? {} : { scheme }, {
          after: undefined,
          limit: 8,
        }),
        servicesOf(entry, bazaar),
      ]);
      const paid = (await paidFor(bazaar, latest.items)) ?? { status: "none" };
      return send(
        c,
        homePage(pageContext(entry), { latest: latest.items, paid, scheme, services }),
        "html",
        "listing",
        entry.versions,
      );
    });

    app.get(`${p}/search`, async (c) => {
      const q = (c.req.query("q") ?? "").trim().slice(0, 300);
      const rawScope = c.req.query("scope") ?? "all";
      const scope: SearchScope = SEARCH_SCOPES.some(([id]) => id === rawScope)
        ? (rawScope as SearchScope)
        : "all";
      if ((scope === "all" || scope === "payments") && /^[0-9a-fA-F]{64}$/.test(q))
        return c.redirect(`${p}/tx/${q.toLowerCase()}`, 302);
      if (
        (scope === "all" || scope === "accounts") &&
        (StrKey.isValidEd25519PublicKey(q) || StrKey.isValidContract(q) || StrKey.isValidMed25519PublicKey(q))
      ) {
        return c.redirect(`${p}/account/${q}`, 302);
      }
      if (entry.bazaar === undefined || q === "" || scope === "payments" || scope === "accounts") {
        throw explorerError("explorer_not_found", {
          reason:
            entry.bazaar === undefined
              ? "Search for a 64-character transaction hash or a G…, C… or M… account."
              : "Search for a 64-character transaction hash, a G…, C… or M… account, an endpoint URL or an MCP tool name.",
        });
      }
      const listings = await entry.bazaar
        .forRequest(clientKey(clientAddress(c, hops)), options.bazaarBudgetMs)
        .listings();
      const matches = listings.status === "ok" ? matchListings(listings.value, q, scope) : [];
      const [only] = matches;
      if (matches.length === 1 && only !== undefined && (scope !== "all" || isAddressLike(q)))
        return c.redirect(`${p}/resource/${only.id}`, 302);
      return send(
        c,
        searchPage(pageContext(entry), q, scope, matches, listings.status === "down"),
        "html",
        "volatile",
        entry.versions,
        matches.length === 0 ? 404 : 200,
      );
    });

    app.get(`${p}/tx/:hash`, async (c) => {
      const raw = c.req.param("hash");
      if (/^[0-9a-fA-F]{64}$/.test(raw) && raw !== raw.toLowerCase())
        return c.redirect(`${p}/tx/${raw.toLowerCase()}`, 301);
      if (!HASH.test(raw))
        throw explorerError("explorer_not_found", { reason: "A transaction hash is 64 hex characters." });
      const model = await resolveTx(entry, raw, clientAddress(c, hops));
      const answer =
        model.kind === "settlement" ? await paidFor(bazaarFor(c, entry), [model.row]) : undefined;
      const found =
        model.kind !== "settlement" || answer === undefined
          ? undefined
          : answer.status !== "ok"
            ? answer
            : (() => {
                const hit =
                  answer.value.get(model.row.txHash) ??
                  (model.row.innerHash === null ? undefined : answer.value.get(model.row.innerHash));
                return hit === undefined
                  ? ({ status: "none" } as const)
                  : ({ status: "ok", value: hit } as const);
              })();
      const caching = txCaching(entry, model);
      // "Paid for" can still change while the Bazaar catalogs a fresh payment, and is missing while the
      // Bazaar does not answer: such a page is kept briefly only. It is final once a link is found, or
      // once the Bazaar answered "none" for a payment older than the grace period.
      const linked = found === undefined || found.status === "ok";
      const old = model.kind === "settlement" && now() - Date.parse(model.row.closedAt) > CATALOG_GRACE_MS;
      const settledAnswer = linked || (old && found.status === "none");
      const kind = caching.kind === "final" && !settledAnswer ? "listing" : caching.kind;
      return send(
        c,
        txPage({ page: pageContext(entry), publicRpcUrl: entry.publicRpcUrl, paid: found }, model),
        "html",
        kind,
        caching.versions,
      );
    });

    app.get(`${p}/account/:address`, async (c) => {
      const raw = c.req.param("address");
      const parsed = parseAddress(raw);
      if (parsed.muxedId !== undefined)
        return c.redirect(`${p}/account/${parsed.address}?muxed=${parsed.muxedId}`, 301);
      const query = queryOf(c);
      const muxedId = muxedParam(query["muxed"]);
      const role = muxedRole(accountRole(query["role"]), muxedId);
      const page = keyset(accountList(entry.network, entry.epoch.id, parsed.address, role, muxedId), query, [
        "role",
        "muxed",
      ]);
      const bazaar = bazaarFor(c, entry);
      const [totals, result, listings, holdings] = await Promise.all([
        options.reader.accountTotals(entry.network, entry.epoch.id, parsed.address),
        options.reader.accountSettlements(entry.network, entry.epoch.id, parsed.address, role, page, muxedId),
        listingsOf(bazaar).then((answer): Answer<readonly Listing[]> =>
          answer.status === "ok"
            ? {
                status: "ok",
                value: answer.value.filter((listing) => baseAccount(listing.payTo) === parsed.address),
              }
            : answer,
        ),
        entry.holdings?.holdings(parsed.address),
      ]);
      const seller = listings.status === "ok" && listings.value.length > 0;
      const received = totals.items.some((total) => total.role === "payTo");
      const [paid, usage, summary] = await Promise.all([
        paidFor(bazaar, result.items),
        seller ? bazaar?.sellerUsage(parsed.address) : undefined,
        received
          ? soft(() => options.reader.sellerSummary(entry.network, entry.epoch.id, parsed.address))
          : undefined,
      ]);
      const upto =
        summary !== undefined && summary.upto > 0
          ? ((await soft(() =>
              options.reader.uptoReceived(entry.network, entry.epoch.id, parsed.address, 8),
            )) ?? [])
          : [];
      return send(
        c,
        accountPage(pageContext(entry), {
          address: parsed.address,
          muxedId,
          role,
          totals,
          items: result.items,
          nextCursor: result.nextCursor,
          epoch: entry.epoch.id,
          paid,
          listings: entry.bazaar === undefined ? undefined : listings,
          usage,
          summary,
          upto,
          holdings,
        }),
        "html",
        "listing",
        entry.versions,
      );
    });

    app.get(`${p}/payments`, async (c) => {
      const raw = queryOf(c);
      const query = paymentQuery(entry, raw);
      const filter = await paymentFilter(entry, query);
      const page = keyset(paymentsList(entry.network, entry.epoch.id, filter), raw, PAYMENT_PARAMS);
      const result = await options.reader.payments(entry.network, entry.epoch.id, filter, page);
      const paid = (await paidFor(bazaarFor(c, entry), result.items)) ?? { status: "none" };
      return send(
        c,
        paymentsPage(pageContext(entry), {
          query,
          filter,
          items: result.items,
          nextCursor: result.nextCursor,
          first: page.after === undefined,
          limit: page.limit,
          paid,
        }),
        "html",
        "listing",
        entry.versions,
      );
    });

    app.get(`${p}/payments.csv`, async (c) => {
      const raw = queryOf(c);
      keyset("payments-csv", raw, PAYMENT_PARAMS);
      if (raw["cursor"] !== undefined || raw["limit"] !== undefined)
        throw explorerError("explorer_invalid_parameter", { reason: "A CSV download takes filters only." });
      const query = paymentQuery(entry, raw);
      const filter = await paymentFilter(entry, query);
      const rows = [];
      let after;
      while (rows.length < CSV_ROWS) {
        const result = await options.reader.payments(entry.network, entry.epoch.id, filter, {
          after,
          limit: 100,
        });
        rows.push(...result.items);
        const last = result.items.at(-1);
        if (result.nextCursor === null || last === undefined) break;
        after = { ledger: last.ledger, txIndex: last.txIndex };
      }
      const paid = await paidFor(bazaarFor(c, entry), rows.slice(0, CSV_ROWS));
      c.header("Content-Disposition", `attachment; filename="rail402-${view.slug}-payments.csv"`);
      return send(
        c,
        paymentsCsv(rows.slice(0, CSV_ROWS), paid?.status === "ok" ? paid.value : undefined),
        "csv",
        "listing",
        entry.versions,
      );
    });

    app.get(`${p}/services`, async (c) => {
      keyset("services", queryOf(c));
      const services = await servicesOf(entry, bazaarFor(c, entry));
      return send(c, servicesPage(pageContext(entry), { services }), "html", "listing", entry.versions);
    });

    app.get(`${p}/resource/:id`, async (c) => {
      keyset("resource", queryOf(c));
      const id = c.req.param("id");
      if (entry.bazaar === undefined || !/^[0-9a-f-]{36}$/.test(id))
        throw explorerError("explorer_not_found", {
          reason: "No Bazaar listing with this id on this network.",
        });
      const bazaar = entry.bazaar.forRequest(clientKey(clientAddress(c, hops)), options.bazaarBudgetMs);
      const listing = await bazaar.listing(id);
      if (listing.status === "down")
        throw explorerError("explorer_unavailable", {
          reason: "The Bazaar did not answer in time; retry shortly.",
        });
      if (listing.status === "none")
        throw explorerError("explorer_not_found", {
          reason: "No Bazaar listing with this id on this network.",
        });
      const payTo = baseAccount(listing.value.payTo);
      // A listing that is not published (pending, or withdrawn) gets no usage, price or seller: only its
      // state and history.
      const published = listing.value.state === undefined || listing.value.state === "published";
      const [usage, versions, listings, sellerTotals] = await Promise.all([
        published ? bazaar.resourceUsage(id) : ({ status: "none" } as const),
        bazaar.versions(id),
        published ? bazaar.listings() : ({ status: "none" } as const),
        published
          ? soft(() => options.reader.sellerTotals(entry.network, entry.epoch.id, [payTo]))
          : undefined,
      ]);
      // Only payments that paid the listing's payTo on chain count as its payments.
      const recent =
        usage.status === "ok"
          ? (
              (await soft(() =>
                options.reader.settlementsByHash(
                  entry.network,
                  entry.epochs,
                  usage.value.recent.map((item) => item.transaction),
                ),
              )) ?? []
            ).filter((row) => row.payTo === payTo)
          : [];
      const sellerListings =
        listings.status === "ok"
          ? listings.value.filter((other) => baseAccount(other.payTo) === payTo)
          : undefined;
      return send(
        c,
        resourcePage(pageContext(entry), {
          listing: listing.value,
          usage,
          versions,
          recent,
          sellerListings: sellerListings?.length,
          sellerPayments: sellerTotals === undefined ? undefined : (sellerTotals.get(payTo)?.payments ?? 0),
          sellerName: serviceName(
            sellerListings !== undefined && sellerListings.length > 0 ? sellerListings : [listing.value],
          ),
        }),
        "html",
        "listing",
        entry.versions,
      );
    });

    app.get(`${p}/facilitators`, (c) => {
      keyset("facilitators", queryOf(c));
      return send(c, facilitatorsPage(pageContext(entry)), "html", "listing", entry.versions);
    });

    app.get(`${p}/facilitator/:id`, async (c) => {
      const facilitator = facilitatorOf(entry, c.req.param("id"));
      const page = keyset(facilitatorList(entry.network, entry.epoch.id, facilitator.id), queryOf(c));
      const sponsor = facilitator.accounts.find(
        (account) =>
          account.role === "sponsor" && account.validToLedger === null && account.epoch === entry.epoch.id,
      )?.address;
      const [result, holdings] = await Promise.all([
        options.reader.facilitatorSettlements(entry.network, entry.epoch.id, facilitator.id, page),
        sponsor === undefined ? undefined : entry.holdings?.holdings(sponsor),
      ]);
      const paid = await paidFor(bazaarFor(c, entry), result.items);
      return send(
        c,
        facilitatorPage(pageContext(entry), {
          facilitator,
          items: result.items,
          nextCursor: result.nextCursor,
          paid,
          sponsor,
          holdings,
        }),
        "html",
        "listing",
        entry.versions,
      );
    });

    app.get(`${p}/ecosystem`, (c) =>
      send(
        c,
        ecosystemPage(
          {
            layout: { ...layoutFor(entry), statusUrl: options.statusUrl },
            registry: entry.registry,
            statusUrl: options.statusUrl,
            apiOrigin: "",
          },
          currentReport(entry.network)?.document,
        ),
        "html",
        "report",
        entry.versions,
      ),
    );
  }

  return app;
}

/** Whether a search looks like an endpoint URL. */
const isAddressLike = (q: string) => /^(https?|mcp):\/\//i.test(q);

/** The path segments of a URL without its query, or undefined when it is not one. */
function urlParts(
  value: string,
): { readonly origin: string; readonly segments: readonly string[] } | undefined {
  try {
    const url = new URL(value);
    return {
      origin: `${url.protocol}//${url.host}`.toLowerCase(),
      segments: url.pathname.split("/").filter((part) => part !== ""),
    };
  } catch {
    return undefined;
  }
}

/** Whether `url` is the listing's resource, a `:name` segment of its route standing for any segment. */
function urlMatches(listing: Listing, url: string): boolean {
  const wanted = urlParts(url);
  const resource = urlParts(listing.resource);
  if (wanted === undefined || resource === undefined || wanted.origin !== resource.origin) return false;
  if (wanted.segments.length !== resource.segments.length) return false;
  return resource.segments.every(
    (segment, index) => segment.startsWith(":") || segment === wanted.segments[index],
  );
}

/**
 * Listings a search names: an endpoint URL (its route template included), an MCP tool name, or a word
 * in a listing's resource, tool name, service name or description. At most 50.
 */
export function matchListings(listings: readonly Listing[], q: string, scope: SearchScope): Listing[] {
  const text = q.toLowerCase();
  const typed = listings.filter(
    (listing) =>
      scope === "all" || (scope === "endpoints" ? listing.type === "http" : listing.type === "mcp"),
  );
  if (isAddressLike(q)) {
    const exact = typed.filter((listing) => urlMatches(listing, q));
    if (exact.length > 0) return exact.slice(0, 50);
  }
  const tools = typed.filter((listing) => listing.toolName?.toLowerCase() === text);
  if (tools.length > 0) return tools.slice(0, 50);
  return typed
    .filter((listing) =>
      [listing.resource, listing.toolName, listing.serviceName, listing.description].some(
        (field) => field !== undefined && field.toLowerCase().includes(text),
      ),
    )
    .slice(0, 50);
}
