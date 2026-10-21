/**
 * The configuration the Playground server publishes to the page at `GET /api/config`. Everything in
 * it is public: endpoints, the asset, caps and limits. The server has no secret to put here, and a
 * test refuses any property name that looks like one.
 */
import { z } from "zod";
import { CHECK_IDS, EXPERIMENT_IDS, SCENARIO_IDS } from "./lab.ts";

export const CONFIG_PATH = "/api/config";

const url = z.url({ protocol: /^https?$/ });
/** A decimal amount in whole units, with at most 7 decimals. */
const decimal = z.string().regex(/^(0|[1-9]\d{0,18})(\.\d{1,7})?$/);
const atomic = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const stellarAccount = z.string().regex(/^G[A-Z2-7]{55}$/);
const stellarContract = z.string().regex(/^C[A-Z2-7]{55}$/);
const positiveInt = z.number().int().positive();

export const publicConfigSchema = z.strictObject({
  /** The Playground's version and commit. */
  version: z.string().min(1),
  commit: z.string(),
  /** `hosted` serves the public testnet; `local` (loopback only) lets the relay reach local sellers. */
  mode: z.enum(["hosted", "local"]),
  network: z.literal("stellar:testnet"),
  networkPassphrase: z.string().min(1),
  urls: z.strictObject({
    /** The Playground's own origin. */
    public: url,
    rpc: url,
    horizon: url,
    friendbot: url,
    facilitator: url,
    bazaar: url,
    demoSeller: url,
    docs: url,
  }),
  /** Transaction links: `{network}` and `{hash}` are replaced. */
  explorerTemplate: z.string().includes("{hash}"),
  asset: z.strictObject({
    contract: stellarContract,
    symbol: z.string().min(1).max(12),
    decimals: z.number().int().min(0).max(18),
    /** The classic asset behind the contract, for the trustline and the test-funds purchase. */
    classic: z.strictObject({ code: z.string().min(1).max(12), issuer: stellarAccount }),
  }),
  /** The upto settlement contract the buyer's policy pins. */
  uptoContract: stellarContract,
  caps: z.strictObject({
    perCallDefault: decimal,
    perCallLowPreset: decimal,
    /** The operator's ceiling: a per-call cap above it is clamped to it. */
    perCallCeiling: decimal,
    sessionTotal: decimal,
    sessionTtlMs: positiveInt,
  }),
  lab: z.strictObject({
    enabled: z.boolean(),
    /** The Playground's own testnet account that lab sellers are paid to; null when the lab is off. */
    payTo: stellarAccount.nullable(),
    paths: z.strictObject({
      sell: z.string().startsWith("/lab/"),
      greedy: z.string().startsWith("/lab/"),
      offers: z.strictObject({
        pubnet: z.string().startsWith("/lab/"),
        asset: z.string().startsWith("/lab/"),
        zero: z.string().startsWith("/lab/"),
      }),
    }),
    prices: z.strictObject({ sell: atomic, greedyCap: atomic, greedyCharge: atomic }),
    /** The scenarios, experiments and checks this Playground can run with its features on. */
    scenarios: z.array(z.enum(SCENARIO_IDS)),
    experiments: z.array(z.enum(EXPERIMENT_IDS)),
    checks: z.array(z.enum(CHECK_IDS)),
  }),
  relay: z.strictObject({
    enabled: z.boolean(),
    /** The relay's egress policy, mirrored by the page's transport. */
    policy: z.strictObject({
      schemes: z.array(z.enum(["https:", "http:"])).min(1),
      ports: z.array(z.number().int().min(1).max(65_535)).min(1),
      /** Loopback targets are reachable (local mode only); no other private address ever is. */
      allowLoopback: z.boolean(),
      maxRedirects: z.number().int().min(0),
    }),
    limits: z.strictObject({
      targetBytes: positiveInt,
      requestBodyBytes: positiveInt,
      responseBodyBytes: positiveInt,
    }),
    timeoutMaxima: z.strictObject({ headersMs: positiveInt, idleMs: positiveInt, totalMs: positiveInt }),
  }),
  onboarding: z.strictObject({
    /** Test funds bought with Friendbot XLM, in whole units of the asset. */
    buyAmount: decimal,
    /** XLM kept for reserves and setup fees. */
    keepXlm: decimal,
    /** Where to get test funds by hand when the purchase fails. */
    faucetUrl: url,
  }),
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;

/** Validates an `/api/config` body; undefined when it does not match. */
export function parsePublicConfig(value: unknown): PublicConfig | undefined {
  const parsed = publicConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Property names that suggest secret material. The configuration, run reports and trace headers must
 * not contain any; `networkPassphrase` is public and allowed.
 */
export const SECRET_LIKE_NAME = /secret|seed|private|mnemonic|passphrase|signature|authorization/i;
export const PUBLIC_NAMES: ReadonlySet<string> = new Set(["networkPassphrase"]);

/** Every property name in a JSON value that looks secret and is not known to be public. */
export function secretLikeNames(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, index) => secretLikeNames(item, `${path}[${String(index)}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, child]) => [
    ...(SECRET_LIKE_NAME.test(name) && !PUBLIC_NAMES.has(name)
      ? [`${path}${path === "" ? "" : "."}${name}`]
      : []),
    ...secretLikeNames(child, `${path}${path === "" ? "" : "."}${name}`),
  ]);
}
