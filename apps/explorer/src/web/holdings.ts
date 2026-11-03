import { checkLumeusKey, isPublishableLumeusKey, request, type Fetch } from "@rail402.dev/ledger-source";
import type { IndexNetwork } from "@rail402.dev/x402-index";
import type { Answer } from "./bazaar.ts";
import { TokenBuckets } from "./live-lookup.ts";
import type { WebMetrics } from "./metrics.ts";

/**
 * Live holdings of an account from the Lumeus Assets API: current ledger state, shown on account and
 * facilitator pages labelled "live, not audited" and never used in any count. Answers are cached for a
 * few minutes, calls are bounded per minute across all visitors so page views cannot run up the key's
 * usage, and any failure renders the page without the card.
 */

/** The only hosts the key is sent to. */
export const LUMEUS_ASSETS_HOSTS: Readonly<Record<IndexNetwork, string>> = {
  "stellar:testnet": "https://assets-testnet.lumeus.dev",
  "stellar:pubnet": "https://assets.lumeus.dev",
};

export interface Holding {
  /** `XLM` for the native asset, else the asset code or token symbol. */
  readonly code: string;
  readonly issuer: string | null;
  readonly contract: string | null;
  /** Decimal, as Lumeus gives it. */
  readonly balance: string;
  readonly kind: string;
}

export interface Holdings {
  readonly items: readonly Holding[];
  readonly asOfLedger: number | null;
  readonly asOf: string | null;
}

export interface HoldingsClientOptions {
  readonly network: IndexNetwork;
  /** A Lumeus key of this network (read or publishable). Never logged or shown. */
  readonly apiKey: string;
  /** The Origin sent with a publishable key: the Explorer's public origin. */
  readonly origin?: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  /** How long an answer is kept (default 180 s). */
  readonly cacheMs?: number;
  /** Lumeus calls per minute across all visitors (default 30). */
  readonly perMinute?: number;
  readonly metrics?: WebMetrics;
  readonly now?: () => number;
}

const RISKY = new Set(["impersonation_risk", "likely_spam"]);
const STRKEY = /^[GC][A-Z2-7]{55}$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** The verified, non-zero, unflagged balances of a holdings answer, XLM first. */
export function parseHoldings(body: unknown): Holdings | undefined {
  if (!isObject(body)) return undefined;
  const embedded = isObject(body["_embedded"]) ? body["_embedded"] : {};
  const records = Array.isArray(embedded["records"]) ? embedded["records"].filter(isObject) : [];
  const items = records.flatMap((record): Holding[] => {
    const flags = Array.isArray(record["flags"]) ? record["flags"] : [];
    const balance = str(record["balance"], 48);
    const kind = str(record["kind"], 24) ?? "";
    const code = kind === "native" ? "XLM" : (str(record["code"], 12) ?? str(record["symbol"], 12));
    if (
      record["verified"] !== true ||
      flags.some((flag) => typeof flag === "string" && RISKY.has(flag)) ||
      balance === undefined ||
      !/^\d+(\.\d+)?$/.test(balance) ||
      /^0+(\.0+)?$/.test(balance) ||
      code === undefined ||
      kind === "pool_share"
    )
      return [];
    const issuer = str(record["issuer"], 56);
    const contract = str(record["contract_id"], 56);
    return [
      {
        code,
        issuer: issuer !== undefined && STRKEY.test(issuer) ? issuer : null,
        contract: contract !== undefined && STRKEY.test(contract) ? contract : null,
        balance,
        kind,
      },
    ];
  });
  items.sort((a, b) => (a.kind === "native" ? -1 : b.kind === "native" ? 1 : a.code.localeCompare(b.code)));
  const view = isObject(body["read_view"]) ? body["read_view"] : {};
  const ledger = view["as_of_ledger"];
  return {
    items: items.slice(0, 12),
    asOfLedger: typeof ledger === "number" && Number.isSafeInteger(ledger) ? ledger : null,
    asOf: str(view["as_of_closed_at"], 40) ?? null,
  };
}

export class HoldingsClient {
  readonly network: IndexNetwork;
  readonly #options: HoldingsClientOptions;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #budget: TokenBuckets;
  readonly #now: () => number;
  readonly #cache = new Map<string, { readonly until: number; readonly answer: Promise<Answer<Holdings>> }>();
  /** Lumeus calls made, for tests. */
  calls = 0;

  constructor(options: HoldingsClientOptions) {
    checkLumeusKey(options.apiKey, options.network, { publishable: true });
    let origin: string | undefined;
    if (isPublishableLumeusKey(options.apiKey)) {
      const parsed = options.origin === undefined ? undefined : new URL(options.origin);
      if (parsed?.protocol !== "https:")
        throw new TypeError("a publishable Lumeus key needs the https origin it is allowed for");
      origin = parsed.origin;
    }
    this.network = options.network;
    this.#options = options;
    this.#headers = {
      accept: "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...(origin === undefined ? {} : { origin }),
    };
    this.#now = options.now ?? Date.now;
    this.#budget = new TokenBuckets(options.perMinute ?? 30, { now: this.#now });
  }

  /** The account's live holdings, `none` for an address Lumeus does not know, `down` on any failure. */
  holdings(address: string): Promise<Answer<Holdings>> {
    if (!STRKEY.test(address)) return Promise.resolve({ status: "none" });
    const now = this.#now();
    const hit = this.#cache.get(address);
    if (hit !== undefined && hit.until > now) return hit.answer;
    if (this.#budget.take("all") > 0) {
      this.#options.metrics?.holdings.inc({ network: this.network, outcome: "budget" });
      return Promise.resolve({ status: "down" });
    }
    const answer = this.#fetch(address);
    this.#cache.delete(address);
    this.#cache.set(address, { until: now + (this.#options.cacheMs ?? 180_000), answer });
    void answer.then((settled) => {
      if (settled.status === "down" && this.#cache.get(address)?.answer === answer)
        this.#cache.set(address, { until: this.#now() + 15_000, answer });
    });
    while (this.#cache.size > 5_000) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return answer;
  }

  async #fetch(address: string): Promise<Answer<Holdings>> {
    this.calls++;
    const url = new URL(`/accounts/${address}/holdings`, LUMEUS_ASSETS_HOSTS[this.network]);
    url.searchParams.set("limit", "50");
    let outcome = "error";
    try {
      const response = await request(
        url,
        {
          maxBytes: 512 * 1024,
          timeoutMs: this.#options.timeoutMs ?? 2_500,
          attempts: 1,
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        },
        { headers: this.#headers },
      );
      if (response.status === 404) {
        outcome = "none";
        return { status: "none" };
      }
      const holdings = parseHoldings(JSON.parse(response.body.toString("utf8")));
      if (holdings === undefined) return { status: "down" };
      outcome = "ok";
      return { status: "ok", value: holdings };
    } catch {
      return { status: "down" };
    } finally {
      this.#options.metrics?.holdings.inc({ network: this.network, outcome });
    }
  }
}
