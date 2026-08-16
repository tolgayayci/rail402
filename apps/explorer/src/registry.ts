import type { Logger } from "pino";
import { StrKey } from "@stellar/stellar-sdk";
import { isPayableResourceUrl, NO_REDIRECT } from "@rail402.dev/agent-helpers";
import { X402Error } from "@rail402.dev/errors";
import type { ExplorerStore } from "./db.js";
import type { FetchLike } from "./rpc.js";
import type { FacilitatorRow } from "./types.js";

/**
 * The facilitator registry: who submits x402 settlements, and which accounts to attribute to whom.
 *
 * Everything here follows one trust rule: **an announcement is a lead, never a fact.** The registry
 * probes `/supported` itself and only what it observes first-hand becomes attribution data. The
 * incumbent explorer's registry is a hand-maintained pull-request allowlist; this one is
 * self-serve, verified, and re-polled — signer sets change without redeploys (observed on our own
 * deployment: the docs/status snapshot signer differed from the live one the same week).
 */

/** Hosts with human-curated identity. Anything else gets a slug derived from its hostname. */
const WELL_KNOWN: Record<string, { id: string; displayName: string }> = {
  "facilitator.rail402.dev": { id: "rail402", displayName: "Rail402" },
  "x402.org": { id: "x402-org", displayName: "x402.org" },
  // The "Built on Stellar" facilitator (https://developers.stellar.org/.../x402/built-on-stellar).
  // Its /supported requires an API key; the token is provided via EXPLORER_FACILITATOR_AUTH.
  "channels.openzeppelin.com": {
    id: "built-on-stellar",
    displayName: "Built on Stellar (OpenZeppelin)",
  },
};

const PROBE_TIMEOUT_MS = 10_000;

export function slugForUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const known = WELL_KNOWN[url.hostname];
  if (known) return known.id;
  return url.hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface SupportedProbe {
  readonly signers: readonly string[];
  readonly uptoContracts: readonly string[];
  readonly networks: readonly string[];
}

/** Parse a stock /supported body into the registry's view of it. Unknown shapes yield empties. */
export function parseSupported(body: unknown): SupportedProbe {
  const record =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const signers = new Set<string>();
  const signerMap =
    typeof record["signers"] === "object" && record["signers"] !== null
      ? (record["signers"] as Record<string, unknown>)
      : {};
  for (const value of Object.values(signerMap)) {
    if (!Array.isArray(value)) continue;
    for (const signer of value) {
      // CHECKSUMMED validation, not shape: Algorand addresses are also uppercase base32 and can
      // start with G (live-captured from x402.org's `algorand:*` signers). Only a strkey that
      // verifies belongs in the Stellar attribution index.
      if (
        typeof signer === "string" &&
        (StrKey.isValidEd25519PublicKey(signer) || StrKey.isValidMed25519PublicKey(signer))
      ) {
        signers.add(signer);
      }
    }
  }
  const uptoContracts = new Set<string>();
  const networks = new Set<string>();
  const kinds = Array.isArray(record["kinds"]) ? record["kinds"] : [];
  for (const rawKind of kinds) {
    const kind =
      typeof rawKind === "object" && rawKind !== null
        ? (rawKind as Record<string, unknown>)
        : {};
    if (typeof kind["network"] === "string") networks.add(kind["network"]);
    const extra =
      typeof kind["extra"] === "object" && kind["extra"] !== null
        ? (kind["extra"] as Record<string, unknown>)
        : {};
    const contract = extra["uptoContract"];
    if (typeof contract === "string" && StrKey.isValidContract(contract)) {
      uptoContracts.add(contract);
    }
  }
  // Cap what one facilitator can contribute (review M7): a self-reported /supported carrying a
  // huge signer list would be JSON-serialised into the row and re-parsed on every ingest batch.
  return {
    signers: [...signers].slice(0, MAX_SIGNERS_PER_FACILITATOR),
    uptoContracts: [...uptoContracts].slice(0, MAX_UPTO_CONTRACTS_PER_FACILITATOR),
    networks: [...networks].slice(0, MAX_NETWORKS_PER_FACILITATOR),
  };
}

