#!/usr/bin/env node
import { join } from "node:path";
import { runDiscoveryLoop } from "./discovery-loop.js";
import { runRejectionAudit } from "./rejection-audit.js";
import { runOzAccount } from "./oz-account.js";
import {
  OZ_ACCOUNT_WASM_HASH,
  OZ_ED25519_VERIFIER,
  UPTO_CONTRACT,
  X402_POLICY,
} from "./oz-constants.js";
import { runSupportedSnapshot } from "./supported.js";
import { runTimeToDiscoverable } from "./time-to-discoverable.js";
import { runStellarNative } from "./stellar-native.js";
import { runMcpToolLoop } from "./mcp-tool-loop.js";
import { findRepoRoot, spawnFacilitator, type SpawnedFacilitator } from "./facilitator.js";
import { provisionUsdcAccounts } from "./provision.js";
import { toPayload, writeReport, type CanaryReport } from "./report.js";

/**
 * Canary CLI.
 *
 * ```
 * pnpm canary discovery-loop                          # spawns a facilitator, no configuration
 * pnpm canary rejection-audit --facilitator <url>     # points at a deployment
 * pnpm canary all                                     # every check against one facilitator
 * ```
 *
 * Exit code is the contract: 0 when every property held, 1 when one did not. Reports are written
 * either way — a failed run's evidence is the part that matters.
 */

/** Each check, its report filename, and how to run it. */
const CHECKS = {
  "discovery-loop": {
    file: "discovery-loop.json",
    run: (facilitatorUrl: string, runId: string) => runDiscoveryLoop({ facilitatorUrl, runId }),
  },
  "discovery-loop-public": {
    file: "discovery-loop-public.json",
    run: (facilitatorUrl: string, runId: string) =>
      runDiscoveryLoop({ facilitatorUrl, runId, publicSeller: true }),
    // Excluded from `all` because it must run against PRODUCTION host-policy: a hosted facilitator
    // soft-drops loopback resource URLs (SSRF hygiene), so the CLI spawns this one WITHOUT
    // BAZAAR_ALLOW_PRIVATE_HOSTS — which would break every other check's localhost seller. It fronts
    // the stock seller with a local Host-rewriting proxy so the seller declares a PUBLIC identity the
    // production-policy facilitator will catalog. Fully offline: no tunnel, no external service.
    prodHostPolicy: true,
  },
  "rejection-audit": {
    file: "rejection-audit.json",
    run: (facilitatorUrl: string, runId: string) => runRejectionAudit({ facilitatorUrl, runId }),
  },
  "oz-account": {
    file: "oz-account.json",
    run: (facilitatorUrl: string, runId: string) =>
      runOzAccount({
        facilitatorUrl,
        runId,
        accountWasmHash: OZ_ACCOUNT_WASM_HASH,
        verifier: OZ_ED25519_VERIFIER,
        policy: X402_POLICY,
        uptoContract: UPTO_CONTRACT,
      }),
  },
  "supported-snapshot": {
    file: "supported-snapshot.json",
    run: (facilitatorUrl: string) => runSupportedSnapshot({ facilitatorUrl }),
  },
  "mcp-tool-loop": {
    file: "mcp-tool-loop.json",
    run: (facilitatorUrl: string, runId: string) => runMcpToolLoop({ facilitatorUrl, runId }),
  },
  "stellar-native": {
    file: "stellar-native.json",
    run: (facilitatorUrl: string, runId: string) => runStellarNative({ facilitatorUrl, runId }),
    // Excluded from `all`, and this is the reason: it pays in REAL testnet USDC, which friendbot
    // cannot mint. A run without the faucet-provisioned accounts in `.env.testnet` would fail with
    // `canary_setup_failed` — a red nightly reporting a missing captcha rather than a regression,
    // which is how a monitoring system teaches everyone to ignore it. Self-issued assets are not a
    // substitute: the whole property under test is an identity the facilitator derives independently,
    // and nothing derives an identity for an asset minted five seconds ago.
    needsProvisionedUsdc: true,
  },
  "time-to-discoverable": {
    file: "time-to-discoverable.json",
    run: (facilitatorUrl: string, runId: string) =>
      runTimeToDiscoverable({ facilitatorUrl, runId }),
  },
} as const satisfies Record<
  string,
  {
    file: string;
    run: (facilitatorUrl: string, runId: string) => Promise<CanaryReport>;
    needsProvisionedUsdc?: boolean;
    prodHostPolicy?: boolean;
  }
