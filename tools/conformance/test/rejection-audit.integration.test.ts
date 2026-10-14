/**
 * The rejection audit against the service run as real processes on the private Stellar network: the
 * same code path `rejection-audit.ts` runs on the public testnet, with a second deployment that
 * requires an API key and a third with a small rate limit. The first deployment settles `upto` through
 * a settlement contract deployed for the run and accepts a second asset, for the `upto` rows. The MCP
 * rows spawn rail402-mcp over stdio with the first deployment as its Bazaar.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { isRail402Code } from "@rail402.dev/service";
import {
  LocalNetwork,
  ServiceProcess,
  deployUpto,
  mintTo,
  stopServiceProcesses,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { allClientCodes } from "../src/client-codes.ts";
import { checkEvidence } from "../src/evidence.ts";
import { CaseRecorder, buildEvidence, readTarget } from "../src/harness.ts";
import { runMcpAudit } from "../src/rejection-audit-mcp.ts";
import { runRejectionAudit } from "../src/rejection-audit-run.ts";
import { runUptoAudit } from "../src/rejection-audit-upto.ts";

const MAIN = fileURLToPath(new URL("../../../apps/rail402/src/main.ts", import.meta.url));
const MCP = fileURLToPath(new URL("../../../packages/mcp/src/bin.ts", import.meta.url));
const net = new LocalNetwork();
const available = await net.available();

async function ready(service: ServiceProcess): Promise<void> {
  await service.listening();
  const deadline = Date.now() + 60_000;
  while ((await fetch(`${service.url}/ready`)).status !== 200) {
    if (Date.now() > deadline) throw new Error("the service did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!available)("rejection audit against the local service", () => {
  let usdc: IssuedAsset;
  let eurc: IssuedAsset;
  let contract: LocalUptoContract;
  let main: ServiceProcess;
  let keyed: ServiceProcess;
  let limited: ServiceProcess;

  beforeAll(async () => {
    [usdc, eurc, contract] = await Promise.all([
      net.issueAsset("USDC"),
      net.issueAsset("EURC"),
      deployUpto(net),
    ]);
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const env = {
      STORE: "memory",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "2",
      TESTNET_ASSETS: `${usdc.sac}:USDC:7,${eurc.sac}:EURC:7`,
      TESTNET_UPTO_ENABLED: "true",
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      SEARCH_EMBEDDINGS: "false",
      RATE_LIMIT_PER_MINUTE: "0",
    };
    main = await ServiceProcess.start({ entry: MAIN, env });
    await ready(main);
    // The other deployments share the sponsor; the first one already provisioned its channels.
    keyed = await ServiceProcess.start({
      entry: MAIN,
      env: { ...env, TESTNET_REQUIRE_API_KEY: "true", API_KEY_SHA256: "0".repeat(64) },
    });
    limited = await ServiceProcess.start({ entry: MAIN, env: { ...env, RATE_LIMIT_PER_MINUTE: "3" } });
    await Promise.all([ready(keyed), ready(limited)]);
  });

  afterAll(async () => {
    await stopServiceProcesses();
  });

  it("finds a registered, expected code and a reason in every refusal", async () => {
    const target = await readTarget(main.url);
    const payers = await net.holders(usdc, 3, "0.1");
    const [payTo, deployer] = await net.holders(usdc, 2, "0");
    const poor = await net.holder(usdc, "0.0000001");
    const untrusted = Keypair.random();
    await net.fund(untrusted);
    if (payTo === undefined || deployer === undefined) throw new Error("fixture");

    const recorder = await runRejectionAudit({
      facilitator: main.url,
      supported: target.supported,
      net,
      asset: usdc.sac,
      isRegistered: isRail402Code,
      accounts: {
        payers,
        payTo: payTo.publicKey(),
        untrusted,
        poor,
        deployer,
        fund: (to, amount) => mintTo(net, usdc, to, amount),
      },
      keyedFacilitator: keyed.url,
      limitedFacilitator: limited.url,
    });
    const uptoKind = (
      target.supported as { kinds: { scheme: string; extra?: { facilitatorAddress?: string } }[] }
    ).kinds.find((kind) => kind.scheme === "upto");
    await runUptoAudit(recorder, {
      facilitator: main.url,
      net,
      asset: usdc.sac,
      otherAsset: eurc.sac,
      authority: uptoKind?.extra?.facilitatorAddress ?? "",
      contract: contract.address,
      // The service estimates ledger time from Horizon (5–6 s); a client assuming 6 s signs a window
      // inside what either estimate accepts.
      ledgerSeconds: 6,
      isRegistered: isRail402Code,
      accounts: {
        payers,
        payTo: payTo.publicKey(),
        untrusted,
        poor,
        deployer,
        fund: (to, amount) => mintTo(net, usdc, to, amount),
      },
    });

    const failures = recorder.cases
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.id}: ${String(entry.observations?.["error"])}`);
    expect(failures).toEqual([]);
    expect(recorder.cases.filter((entry) => entry.status === "skipped").map((entry) => entry.id)).toEqual([
      "bazaar-cataloging",
    ]);
    const rejections = recorder.cases.flatMap((entry) => entry.rejections ?? []);
    expect(new Set(rejections.map((rejection) => rejection.surface))).toEqual(
      new Set(["http", "facilitator", "bazaar", "search"]),
    );
    expect(rejections.length).toBeGreaterThan(150);
    const upto = recorder.cases.filter((entry) => entry.scheme === "upto");
    expect(upto.length).toBeGreaterThan(30);
    expect(upto.flatMap((entry) => entry.rejections ?? []).length).toBeGreaterThan(60);

    const evidence = buildEvidence(
      {
        kind: "rejection-audit",
        provenance: { commit: "a".repeat(40), dirty: false },
        network: "stellar:testnet",
        target,
        packages: {},
        command: "node --conditions=@rail402/source tools/conformance/src/rejection-audit.ts",
        config: {},
        accounts: { payTo: payTo.publicKey() },
        startedAt: recorder.startedAt,
      },
      recorder.cases,
    );
    expect(checkEvidence(evidence).problems).toEqual([]);
  });

  it("finds isError results with a registered code, a reason and paid none in every MCP tool refusal", async () => {
    // The server's policy lists a local token by its on-chain symbol (USDC is built in for the network).
    const tusd = await net.issueAsset("TUSD");
    const recorder = new CaseRecorder();
    await runMcpAudit(recorder, {
      command: [process.execPath, "--conditions=@rail402/source", MCP],
      facilitator: main.url,
      network: "stellar:testnet",
      rpcUrl: net.rpcUrl,
      asset: { contract: tusd.sac, symbol: "TUSD", decimals: 7 },
      payTo: Keypair.random().publicKey(),
      isRegistered: (code) => Object.hasOwn(allClientCodes, code),
    });
    const failures = recorder.cases
      .filter((entry) => entry.status === "failed")
      .map((entry) => `${entry.id}: ${String(entry.observations?.["error"])}`);
    expect(failures).toEqual([]);
    expect(recorder.cases.filter((entry) => entry.status === "skipped").map((entry) => entry.id)).toEqual([
      "mcp-session-cap",
    ]);
    expect(recorder.cases).toHaveLength(16);
    const rejections = recorder.cases.flatMap((entry) => entry.rejections ?? []);
    expect(new Set(rejections.map((rejection) => rejection.surface))).toEqual(new Set(["mcp"]));
    expect(rejections.map((rejection) => rejection.code)).toEqual(
      expect.arrayContaining(["tool_unknown", "rpc_params_invalid", "rpc_method_unknown"]),
    );
  });
});