const MAX_SIGNERS_PER_FACILITATOR = 64;
const MAX_UPTO_CONTRACTS_PER_FACILITATOR = 16;
const MAX_NETWORKS_PER_FACILITATOR = 32;
/** A /supported body larger than this is refused unread — no honest one is close. */
const MAX_SUPPORTED_BYTES = 256 * 1024;

export interface RegistryOptions {
  readonly store: ExplorerStore;
  readonly seeds: readonly string[];
  readonly pollIntervalMs: number;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Allow http/private announce targets — LOCAL DEVELOPMENT ONLY, never on a deployment. */
  readonly allowPrivateHosts?: boolean;
  /** Bearer tokens keyed by facilitator base URL, for facilitators whose /supported needs auth. */
  readonly auth?: ReadonlyMap<string, string>;
}

export class FacilitatorRegistry {
  private readonly store: ExplorerStore;
  private readonly seeds: readonly string[];
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly allowPrivateHosts: boolean;
  private readonly auth: ReadonlyMap<string, string>;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;

  constructor(options: RegistryOptions) {
    this.store = options.store;
    this.seeds = options.seeds;
    this.pollIntervalMs = options.pollIntervalMs;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.auth = options.auth ?? new Map();
  }

  /**
   * A deterministic id that can never capture another facilitator's row: upsert conflicts on id,
   * so a second base URL on the same hostname must get a distinct slug, not overwrite the first.
   */
  private uniqueId(baseUrl: string): string {
    const base = slugForUrl(baseUrl);
    let candidate = base;
    for (let suffix = 2; ; suffix += 1) {
      const row = this.store.getFacilitator(candidate);
      if (!row || row.baseUrl === baseUrl) return candidate;
      candidate = `${base}-${suffix}`;
    }
  }

  /** Idempotently register the configured seeds (unverified until the first probe lands). */
  seed(): void {
    for (const baseUrl of this.seeds) {
      const normalized = baseUrl.replace(/\/+$/, "");
      if (this.store.getFacilitatorByUrl(normalized)) continue;
      const hostname = new URL(normalized).hostname;
      this.store.upsertFacilitator({
        id: this.uniqueId(normalized),
        baseUrl: normalized,
        ...(WELL_KNOWN[hostname] ? { displayName: WELL_KNOWN[hostname].displayName } : {}),
        verified: false,
        signers: [],
        uptoContracts: [],
        networks: [],
        source: "seed",
        createdAt: this.now().toISOString(),
      });
    }
  }

