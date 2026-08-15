import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Logger } from "pino";
import { X402Error, createError, type X402ErrorPayload } from "@rail402/errors";
import type { ExplorerConfig } from "./config.js";
import type { AssetTotal, ExplorerStore, FeedFilter } from "./db.js";
import type { FacilitatorRegistry } from "./registry.js";
import type { IngestCounters, NetworkIngestHealth } from "./ingest.js";
import type { Confidence, FacilitatorRow, PaymentRow, Scheme } from "./types.js";

/**
 * The read API. Public data, coded errors, non-null reasons everywhere — the same error discipline
 * applies to an explorer exactly as it does to the facilitator: an agent (or a UI) must be able
 * to branch on `code` and read `reason`, never parse prose.
 */

interface IngestView {
  healthReport(): NetworkIngestHealth[];
  readonly counters: IngestCounters;
}

interface HorizonView {
  readonly counters: { readonly pages: number; readonly inserted: number };
}

export interface ExplorerAppOptions {
  readonly store: ExplorerStore;
  readonly config: ExplorerConfig;
  readonly registry: FacilitatorRegistry;
  readonly logger: Logger;
  /** Absent in API-only mode (serving an existing database with no live ingest). */
  readonly ingest?: IngestView;
  /** The Tier-2 Horizon epoch backfill, when running. */
  readonly horizon?: HorizonView;
}

/** Stroops → 7-decimal display string, in BigInt-safe string arithmetic (never a float). */
export function toDecimal(stroops: string): string {
  if (!/^-?\d+$/.test(stroops)) return stroops;
  const negative = stroops.startsWith("-");
  const digits = (negative ? stroops.slice(1) : stroops).padStart(8, "0");
  const whole = digits.slice(0, -7);
  const fraction = digits.slice(-7).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Escape a Prometheus label value (backslash, quote, newline) so a network id can't break the line. */
function promLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Client bucket key: the last X-Forwarded-For hop (proxy-set, least spoofable) or "anon". */
function clientKey(xff: string | undefined): string {
  if (!xff) return "anon";
  const hops = xff.split(",");
  return hops[hops.length - 1]?.trim() || "anon";
}

/** Fixed-window limiter: N per client per window, plus a global ceiling. In-memory, self-pruning. */
class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private global = { count: 0, resetAt: 0 };
  constructor(
    private readonly perClient: number,
    private readonly globalMax: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    if (now >= this.global.resetAt) this.global = { count: 0, resetAt: now + this.windowMs };
    if (this.global.count >= this.globalMax) return false;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.global.count += 1;
      return true;
    }
    if (entry.count >= this.perClient) return false;
    entry.count += 1;
    this.global.count += 1;
    return true;
  }
}

/** SEP-11 asset string → display code. "native" is XLM; "CODE:ISSUER" is CODE. */
export function assetCode(asset: string | undefined): string | undefined {
  if (asset === undefined) return undefined;
  if (asset === "native") return "XLM";
  const code = asset.split(":")[0];
  return code === "" ? undefined : code;
}

interface FacilitatorRef {
  readonly id: string;
  readonly displayName?: string;
}

