/**
 * Rejection audit over HTTP against a running Rail402 on the public Stellar testnet, in Circle USDC:
 * every refusal the facilitator, the transport, discovery and search can give, each checked for a
 * registered code the case expects and a non-empty reason. See rejection-audit-run.ts for the cases,
 * and rejection-audit-upto.ts for the `upto` rows, which run when the facilitator advertises `upto`
 * (with TEST6 as the second accepted asset of the wrong-asset case unless `--other-asset none`).
 * With `--mcp`, rail402-mcp is also spawned over stdio with the facilitator as its Bazaar, and every
 * tool refusal is checked as an MCP host sees it (rejection-audit-mcp.ts).
 *
 *   node --conditions=@rail402/source tools/conformance/src/rejection-audit.ts --facilitator http://… \
 *     [--keyed http://…] [--limited http://…] [--mcp] [--other-asset test6|none] [--only id,id] \
 *     [--write [--allow-branch <branch>]]
 *
 * `--keyed` is a second deployment with REQUIRE_API_KEY=true and `--limited` one with
 * RATE_LIMIT_PER_MINUTE=3; without them those cases are recorded as skipped, as they are against a
 * deployed service. Fresh Friendbot-funded accounts are created for every run, so the script needs no
 * secrets. With --write the evidence is recorded in
 * tools/conformance/evidence/rejection-audit-stellar-testnet.json for a Rail402 on this machine, and in
 * rejection-audit-hosted-stellar-testnet.json beside it for a deployed one (for example
 * https://testnet.rail402.dev).
 */
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRail402Code } from "@rail402.dev/service/codes";
import { harnessProvenance, recheckProvenance, writeEvidence } from "./evidence.ts";
import { buildEvidence, readTarget, type CaseRecorder } from "./harness.ts";
import { allClientCodes } from "./client-codes.ts";
import { runMcpAudit } from "./rejection-audit-mcp.ts";
import { runRejectionAudit, type AuditAccounts } from "./rejection-audit-run.ts";
import { runUptoAudit } from "./rejection-audit-upto.ts";
import { test6Asset } from "./test-token.ts";
import {
  NETWORK_OPTION,
  ProfileNetwork,
  assertSwept,
  feeCeilingStroops,
  parseNetworkId,
  profileEvidence,
  resolveProfile,
  startRun,
  sweepObservation,
  withRun,
} from "./network.ts";
import { gitCommit, log, versions } from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    keyed: { type: "string" },
    limited: { type: "string" },
    mcp: { type: "boolean", default: false },
    "other-asset": { type: "string" },
    only: { type: "string" },
    "no-smart-account": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
    ...NETWORK_OPTION,
  },
});

const PROFILE = resolveProfile(parseNetworkId(args.network));
const NETWORK = PROFILE.caip2;
const USDC_ADDRESS = PROFILE.usdc.contract;
// TEST6 is deployed on testnet only; on pubnet the wrong-asset cases use a contract nobody accepts.
const OTHER_ASSET = args["other-asset"] ?? (PROFILE.id === "testnet" ? "test6" : "none");
if (PROFILE.id !== "testnet" && OTHER_ASSET !== "none") {
  throw new Error("--other-asset test6 applies to testnet; the TEST6 token is not deployed on pubnet");
}
/**
 * `/settle` requests the audit sends at most (each settle-side refusal sends one; a few cases settle
 * before refusing a repeat): checked against the caps before anything is funded. Each request is
 * debited when it is sent.
 */
const MAX_SETTLE_REQUESTS = 120;

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