  start(): void {
    const tick = (): void => {
      void this.refreshAll().catch(error => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "registry refresh failed",
        );
      });
    };
    tick();
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refreshAll(): Promise<void> {
    // In-flight guard (review M7): with many unreachable facilitators a cycle can outrun the
    // interval; overlapping cycles would pile up SQLite writes. Skip if one is already running.
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const facilitator of this.store.listFacilitators()) {
        await this.refreshOne(facilitator);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshOne(facilitator: FacilitatorRow): Promise<void> {
    try {
      const probe = await this.probe(facilitator.baseUrl);
      this.store.upsertFacilitator({
        ...facilitator,
        verified: true,
        signers: probe.signers,
        uptoContracts: probe.uptoContracts,
        networks: probe.networks,
        lastSeenAt: this.now().toISOString(),
        // lastError deliberately dropped on success.
      });
      // Attribute any stored x402-shaped rows whose source is one of this facilitator's signers.
      // Run on EVERY refresh, not just on signer change: the history backfill keeps inserting older
      // rows over many passes, and INSERT OR IGNORE cannot flip a row that was already stored as
      // x402-shaped before this facilitator was known — so a periodic sweep is what converges a
      // facilitator's attributed count to its true historical volume. It is a cheap UPDATE that
      // only touches currently-unattributed rows. First-claim-wins: only signers this facilitator
      // legitimately owns are claimed.
      const owned = probe.signers.filter(
        s => (this.store.signerIndex().get(s) ?? facilitator.id) === facilitator.id,
      );
      const confidence = facilitator.id === "rail402" ? "rail402" : "verified-facilitator";
      const changed = this.store.reattribute(facilitator.id, confidence, owned);
      if (changed > 0) {
        this.logger.info(
          { id: facilitator.id, reattributed: changed },
          "attributed stored payments to a known facilitator",
        );
      }
      this.logger.debug(
        { id: facilitator.id, signers: probe.signers.length },
        "facilitator refreshed",
      );
    } catch (error) {
      // A previously verified facilitator KEEPS its last-known signers — attribution from stale
      // data beats attribution from none — but the failure is recorded and visible.
      this.store.upsertFacilitator({
        ...facilitator,
        lastError: error instanceof Error ? error.message : String(error),
      });
      this.logger.warn(
        { id: facilitator.id, err: error instanceof Error ? error.message : String(error) },
        "facilitator /supported probe failed",
      );
    }
  }

  private async probe(baseUrl: string): Promise<SupportedProbe> {
    const normalized = baseUrl.replace(/\/+$/, "");
    const token = this.auth.get(normalized);
    const response = await this.fetchImpl(`${normalized}/supported`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      ...(token !== undefined ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      ...NO_REDIRECT,
    });
    if (!response.ok) throw new Error(`/supported returned HTTP ${response.status}`);
    // Read as text with a size cap before parsing (review M7): an unbounded response.json() lets
    // one announced host feed arbitrarily large JSON that is then re-parsed on every ingest batch.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SUPPORTED_BYTES) {
      throw new Error(`/supported body too large (${declared} bytes)`);
    }
    const text = await response.text();
    if (text.length > MAX_SUPPORTED_BYTES) {
      throw new Error(`/supported body too large (${text.length} bytes)`);
    }
    return parseSupported(JSON.parse(text));
  }

  /**
   * Self-serve intake: an announced base URL is validated, probed, and registered — verified only
   * by what WE observed. The host policy is the shared outbound guard (a second copy
   * of a defensive parse is the copy that stops rejecting).
   */
  async announce(rawBaseUrl: string): Promise<FacilitatorRow> {
    const baseUrl = typeof rawBaseUrl === "string" ? rawBaseUrl.trim().replace(/\/+$/, "") : "";
    if (
      baseUrl === "" ||
      !isPayableResourceUrl(baseUrl, this.allowPrivateHosts) ||
      (!this.allowPrivateHosts && !baseUrl.startsWith("https://"))
    ) {
      throw new X402Error("explorer_announce_invalid_url", {
        details: { baseUrl: rawBaseUrl },
      });
    }
    const existing = this.store.getFacilitatorByUrl(baseUrl);
    let probe: SupportedProbe;
    try {
      probe = await this.probe(baseUrl);
    } catch (error) {
      throw new X402Error("explorer_announce_unreachable", {
        details: {
          baseUrl,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
    const row: FacilitatorRow = {
      id: existing?.id ?? this.uniqueId(baseUrl),
      baseUrl,
      ...(existing?.displayName !== undefined ? { displayName: existing.displayName } : {}),
      verified: true,
      signers: probe.signers,
      uptoContracts: probe.uptoContracts,
      networks: probe.networks,
      source: existing?.source ?? "announce",
      lastSeenAt: this.now().toISOString(),
      createdAt: existing?.createdAt ?? this.now().toISOString(),
    };
    this.store.upsertFacilitator(row);
    this.logger.info({ id: row.id, baseUrl }, "facilitator announced and verified");
    return row;
  }
}