/** The wire projection of a payment. `rawEnvelope` travels ONLY on /tx/:hash. */
function projectPayment(
  row: PaymentRow,
  facilitators: ReadonlyMap<string, FacilitatorRow>,
): Record<string, unknown> {
  const facilitator = row.facilitatorId ? facilitators.get(row.facilitatorId) : undefined;
  const ref: FacilitatorRef | null = row.facilitatorId
    ? {
        id: row.facilitatorId,
        ...(facilitator?.displayName !== undefined
          ? { displayName: facilitator.displayName }
          : {}),
      }
    : null;
  return {
    network: row.network,
    epoch: row.epoch,
    ledger: row.ledger,
    txHash: row.txHash,
    scheme: row.scheme,
    buyer: row.buyer,
    seller: row.seller,
    amount: row.amount,
    amountDecimal: toDecimal(row.amount),
    ...(row.ceiling !== undefined
      ? { ceiling: row.ceiling, ceilingDecimal: toDecimal(row.ceiling) }
      : {}),
    assetContract: row.assetContract,
    ...(row.asset !== undefined ? { asset: row.asset } : {}),
    ...(assetCode(row.asset) !== undefined ? { assetCode: assetCode(row.asset) } : {}),
    txSource: row.txSource,
    ...(row.feeSource !== undefined ? { feeSource: row.feeSource } : {}),
    ...(row.feeCharged !== undefined ? { feeChargedStroops: row.feeCharged } : {}),
    facilitator: ref,
    confidence: row.confidence,
    ...(row.sigExpirationLedger !== undefined
      ? { sigExpirationLedger: row.sigExpirationLedger }
      : {}),
    ...(row.memo !== undefined ? { memo: row.memo } : {}),
    ...(row.muxedId !== undefined ? { muxedId: row.muxedId } : {}),
    closedAt: row.closedAt,
    ...(row.serviceName !== undefined ? { serviceName: row.serviceName } : {}),
    ...(row.resource !== undefined ? { resource: row.resource } : {}),
  };
}

