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
import { LocalNetwork } from "@rail402.dev/testkit";
import { harnessProvenance, recheckProvenance, writeEvidence } from "./evidence.ts";
import { buildEvidence, readTarget } from "./harness.ts";
import { allClientCodes } from "./client-codes.ts";
import { runMcpAudit } from "./rejection-audit-mcp.ts";
import { runRejectionAudit } from "./rejection-audit-run.ts";
import { runUptoAudit } from "./rejection-audit-upto.ts";
import { test6Asset } from "./test-token.ts";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  versions,
} from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    keyed: { type: "string" },
    limited: { type: "string" },
    mcp: { type: "boolean", default: false },
    "other-asset": { type: "string", default: "test6" },
    only: { type: "string" },
    "no-smart-account": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

async function main() {
  const net = new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);
  const target = await readTarget(args.facilitator);
  log(`facilitator ${target.facilitatorUrl} (version ${target.healthVersion})`);

  log("opening a treasury: Friendbot XLM, then USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open("2");
  const payers = await treasury.accounts(3, "0.1");
  const [payTo] = await treasury.accounts(1, "0");
  const [untrusted] = await treasury.accounts(1, "0", false);
  const [poor] = await treasury.accounts(1, "0.0000001");
  if (payTo === undefined || untrusted === undefined || poor === undefined) throw new Error("accounts");

  const recorder = await runRejectionAudit({
    facilitator: target.facilitatorUrl,
    supported: target.supported,
    net,
    asset: USDC_TESTNET_ADDRESS,
    isRegistered: isRail402Code,
    accounts: {
      payers,
      payTo: payTo.publicKey(),
      untrusted,
      poor,
      deployer: treasury.keypair,
      fund: (to, amount) => treasury.transfer(to, amount),
    },
    ...(args.keyed === undefined ? {} : { keyedFacilitator: args.keyed }),
    ...(args.limited === undefined ? {} : { limitedFacilitator: args.limited }),
    smartAccount: !args["no-smart-account"],
    ...(args.only === undefined ? {} : { only: args.only.split(",").map((id) => id.trim()) }),
    log,
  });

  const uptoKind = (
    target.supported as { kinds?: { scheme?: string; network?: string; extra?: Record<string, unknown> }[] }
  ).kinds?.find((kind) => kind.scheme === "upto" && kind.network === NETWORK);
  const authority = uptoKind?.extra?.["facilitatorAddress"];
  const otherAsset = args["other-asset"] === "none" ? undefined : test6Asset().contract;
  if (typeof authority === "string") {
    await runUptoAudit(recorder, {
      facilitator: target.facilitatorUrl,
      net,
      asset: USDC_TESTNET_ADDRESS,
      ...(otherAsset === undefined ? {} : { otherAsset }),
      authority,
      isRegistered: isRail402Code,
      accounts: {
        payers,
        payTo: payTo.publicKey(),
        untrusted,
        poor,
        deployer: treasury.keypair,
        fund: (to, amount) => treasury.transfer(to, amount),
      },
      smartAccount: !args["no-smart-account"],
    });
  } else {
    recorder.skip(
      { id: "upto", title: "upto refusals", checks: ["rejection-codes", "scheme-upto"], scheme: "upto" },
      "the facilitator does not advertise upto on stellar:testnet",
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
      rpcUrl: TESTNET_RPC_URL,
      asset: { contract: USDC_TESTNET_ADDRESS, symbol: "USDC", decimals: 7, builtIn: true },
      payTo: payTo.publicKey(),
      isRegistered: (code) => Object.hasOwn(allClientCodes, code),
      log,
    });
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
        (args["other-asset"] === "none" ? " --other-asset none" : ""),
      config: {
        asset: USDC_TESTNET_ADDRESS,
        ...(otherAsset === undefined ? {} : { otherAsset }),
        upto: typeof authority === "string",
        smartAccount: !args["no-smart-account"],
        mcp: args.mcp,
      },
      accounts: {
        payTo: payTo.publicKey(),
        untrusted: untrusted.publicKey(),
        poor: poor.publicKey(),
        treasury: treasury.keypair.publicKey(),
        ...Object.fromEntries(payers.map((payer, index) => [`payer${String(index + 1)}`, payer.publicKey()])),
      },
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