async function main() {
  const net = new ProfileNetwork(PROFILE);
  const target = await readTarget(args.facilitator);
  log(`facilitator ${target.facilitatorUrl} (version ${target.healthVersion})`);
  const uptoKind = (
    target.supported as { kinds?: { scheme?: string; network?: string; extra?: Record<string, unknown> }[] }
  ).kinds?.find((kind) => kind.scheme === "upto" && kind.network === NETWORK);
  const authority = uptoKind?.extra?.["facilitatorAddress"];
  // The upto rows run when the facilitator advertises upto; on pubnet they need the upto contract
  // and the upto fee ceiling, refused here before anything is funded.
  const profile =
    PROFILE.id !== "testnet" && typeof authority === "string"
      ? resolveProfile(PROFILE.id, { needsUpto: true })
      : PROFILE;
  const otherAsset = OTHER_ASSET === "none" ? undefined : test6Asset().contract;

  const treasury = await startRun("rejection-audit", profile, net, {
    usdc: "2",
    facilitators: [target.facilitatorUrl],
  });
  treasury.meter.ensure(
    {
      settlements: MAX_SETTLE_REQUESTS,
      xlmStroops:
        feeCeilingStroops(profile, typeof authority === "string" ? "upto" : "exact") *
        BigInt(MAX_SETTLE_REQUESTS),
      usdcBaseUnits: 4_000_000n,
    },
    `up to ${String(MAX_SETTLE_REQUESTS)} settle requests`,
  );
  let recorder: CaseRecorder | undefined;
  const fixtures: Record<string, string> = {};
  const sweep = await withRun(treasury, async () => {
    const payers = await treasury.accounts(3, "0.1", true, { role: "payer" });
    const [payTo] = await treasury.accounts(1, "0", true, { role: "payto" });
    const [untrusted] = await treasury.accounts(1, "0", false, { role: "untrusted" });
    const [poor] = await treasury.accounts(1, "0.0000001", true, { role: "poor" });
    if (payTo === undefined || untrusted === undefined || poor === undefined) throw new Error("accounts");
    Object.assign(fixtures, {
      payTo: payTo.publicKey(),
      untrusted: untrusted.publicKey(),
      poor: poor.publicKey(),
      ...Object.fromEntries(payers.map((payer, index) => [`payer${String(index + 1)}`, payer.publicKey()])),
    });
    const accounts: AuditAccounts = {
      payers,
      payTo: payTo.publicKey(),
      untrusted,
      poor,
      deployer: treasury.keypair,
      fund: (to, amount) => treasury.transfer(to, amount),
      smartAccount: () => treasury.smartAccount("wrong-key"),
    };
    recorder = await runRejectionAudit({
      facilitator: target.facilitatorUrl,
      supported: target.supported,
      net,
      network: NETWORK,
      asset: USDC_ADDRESS,
      isRegistered: isRail402Code,
      accounts,
      ...(args.keyed === undefined ? {} : { keyedFacilitator: args.keyed }),
      ...(args.limited === undefined ? {} : { limitedFacilitator: args.limited }),
      smartAccount: !args["no-smart-account"],
      ...(args.only === undefined ? {} : { only: args.only.split(",").map((id) => id.trim()) }),
      log,
    });

    if (typeof authority === "string") {
      await runUptoAudit(recorder, {
        facilitator: target.facilitatorUrl,
        net,
        network: NETWORK,
        asset: USDC_ADDRESS,
        ...(otherAsset === undefined ? {} : { otherAsset }),
        authority,
        // The configured contract on pubnet; the network's canonical deployment on testnet.
        ...(profile.id === "testnet" || profile.upto === undefined
          ? {}
          : { contract: profile.upto.contract }),
        isRegistered: isRail402Code,
        accounts,
        smartAccount: !args["no-smart-account"],
      });
    } else {
      recorder.skip(
        { id: "upto", title: "upto refusals", checks: ["rejection-codes", "scheme-upto"], scheme: "upto" },
        `the facilitator does not advertise upto on ${NETWORK}`,
        "pending-dependency",
      );
    }

    if (args.mcp) {
      await runMcpAudit(recorder, {
        command: [
          process.execPath,
          "--conditions=@rail402/source",
          fileURLToPath(new URL("../../../packages/mcp/src/bin.ts", import.meta.url)),
        ],
        facilitator: target.facilitatorUrl,
        network: NETWORK,
        rpcUrl: net.rpcUrl,
        asset: { contract: USDC_ADDRESS, symbol: "USDC", decimals: 7, builtIn: true },
        payTo: payTo.publicKey(),
        isRegistered: (code) => Object.hasOwn(allClientCodes, code),
        log,
      });
    }
  });
  if (recorder === undefined) throw new Error("the audit did not run");
  if (PROFILE.id !== "testnet") {
    await recorder.run(
      {
        id: "sweep-back",
        title: "the run's USDC is back in the operator treasury and its accounts are merged",
        checks: ["pubnet-config"],
      },
      (context) => {
        context.observe("sweep", sweepObservation(sweep));
        assertSwept(sweep);
        return Promise.resolve();
      },
    );
  }
  const evidence = buildEvidence(
    {
      kind: "rejection-audit",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      packages: versions([
        "@x402/core",
        "@x402/stellar",
        "@stellar/stellar-sdk",
        ...(args.mcp ? ["@rail402.dev/mcp", "@modelcontextprotocol/client"] : []),
      ]),
      command:
        `node --conditions=@rail402/source tools/conformance/src/rejection-audit.ts --facilitator ${target.facilitatorUrl}` +
        (args.keyed === undefined ? "" : ` --keyed ${args.keyed}`) +
        (args.limited === undefined ? "" : ` --limited ${args.limited}`) +
        (args.mcp ? " --mcp" : "") +
        (args["other-asset"] === "none" ? " --other-asset none" : "") +
        (PROFILE.id === "testnet" ? "" : ` --network ${PROFILE.id}`),
      config: {
        asset: USDC_ADDRESS,
        ...(otherAsset === undefined ? {} : { otherAsset }),
        upto: typeof authority === "string",
        smartAccount: !args["no-smart-account"],
        mcp: args.mcp,
      },
      accounts: {
        payTo: fixtures["payTo"] ?? "",
        untrusted: fixtures["untrusted"] ?? "",
        poor: fixtures["poor"] ?? "",
        treasury: treasury.keypair.publicKey(),
        ...Object.fromEntries(Object.entries(fixtures).filter(([key]) => key.startsWith("payer"))),
      },
      ...(PROFILE.id === "testnet" ? {} : { profile: profileEvidence(profile, treasury, sweep) }),
      startedAt: recorder.startedAt,
    },
    recorder.cases,
  );
  if (provenance === undefined) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"] })}`);
  }
  log(
    `${String(evidence.summary.passed)} passed, ${String(evidence.summary.failed)} failed, ${String(evidence.summary.skipped)} skipped`,
  );
  if (recorder.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