>;

type CheckName = keyof typeof CHECKS;

const isCheck = (value: string): value is CheckName => Object.hasOwn(CHECKS, value);

interface Args {
  command: string;
  facilitator?: string;
  out?: string;
  runId?: string;
  port: number;
  retries: number;
  payer?: string;
  seller?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? "", port: 4122, retries: 0 };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--facilitator":
        if (value) args.facilitator = value;
        i++;
        break;
      case "--out":
        if (value) args.out = value;
        i++;
        break;
      case "--run-id":
        if (value) args.runId = value;
        i++;
        break;
      case "--port":
        if (value) args.port = Number(value);
        i++;
        break;
      case "--retries":
        if (value && Number.isInteger(Number(value)) && Number(value) >= 0) {
          args.retries = Number(value);
        }
        i++;
        break;
      case "--payer":
        if (value) args.payer = value;
        i++;
        break;
      case "--seller":
        if (value) args.seller = value;
        i++;
        break;
      default:
        break;
    }
  }
  return args;
}

/** Timestamp slug: sortable, filename-safe, and unique enough to key one run's catalog entry. */
function defaultRunId(): string {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
}

const USAGE = `usage: x402-stellar-canary <command> [options]

  discovery-loop        settle → catalogue → search, end to end
  discovery-loop-public same loop under PRODUCTION host-policy: the seller declares a public hostname
                        (via a local proxy) so a loopback-refusing facilitator catalogues it
  rejection-audit       every rejection path carries a code and an actionable reason
  oz-account            an OpenZeppelin smart account pays with exact AND upto under our policy
  supported-snapshot    /supported is complete, truthful, and matches what is reachable
  mcp-tool-loop         a paid MCP TOOL catalogues itself, is found, and is called and paid for
  stellar-native        derived asset identity + trustline pre-flight reach an agent, in real USDC
  time-to-discoverable  measures zero -> paid, discoverable endpoint
  all                   every check above EXCEPT stellar-native, against one facilitator
                        (stellar-native needs faucet USDC; run it by name)
  provision-usdc        prepare the accounts the upstream e2e suite needs

  --facilitator <url>   target a deployment (default: start one with a friendbot-funded signer)
  --out <path>          where to write the report (default: docs/status/<check>.json)
  --run-id <id>         label this run; also keys its catalogue entries
  --port <n>            port for the spawned facilitator
  --retries <n>         retry ONLY retryable failures, e.g. friendbot being unavailable
  --payer <S…>          provision-usdc: reuse an existing payer
  --seller <S…>         provision-usdc: reuse an existing seller`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // Provisioning is not a canary — it prepares the accounts one needs — but it lives here because
  // this is the package that already knows how to talk to testnet.
  if (args.command === "provision-usdc") {
    return provisionUsdcAccounts({
      payerSecret: args.payer,
      sellerSecret: args.seller,
      root: findRepoRoot(),
    });
  }

  const selected: CheckName[] =
    args.command === "all"
      ? (Object.keys(CHECKS) as CheckName[]).filter(c => {
          const spec = CHECKS[c];
          const needsProvisionedUsdc =
            "needsProvisionedUsdc" in spec && spec.needsProvisionedUsdc;
          const prodHostPolicy = "prodHostPolicy" in spec && spec.prodHostPolicy;
          return !needsProvisionedUsdc && !prodHostPolicy;
        })
      : isCheck(args.command)
        ? [args.command]
        : [];

  if (selected.length === 0) {
    console.error(USAGE);
    return 2;
  }

  const root = findRepoRoot();
  const statusDir = join(root, "docs", "status");
  const runId = args.runId ?? defaultRunId();
  const facilitatorLabel = args.facilitator ?? `spawned:${args.port}`;
  const pathFor = (check: CheckName) =>
    args.out && selected.length === 1 ? args.out : join(statusDir, CHECKS[check].file);

  const blankReport = (check: string, failure: ReturnType<typeof toPayload>): CanaryReport => ({
    check,
    status: "fail",
    observedAt: new Date().toISOString(),
    network: "stellar:testnet",
    facilitator: facilitatorLabel,
    durationMs: 0,
    steps: [],
    failure,
    observations: {},
  });

  // A nightly job that dies on a floating rejection publishes nothing, and "no report" is
  // indistinguishable from "not run yet" to anyone reading the status directory the next morning.
  // Stock SDK components do start unawaited background work, so this is not hypothetical: it is
  // how an unreachable facilitator first presented. Catch it, write the report, exit honestly.
  process.on("unhandledRejection", (error: unknown) => {
    const payload = toPayload(error);
    for (const check of selected) writeReport(pathFor(check), blankReport(check, payload));
    console.error(`\nFAIL [${payload.code}] ${payload.reason}`);
    process.exit(1);
  });

  let spawned: SpawnedFacilitator | undefined;
  let failures = 0;
  try {
    if (!args.facilitator) {
      // discovery-loop-public runs against production host-policy (loopback resource URLs refused), so
      // it must NOT get BAZAAR_ALLOW_PRIVATE_HOSTS. It is excluded from `all`, so it only runs alone.
      const only = selected.length === 1 ? selected[0] : undefined;
      const prodHostPolicy = only
        ? Boolean((CHECKS[only] as { prodHostPolicy?: boolean }).prodHostPolicy)
        : false;
      console.error(
        `no --facilitator given; starting one with a friendbot-funded signer${prodHostPolicy ? " (production host-policy)" : ""}`,
      );
      spawned = await spawnFacilitator(args.port, { allowPrivateHosts: !prodHostPolicy });
      console.error(`facilitator ${spawned.url} · signer ${spawned.signerAddress}`);
    }
    const facilitatorUrl = args.facilitator ?? spawned!.url;

    for (const check of selected) {
      console.error(`\n${check} · ${facilitatorUrl} · run ${runId}\n`);
      let report: CanaryReport;
      try {
        // Retry only what the registry says is retryable — in practice friendbot or Soroban RPC
        // being briefly unavailable. A failed assertion is never retried: retrying until green is
        // how a monitoring system learns to lie, and a flaky alarm gets muted long before it gets
        // fixed. Each attempt uses a fresh run id, so it is a genuinely new set of accounts.
        report = await CHECKS[check].run(facilitatorUrl, runId);
        for (let attempt = 1; attempt <= args.retries && report.failure?.retryable; attempt++) {
          console.error(
            `\nretrying (${attempt}/${args.retries}) after retryable failure [${report.failure.code}]\n`,
          );
          report = await CHECKS[check].run(facilitatorUrl, `${runId}r${attempt}`);
        }
      } catch (error) {
        report = blankReport(check, toPayload(error));
      }

      writeReport(pathFor(check), report);
      console.error(`\n${report.status.toUpperCase()} ${check} in ${report.durationMs}ms`);
      if (report.failure) console.error(`  [${report.failure.code}] ${report.failure.reason}`);
      if (report.status !== "pass") failures++;
    }

    return failures === 0 ? 0 : 1;
  } finally {
    await spawned?.stop();
  }
}

main().then(
  code => process.exit(code),
  error => {
    console.error("fatal:", error);
    process.exit(1);
  },
);
