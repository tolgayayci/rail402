/**
 * Evidence recorded before the current format (schemaVersion 2). Each harness wrote its own shape; these
 * schemas cover the fields the report renders, so an older file is still checked before it is shown.
 * A file of this kind is replaced by a schemaVersion 2 file the next time its harness records a run.
 */
import { z } from "zod";

const HASH = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-character hex transaction hash");
const DATE = z.iso.datetime({ offset: true });
const INTEGER = z.string().regex(/^-?\d+$/);
const PACKAGES = z.record(z.string(), z.string());

export const legacyCanonical = z.object({
  run: z.literal("canonical-exact"),
  date: DATE,
  network: z.string(),
  facilitator: z.url(),
  facilitatorVersion: z.string(),
  rail402Commit: z.string(),
  packages: PACKAGES,
  command: z.string().min(1),
  request: z.object({ url: z.string(), price: z.string(), status: z.number().int(), elapsedMs: z.number() }),
  settlement: z.object({
    transaction: HASH,
    ledger: z.number().int().positive(),
    payer: z.string(),
    payTo: z.string(),
    asset: z.string(),
    amount: INTEGER,
    feeChargedStroops: INTEGER,
    explorer: z.url(),
  }),
  balances: z.object({
    buyer: z.object({ before: INTEGER, after: INTEGER }),
    seller: z.object({ before: INTEGER, after: INTEGER }),
  }),
});

const matrixRejection = z.object({
  operation: z.string(),
  httpStatus: z.number().int(),
  code: z.string().min(1),
  reason: z.string().trim().min(1),
});

export const legacyLiveMatrix = z.object({
  run: z.literal("live-matrix"),
  date: DATE,
  network: z.string(),
  facilitator: z.url(),
  facilitatorVersion: z.string(),
  harnessCommit: z.string(),
  packages: PACKAGES,
  command: z.string().min(1),
  summary: z.object({
    cases: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    settlements: z.number().int(),
    rejections: z.number().int(),
  }),
  cases: z.array(
    z.object({
      id: z.string(),
      criterion: z.string().min(1),
      passed: z.boolean(),
      elapsedMs: z.number(),
      rejections: z.array(matrixRejection),
      transactions: z.array(z.object({ hash: HASH, feeChargedStroops: INTEGER, explorer: z.url() })),
    }),
  ),
});

const catalogOutcome = z.object({
  status: z.enum(["success", "processing", "rejected"]),
  code: z.string().min(1),
  reason: z.string().optional(),
  rejectedReason: z.string().optional(),
  listingId: z.string().optional(),
  version: z.number().int().optional(),
  dropped: z.array(z.string()).optional(),
});

export const legacyLiveBazaar = z.object({
  run: z.literal("live-bazaar"),
  date: DATE,
  network: z.string(),
  facilitator: z.url(),
  facilitatorVersion: z.string(),
  seller: z.url(),
  harnessCommit: z.string(),
  packages: PACKAGES,
  command: z.string().min(1),
  summary: z.object({
    cases: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    settlements: z.number().int(),
  }),
  cases: z.array(
    z.object({
      id: z.string(),
      rule: z.string().min(1),
      passed: z.boolean(),
      elapsedMs: z.number(),
      settlements: z.array(z.object({ transaction: HASH, outcome: catalogOutcome })),
      listing: z
        .object({ id: z.string(), state: z.string(), trust: z.string(), resource: z.string() })
        .optional(),
      versions: z
        .array(z.object({ version: z.number().int(), cause: z.string(), state: z.string() }))
        .optional(),
    }),
  ),
});

const stats = z.object({
  n: z.number().int(),
  p50: z.number(),
  p95: z.number(),
  mean: z.number(),
  min: z.number(),
  max: z.number(),
});
const settleStats = z.object({
  latencyMs: stats,
  ledgersToConfirm: stats,
  sponsorFeeStroops: stats,
  transactions: z.array(HASH),
});