function projectFacilitator(row: FacilitatorRow): Record<string, unknown> {
  return {
    id: row.id,
    ...(row.displayName !== undefined ? { displayName: row.displayName } : {}),
    baseUrl: row.baseUrl,
    verified: row.verified,
    signers: row.signers,
    uptoContracts: row.uptoContracts,
    networks: row.networks,
    source: row.source,
    ...(row.lastSeenAt !== undefined ? { lastSeenAt: row.lastSeenAt } : {}),
    ...(row.lastError !== undefined ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt,
  };
}

const HTTP_STATUS: Record<string, number> = {
  explorer_invalid_query: 400,
  explorer_tx_not_found: 404,
  explorer_facilitator_not_found: 404,
  explorer_announce_invalid_url: 400,
  explorer_announce_unreachable: 502,
};

const SCHEMES: readonly Scheme[] = ["exact", "upto"];
const CONFIDENCES: readonly Confidence[] = ["rail402", "verified-facilitator", "x402-shaped"];

export function createExplorerApp(options: ExplorerAppOptions): Hono {
  const { store, config, registry, logger, ingest, horizon } = options;
  const startedAt = Date.now();
  let requestSeq = 0;
  // 10 announces per client and 120 globally per minute — generous for honest use, a wall to abuse.
  const announceLimiter = new FixedWindowLimiter(10, 120, 60_000);
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.corsOrigins.includes("*") ? "*" : [...config.corsOrigins],
    }),
  );

  app.onError((error, c) => {
    if (error instanceof X402Error) {
      const status = HTTP_STATUS[error.payload.code] ?? 500;
      return c.json(error.payload, status as 400);
    }
    // A genuine server fault is a distinct code with a real request id — NOT explorer_invalid_query
    // (review m8): an agent branching on the code must not be told its request was malformed when
    // the fault was ours.
    const requestId = `${Date.now().toString(36)}-${(requestSeq++).toString(36)}`;
    logger.error({ err: error.message, path: c.req.path, requestId }, "unhandled explorer error");
    const payload: X402ErrorPayload = createError("explorer_internal_error", { details: { requestId } });
    return c.json(payload, 500);
  });

  // Unknown routes get the SAME coded envelope as every other error (review S4) — a browser client
  // branching on `code` must never receive Hono's default plain-text "404 Not Found".
  app.notFound(c =>
    c.json(
      createError("explorer_invalid_query", {
        reason: `No such endpoint: ${c.req.method} ${c.req.path}.`,
        details: { path: c.req.path },
      }),
      404,
    ),
  );

  const facilitatorMap = (): Map<string, FacilitatorRow> =>
    new Map(store.listFacilitators().map(f => [f.id, f]));

  // /stats folds every amount in BigInt (SQLite can't sum i128), so it is O(rows). A short TTL
  // cache keeps a burst of frontend widgets — which each want stats — from each triggering a full
  // table fold (prod-test: 20 parallel /stats serialised to ~8s). 5s is well inside the ingest
  // cadence, so numbers stay live enough.
  const statsCache = new Map<string, { value: ReturnType<typeof store.stats>; at: number }>();
  const STATS_TTL_MS = 5_000;
  const cachedStats = (filter: Parameters<typeof store.stats>[0] = {}): ReturnType<typeof store.stats> => {
    const key = JSON.stringify(filter);
    const hit = statsCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < STATS_TTL_MS) return hit.value;
    if (statsCache.size > 5_000) statsCache.clear();
    const value = store.stats(filter);
    statsCache.set(key, { value, at: now });
    return value;
  };

  app.get("/feed", c => {
    const q = c.req.query();
    const filter: FeedFilter = {};
    const assign = <K extends keyof FeedFilter>(key: K, value: FeedFilter[K]): void => {
      (filter as Record<string, unknown>)[key] = value;
    };
    if (q["network"] !== undefined) assign("network", q["network"]);
    if (q["seller"] !== undefined) assign("seller", q["seller"]);
    if (q["buyer"] !== undefined) assign("buyer", q["buyer"]);
    if (q["facilitator"] !== undefined) assign("facilitatorId", q["facilitator"]);
    if (q["scheme"] !== undefined) {
      if (!SCHEMES.includes(q["scheme"] as Scheme)) {
        throw new X402Error("explorer_invalid_query", {
          reason: `Query parameter "scheme" must be one of ${SCHEMES.join(", ")}.`,
          details: { parameter: "scheme", value: q["scheme"] },
        });
      }
      assign("scheme", q["scheme"] as Scheme);
    }
    if (q["confidence"] !== undefined) {
      if (!CONFIDENCES.includes(q["confidence"] as Confidence)) {
        throw new X402Error("explorer_invalid_query", {
          reason: `Query parameter "confidence" must be one of ${CONFIDENCES.join(", ")}.`,
          details: { parameter: "confidence", value: q["confidence"] },
        });
      }
      assign("confidence", q["confidence"] as Confidence);
    }
    if (q["limit"] !== undefined) {
      const limit = Number(q["limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new X402Error("explorer_invalid_query", {
          reason: 'Query parameter "limit" must be an integer between 1 and 100.',
          details: { parameter: "limit", value: q["limit"] },
        });
      }
      assign("limit", limit);
    }
    if (q["cursor"] !== undefined) assign("cursor", q["cursor"]);

    const page = store.feed(filter);
    const facilitators = facilitatorMap();
    return c.json({
      items: page.items.map(row => projectPayment(row, facilitators)),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/tx/:hash", c => {
    const hash = c.req.param("hash").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new X402Error("explorer_invalid_query", {
        reason: "A transaction hash is 64 hex characters.",
        details: { parameter: "hash", value: c.req.param("hash") },
      });
    }
    // A transaction can settle several ops — return them all (review M5). The top-level fields are
    // the first op (so a single-payment tx reads exactly as before); `payments` holds every op.
    const rows = store.getPaymentsByHash(hash, c.req.query("network"));
    const primary = rows[0];
    if (!primary) throw new X402Error("explorer_tx_not_found", { details: { hash } });
    let raw: unknown;
    try {
      raw = JSON.parse(primary.rawEnvelope);
    } catch {
      raw = null;
    }
    const facilitators = facilitatorMap();
    return c.json({
      ...projectPayment(primary, facilitators),
      payments: rows.map(r => projectPayment(r, facilitators)),
      raw,
    });
  });

  // The seller / API directory: on-chain sellers (with activity) ∪ Bazaar-registered sellers.
  // Any seller registered in our Bazaar appears here automatically, even before their first
  // settled payment; on-chain-only sellers appear with stats and no name. Ranked by activity.
  const directoryCache = new Map<string, { value: unknown; at: number }>();
  // Trailing windows for /sellers?window= — the "top sellers by recent activity" view. The
  // cutoff is second-precision to match closed_at's format (see isoSeconds in db.ts).
  const SELLER_WINDOWS: Record<string, number> = {
    "24h": 24 * 3_600_000,
    "7d": 7 * 24 * 3_600_000,
    "30d": 30 * 24 * 3_600_000,
  };
  app.get("/sellers", c => {
    const q = c.req.query();
    const opts: {
      network?: string;
      registered?: boolean;
      limit?: number;
      offset?: number;
      since?: string;
    } = {};
    let window: string | undefined;
    if (q["window"] !== undefined) {
      if (!(q["window"] in SELLER_WINDOWS)) {
        throw new X402Error("explorer_invalid_query", {
          reason: `Query parameter "window" must be one of ${Object.keys(SELLER_WINDOWS).join(", ")} (omit it for all-time).`,
          details: { parameter: "window", value: q["window"] },
        });
      }
      window = q["window"];
    }
    if (q["network"] !== undefined) opts.network = q["network"];
    if (q["registered"] !== undefined) {
      if (q["registered"] !== "true" && q["registered"] !== "false") {
        throw new X402Error("explorer_invalid_query", {
          reason: 'Query parameter "registered" must be "true" or "false".',
          details: { parameter: "registered", value: q["registered"] },
        });
      }
      opts.registered = q["registered"] === "true";
    }
    if (q["limit"] !== undefined) {
      const limit = Number(q["limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new X402Error("explorer_invalid_query", {
          reason: 'Query parameter "limit" must be an integer between 1 and 100.',
          details: { parameter: "limit", value: q["limit"] },
        });
      }
      opts.limit = limit;
    }
    if (q["offset"] !== undefined) {
      const offset = Number(q["offset"]);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new X402Error("explorer_invalid_query", {
          reason: 'Query parameter "offset" must be a non-negative integer.',
          details: { parameter: "offset", value: q["offset"] },
        });
      }
      opts.offset = offset;
    }
    // Cached (the query folds every amount, like /stats). The cache key carries the window
    // LABEL, not the computed cutoff — a per-request timestamp key would never hit.
    const cacheKey = JSON.stringify({ ...opts, window: window ?? null });
    const hit = directoryCache.get(cacheKey);
    const now = Date.now();
    if (hit && now - hit.at < 5_000) return c.json(hit.value);
    if (directoryCache.size > 500) directoryCache.clear();
    if (window !== undefined) {
      opts.since = new Date(now - SELLER_WINDOWS[window]!)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    }
    const { items, total } = store.sellersDirectory(opts);
    const value = {
      ...(window !== undefined ? { window } : {}),
      items: items.map(r => ({
        payTo: r.payTo,
        network: r.network,
        registered: r.registered,
        payments: r.payments,
        uniqueBuyers: r.uniqueBuyers,
        ...(r.firstSeenAt !== undefined ? { firstSeenAt: r.firstSeenAt } : {}),
        ...(r.lastSeenAt !== undefined ? { lastSeenAt: r.lastSeenAt } : {}),
        volume: r.volume.map(v => ({
          assetContract: v.assetContract,
          ...(v.asset !== undefined ? { asset: v.asset, assetCode: assetCode(v.asset) } : {}),
          total: v.total,
          totalDecimal: toDecimal(v.total),
        })),
        ...(r.serviceName !== undefined ? { serviceName: r.serviceName } : {}),
        ...(r.resource !== undefined ? { resource: r.resource } : {}),
        ...(r.description !== undefined ? { description: r.description } : {}),
      })),
      pagination: { total, limit: opts.limit ?? 25, offset: opts.offset ?? 0 },
    };
    directoryCache.set(cacheKey, { value, at: now });
    return c.json(value);
  });

  app.get("/seller/:payTo", c => {
    const payTo = c.req.param("payTo");
    const network = c.req.query("network");
    const stats = cachedStats({ seller: payTo, ...(network !== undefined ? { network } : {}) });
    const page = store.feed({ seller: payTo, ...(network !== undefined ? { network } : {}) });
    // Enrichment metadata is per (network, payTo); when the caller didn't pin a network, use the
    // network of this seller's own payments rather than an arbitrary config default (review m5).
    const metaNetwork = network ?? page.items[0]?.network ?? config.networks[0]!.network;
    const meta = store.getSellerMeta(metaNetwork, payTo);
    const facilitators = facilitatorMap();
    return c.json({
      payTo,
      ...(meta?.serviceName !== undefined ? { serviceName: meta.serviceName } : {}),
      ...(meta?.resource !== undefined ? { resource: meta.resource } : {}),
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
      stats,
      payments: page.items.map(row => projectPayment(row, facilitators)),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/facilitators", c => {
    const rows = store.listFacilitators();
    return c.json({
      facilitators: rows.map(row => ({
        ...projectFacilitator(row),
        stats: cachedStats({ facilitatorId: row.id }),
      })),
    });
  });

  app.get("/facilitator/:id", c => {
    const id = c.req.param("id");
    const row = store.getFacilitator(id);
    if (!row) throw new X402Error("explorer_facilitator_not_found", { details: { id } });
    const page = store.feed({ facilitatorId: id });
    const facilitators = facilitatorMap();
    return c.json({
      ...projectFacilitator(row),
      stats: cachedStats({ facilitatorId: id }),
      payments: page.items.map(r => projectPayment(r, facilitators)),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    });
  });

  app.get("/stats", c => {
    const network = c.req.query("network");
    return c.json({
      ...cachedStats(network !== undefined ? { network } : {}),
      networks: config.networks.map(n => n.network),
      ...(ingest ? { ingest: ingest.healthReport() } : {}),
    });
  });

  // ── Ecosystem analytics — the dynamically-updating dashboard surface ───────
  // Both endpoints are poll-friendly: cheap after a short TTL cache, stable shapes, and every
  // amount is an integer string with a `…Decimal` companion (no float ever touches money).

  const projectVolume = (volume: readonly AssetTotal[]): Record<string, unknown>[] =>
    volume.map(v => ({
      assetContract: v.assetContract,
      ...(v.asset !== undefined ? { asset: v.asset } : {}),
      ...(assetCode(v.asset) !== undefined ? { assetCode: assetCode(v.asset) } : {}),
      count: v.count,
      total: v.total,
      totalDecimal: toDecimal(v.total),
    }));

  const ecosystemCache = new Map<string, { value: unknown; at: number }>();
  const ECOSYSTEM_TTL_MS = 15_000;

  app.get("/ecosystem", c => {
    const network = c.req.query("network");
    const cacheKey = network ?? "";
    const now = Date.now();
    const hit = ecosystemCache.get(cacheKey);
    if (hit && now - hit.at < ECOSYSTEM_TTL_MS) return c.json(hit.value);
    if (ecosystemCache.size > 100) ecosystemCache.clear();

    const snapshot = store.ecosystem(network !== undefined ? { network } : {});
    const facilitators = facilitatorMap();
    const total = snapshot.totals.totalPayments;
    const value = {
      generatedAt: new Date(now).toISOString(),
      networks: config.networks.map(n => n.network),
      // Honest-coverage note for the page: which SAC transfers this deployment's tail watches.
      // "all" on testnet; a curated list on pubnet, where an unfiltered tail is infeasible.
      coverage: config.networks.map(n => ({
        network: n.network,
        watchedSacs: n.watchedSacs.length === 0 ? "all" : n.watchedSacs,
      })),
      totals: { ...snapshot.totals, byAsset: projectVolume(snapshot.totals.byAsset) },
      windows: Object.fromEntries(
        Object.entries(snapshot.windows).map(([key, w]) => [
          key,
          { ...w, volume: projectVolume(w.volume) },
        ]),
      ),
      facilitators: snapshot.facilitators.map(f => {
        const row = f.facilitatorId !== null ? facilitators.get(f.facilitatorId) : undefined;
        return {
          facilitatorId: f.facilitatorId,
          ...(row?.displayName !== undefined ? { displayName: row.displayName } : {}),
          ...(row !== undefined ? { verified: row.verified } : {}),
          payments: f.payments,
          // Share of counts, not money — a plain ratio is safe here.
          share: total > 0 ? Number((f.payments / total).toFixed(4)) : 0,
          windows: f.windows,
          ...(f.lastPaymentAt !== undefined ? { lastPaymentAt: f.lastPaymentAt } : {}),
        };
      }),
      topSellers: snapshot.topSellers.map(s => ({ ...s, volume: projectVolume(s.volume) })),
    };
    ecosystemCache.set(cacheKey, { value, at: now });
    return c.json(value);
  });

  const timeseriesCache = new Map<string, { value: unknown; at: number }>();
  const TIMESERIES_TTL_MS = 30_000;

  app.get("/ecosystem/timeseries", c => {
    const q = c.req.query();
    const bucket = q["bucket"] ?? "day";
    if (bucket !== "day" && bucket !== "hour") {
      throw new X402Error("explorer_invalid_query", {
        reason: 'Query parameter "bucket" must be "day" or "hour".',
        details: { parameter: "bucket", value: q["bucket"] },
      });
    }
    // Span: how many buckets the series covers, ending at the in-progress bucket.
    const spanParam = bucket === "day" ? "days" : "hours";
    const spanMax = bucket === "day" ? 90 : 168;
    let span = bucket === "day" ? 30 : 48;
    if (q[spanParam] !== undefined) {
      const parsed = Number(q[spanParam]);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > spanMax) {
        throw new X402Error("explorer_invalid_query", {
          reason: `Query parameter "${spanParam}" must be an integer between 1 and ${spanMax}.`,
          details: { parameter: spanParam, value: q[spanParam] },
        });
      }
      span = parsed;
    }
    const network = q["network"];

    const cacheKey = JSON.stringify([bucket, span, network ?? null]);
    const nowMs = Date.now();
    const hit = timeseriesCache.get(cacheKey);
    if (hit && nowMs - hit.at < TIMESERIES_TTL_MS) return c.json(hit.value);
    if (timeseriesCache.size > 200) timeseriesCache.clear();

    const stepMs = bucket === "day" ? 86_400_000 : 3_600_000;
    // Align to a bucket boundary so the first point covers a full bucket, not a partial scan.
    const from = new Date(Math.floor(nowMs / stepMs) * stepMs - (span - 1) * stepMs);
    const to = new Date(nowMs);
    const points = store.timeseries({
      bucket,
      from,
      to,
      ...(network !== undefined ? { network } : {}),
    });
    const value = {
      bucket,
      from: from.toISOString(),
      to: to.toISOString(),
      ...(network !== undefined ? { network } : {}),
      generatedAt: to.toISOString(),
      points: points.map(p => ({ ...p, volume: projectVolume(p.volume) })),
    };
    timeseriesCache.set(cacheKey, { value, at: nowMs });
    return c.json(value);
  });

  app.post("/announce", async c => {
    // /announce triggers an outbound probe, so it is the one write endpoint that needs a throttle
    // (review M6/m9). Fixed window per client, plus a global ceiling so a botnet can't fan out.
    if (!announceLimiter.allow(clientKey(c.req.header("x-forwarded-for")))) {
      throw new X402Error("explorer_announce_unreachable", {
        reason: "Too many announce attempts; slow down and try again shortly.",
      });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new X402Error("explorer_announce_invalid_url", {
        reason: "The announce body must be JSON: {\"baseUrl\": \"https://…\"}.",
      });
    }
    const baseUrl = (body as { baseUrl?: unknown }).baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.length > 2048) {
      throw new X402Error("explorer_announce_invalid_url", {
        reason: 'The announce body must carry a string "baseUrl" no longer than 2048 characters.',
      });
    }
    const row = await registry.announce(baseUrl);
    return c.json({ facilitator: projectFacilitator(row) });
  });

  app.get("/health", c => {
    const ingestHealth = ingest?.healthReport() ?? [];
    const stale = ingestHealth.some(h => h.consecutiveFailures >= 5);
    return c.json({
      status: stale ? "degraded" : "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      storage: config.dbPath !== undefined ? "durable" : "memory",
      // COUNT(*), not stats() — /health must not fold every amount on every Railway probe.
      payments: store.countPayments(),
      facilitators: store.listFacilitators().length,
      ...(ingest ? { ingest: ingestHealth } : { ingest: "disabled" }),
    });
  });

  app.get("/metrics", c => {
    const stats = cachedStats();
    const lines: string[] = [
      "# TYPE x402_explorer_payments_total gauge",
      `x402_explorer_payments_total ${stats.totalPayments}`,
      "# TYPE x402_explorer_facilitators gauge",
      `x402_explorer_facilitators ${store.listFacilitators().length}`,
    ];
    lines.push("# TYPE x402_explorer_payments_by_scheme gauge");
    for (const [scheme, count] of Object.entries(stats.byScheme)) {
      lines.push(`x402_explorer_payments_by_scheme{scheme="${promLabel(scheme)}"} ${count}`);
    }
    lines.push("# TYPE x402_explorer_payments_by_confidence gauge");
    for (const [confidence, count] of Object.entries(stats.byConfidence)) {
      lines.push(
        `x402_explorer_payments_by_confidence{confidence="${promLabel(confidence)}"} ${count}`,
      );
    }
    if (ingest) {
      const c2 = ingest.counters;
      lines.push(
        "# TYPE x402_explorer_polls_total counter",
        `x402_explorer_polls_total ${c2.polls}`,
        "# TYPE x402_explorer_events_seen_total counter",
        `x402_explorer_events_seen_total ${c2.eventsSeen}`,
        "# TYPE x402_explorer_transactions_fetched_total counter",
        `x402_explorer_transactions_fetched_total ${c2.transactionsFetched}`,
        "# TYPE x402_explorer_payments_ingested_total counter",
        `x402_explorer_payments_ingested_total ${c2.paymentsInserted}`,
        "# TYPE x402_explorer_rpc_failures_total counter",
        `x402_explorer_rpc_failures_total ${c2.rpcFailures}`,
        "# TYPE x402_explorer_backfill_pages_total counter",
        `x402_explorer_backfill_pages_total ${c2.backfillPages}`,
      );
      lines.push("# TYPE x402_explorer_last_ledger gauge");
      for (const h of ingest.healthReport()) {
        if (h.lastLedger !== undefined) {
          lines.push(`x402_explorer_last_ledger{network="${promLabel(h.network)}"} ${h.lastLedger}`);
        }
      }
    }
    if (horizon) {
      lines.push(
        "# TYPE x402_explorer_horizon_pages_total counter",
        `x402_explorer_horizon_pages_total ${horizon.counters.pages}`,
        "# TYPE x402_explorer_horizon_inserted_total counter",
        `x402_explorer_horizon_inserted_total ${horizon.counters.inserted}`,
      );
    }
    return c.text(`${lines.join("\n")}\n`, 200, {
      "Content-Type": "text/plain; version=0.0.4",
    });
  });

  return app;
}