export const legacyBenchmark = z.object({
  run: z.literal("benchmark"),
  network: z.string(),
  window: z.object({ started: DATE, finished: DATE }),
  harnessCommit: z.string(),
  packages: PACKAGES,
  command: z.string().min(1),
  workload: z.object({
    asset: z.string(),
    amountBaseUnits: INTEGER,
    samples: z.number().int(),
    smartAccountSamples: z.number().int(),
    concurrent: z.object({ batches: z.number().int(), size: z.number().int() }),
  }),
  results: z
    .array(
      z.object({
        facilitator: z.url(),
        networkRoundTripMs: stats,
        verify: z.object({ latencyMs: stats }),
        settle: settleStats,
        settleSmartAccount: settleStats,
        concurrent: settleStats
          .extend({
            batches: z.array(
              z.object({
                size: z.number().int(),
                wallMs: z.number(),
                succeeded: z.number().int(),
                uniqueTransactions: z.number().int(),
              }),
            ),
          })
          .optional(),
        failures: z.array(z.unknown()),
      }),
    )
    .min(1),
});

export const legacyUpstreamE2e = z.object({
  run: DATE,
  command: z.string().min(1),
  exitCode: z.number().int(),
  upstream: z.object({ repository: z.string(), commit: z.string(), version: z.string() }),
  rail402: z.object({ commit: z.string(), uncommittedChanges: z.boolean() }),
  network: z.string(),
  summary: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    durationMinutes: z.number(),
  }),
  bazaarDiscoveryValidation: z.string(),
  results: z.array(
    z.object({
      client: z.string(),
      server: z.string(),
      endpoint: z.string(),
      transport: z.string(),
      paymentFlow: z.string(),
      passed: z.boolean(),
      transaction: HASH.optional(),
    }),
  ),
});

export type LegacyEvidence =
  | { readonly kind: "canonical"; readonly data: z.infer<typeof legacyCanonical> }
  | { readonly kind: "live-matrix"; readonly data: z.infer<typeof legacyLiveMatrix> }
  | { readonly kind: "live-bazaar"; readonly data: z.infer<typeof legacyLiveBazaar> }
  | { readonly kind: "benchmark"; readonly data: z.infer<typeof legacyBenchmark> }
  | { readonly kind: "upstream-e2e"; readonly data: z.infer<typeof legacyUpstreamE2e> };

export type LegacyCanonical = z.infer<typeof legacyCanonical>;
export type LegacyLiveMatrix = z.infer<typeof legacyLiveMatrix>;
export type LegacyLiveBazaar = z.infer<typeof legacyLiveBazaar>;
export type LegacyBenchmark = z.infer<typeof legacyBenchmark>;
export type LegacyUpstreamE2e = z.infer<typeof legacyUpstreamE2e>;

/** Parses an older evidence file; the problems list is empty exactly when parsing succeeded. */
export function parseLegacy(value: unknown): { evidence?: LegacyEvidence; problems: string[] } {
  const run = (value as { run?: unknown } | null)?.run;
  const attempt = (kind: LegacyEvidence["kind"], schema: z.ZodType) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { evidence: { kind, data: parsed.data } as LegacyEvidence, problems: [] }
      : {
          problems: parsed.error.issues.map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
        };
  };
  switch (run) {
    case "canonical-exact":
      return attempt("canonical", legacyCanonical);
    case "live-matrix":
      return attempt("live-matrix", legacyLiveMatrix);
    case "live-bazaar":
      return attempt("live-bazaar", legacyLiveBazaar);
    case "benchmark":
      return attempt("benchmark", legacyBenchmark);
    default:
      // The upstream e2e harness recorded its start time under `run`.
      return attempt("upstream-e2e", legacyUpstreamE2e);
  }
}

/** The commit an older file says it was recorded at (possibly with a `-dirty` suffix). */
export function legacyCommit(evidence: LegacyEvidence): string {
  switch (evidence.kind) {
    case "canonical":
      return evidence.data.rail402Commit;
    case "live-matrix":
    case "live-bazaar":
    case "benchmark":
      return evidence.data.harnessCommit;
    case "upstream-e2e":
      return evidence.data.rail402.commit + (evidence.data.rail402.uncommittedChanges ? "-dirty" : "");
  }
}
