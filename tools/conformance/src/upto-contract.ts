/**
 * The deployed `upto` settlement contract on the public testnet, checked against its source: the
 * committed deployment record (contracts/stellar/deployments/testnet.json) agrees with the address and
 * WASM hash `@rail402.dev/upto` ships; the contract instance on chain runs that WASM and is live; the
 * WASM `stellar contract fetch` downloads hashes to it; and a reproducible rebuild of the recorded
 * source revision in the pinned build image produces it byte for byte (scripts/contracts/verify.sh).
 * With `--facilitator`, the facilitator's `/health` must name the same contract. The TEST6 test token
 * is checked against its own record the same way, without the rebuild.
 *
 *   node --conditions=@rail402/source tools/conformance/src/upto-contract.ts [--facilitator http://…] \
 *     [--no-rebuild] [--write [--allow-branch <branch>]]
 *
 * Needs the `stellar` CLI on PATH (or `STELLAR_CLI`), and Docker, git and jq for the rebuild. It reads
 * only; nothing is signed or submitted. With --write the result is recorded as schemaVersion 2 evidence.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { rpc } from "@stellar/stellar-sdk";
import { networkPassphrase, readContractTtl } from "@rail402.dev/stellar";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
import { z } from "zod";
import { harnessProvenance, recheckProvenance, writeEvidence } from "./evidence.ts";
import { CaseRecorder, buildEvidence, explorerUrl, readTarget, type Target } from "./harness.ts";
import { NETWORK, TESTNET_RPC_URL, gitCommit, log, versions } from "./testnet.ts";
import { checkTest6OnChain, readTest6Record } from "./test-token.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string" },
    "no-rebuild": { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

// Evidence is recorded only from a clean commit on main.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** `contracts/stellar/deployments/testnet.json` in this repository. */
export const UPTO_RECORD_PATH = join(ROOT, "contracts/stellar/deployments/testnet.json");
const STELLAR = process.env["STELLAR_CLI"] ?? "stellar";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const transaction = z.object({ tx: hex64, ledger: z.number().int().positive() });

/** The fields of the deployment record this run relies on; other fields are kept but not checked. */
export const uptoRecordSchema = z.looseObject({
  contract: z.literal("upto"),
  caip2: z.literal("stellar:testnet"),
  network_passphrase: z.string(),
  rpc_url: z.url(),
  contract_id: z.string().regex(/^C[A-Z2-7]{55}$/),
  wasm_sha256: hex64,
  source: z.string().min(1),
  source_sha256: hex64,
  bldimg: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  transactions: z.looseObject({ upload: transaction, deploy: transaction }),
});

export type UptoRecord = z.infer<typeof uptoRecordSchema>;

export function readUptoRecord(path = UPTO_RECORD_PATH): UptoRecord {
  return uptoRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Downloads the WASM `contract` runs with the stellar CLI; its SHA-256. */
function fetchWasmHash(contract: string, rpcUrl: string, passphrase: string): string {
  const directory = mkdtempSync(join(tmpdir(), "rail402-fetch-"));
  try {
    const file = join(directory, "contract.wasm");
    execFileSync(
      STELLAR,
      [
        "contract",
        "fetch",
        "--id",
        contract,
        "--rpc-url",
        rpcUrl,
        "--network-passphrase",
        passphrase,
        "--out-file",
        file,
        "--quiet",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    return sha256(readFileSync(file));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function stellarVersion(): string {
  try {
    return execFileSync(STELLAR, ["--version"], { encoding: "utf8" }).split("\n")[0]?.trim() ?? "unknown";
  } catch {
    return "unavailable";
  }
}

async function main() {
  const record = readUptoRecord();
  const test6 = readTest6Record();
  const server = new rpc.Server(TESTNET_RPC_URL);
  const recorder = new CaseRecorder();
  const target: Target =
    args.facilitator === undefined
      ? // No facilitator is involved; the run reads the chain only.
        { mode: "local", facilitatorUrl: "http://127.0.0.1", healthVersion: "unknown", supported: null }
      : await readTarget(args.facilitator);

  await recorder.run(
    {
      id: "record",
      title:
        "the deployment record names the contract and WASM hash @rail402.dev/upto ships for stellar:testnet",
      checks: ["scheme-upto"],
      scheme: "upto",
    },
    (context) => {
      strictEqual(record.network_passphrase, networkPassphrase(NETWORK));
      strictEqual(record.contract_id, UPTO_TESTNET_DEPLOYMENT.address, "contract id");
      strictEqual(record.wasm_sha256, UPTO_TESTNET_DEPLOYMENT.wasmHash, "WASM hash");
      context.observe("contractId", record.contract_id);
      context.observe("wasmSha256", record.wasm_sha256);
      context.observe("sourceRevision", record.commit);
      context.observe("source", record.source);
      context.observe("sourceSha256", record.source_sha256);
      context.observe("buildImage", record.bldimg);
      context.observe("deployTransactions", {
        upload: { ...record.transactions.upload, explorer: explorerUrl(record.transactions.upload.tx) },
        deploy: { ...record.transactions.deploy, explorer: explorerUrl(record.transactions.deploy.tx) },
      });
      return Promise.resolve();
    },
  );

  await recorder.run(
    {
      id: "on-chain",
      title: "the contract instance on chain runs the recorded WASM, and its instance and code are live",
      checks: ["scheme-upto"],
      scheme: "upto",
    },
    async (context) => {
      const reading = await readContractTtl(server, [record.contract_id]);
      const instance = reading.contracts.get(record.contract_id);
      ok(instance !== undefined, "the contract instance is live");
      strictEqual(instance.wasmHash, record.wasm_sha256, "the instance runs the recorded WASM");
      ok(instance.instanceLiveUntil > reading.latestLedger, "the instance is live");
      ok((instance.codeLiveUntil ?? 0) > reading.latestLedger, "the code is live");
      context.observe("latestLedger", reading.latestLedger);
      context.observe("instanceTtlLedgers", instance.instanceLiveUntil - reading.latestLedger);
      context.observe("codeTtlLedgers", (instance.codeLiveUntil ?? 0) - reading.latestLedger);
    },
  );

  await recorder.run(
    {
      id: "contract-fetch",
      title: "the WASM `stellar contract fetch` downloads from the contract hashes to the recorded WASM hash",
      checks: ["scheme-upto"],
      scheme: "upto",
    },
    (context) => {
      const fetched = fetchWasmHash(record.contract_id, TESTNET_RPC_URL, record.network_passphrase);
      strictEqual(fetched, record.wasm_sha256, "the fetched WASM");
      context.observe("fetchedSha256", fetched);
      context.observe("stellarCli", stellarVersion());
      return Promise.resolve();
    },
  );

  const rebuild = {
    id: "reproducible-build",
    title:
      "rebuilding the recorded source revision in the pinned build image reproduces the deployed WASM byte for byte",
    checks: ["scheme-upto"] as const,
    scheme: "upto" as const,
  };
  if (args["no-rebuild"]) {
    recorder.skip({ ...rebuild, checks: [...rebuild.checks] }, "--no-rebuild was given");
  } else {
    await recorder.run({ ...rebuild, checks: [...rebuild.checks] }, (context) => {
      const run = spawnSync("bash", [join(ROOT, "scripts/contracts/verify.sh"), "--network", "testnet"], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      const line = (name: string) => new RegExp(`^${name}\\s+([0-9a-f]{64})$`, "m").exec(run.stdout)?.[1];
      context.observe("rebuiltSha256", line("rebuilt"));
      context.observe("deployedSha256", line("deployed"));
      context.observe("command", "scripts/contracts/verify.sh --network testnet");
      strictEqual(run.status, 0, `verify.sh failed: ${run.stderr.trim().split("\n").slice(-3).join(" ")}`);
      strictEqual(line("rebuilt"), record.wasm_sha256, "the rebuilt WASM");
      strictEqual(line("deployed"), record.wasm_sha256, "the deployed WASM");
      return Promise.resolve();
    });
  }

  if (args.facilitator === undefined) {
    recorder.skip(
      {
        id: "facilitator-contract",
        title: "the facilitator settles upto through this contract",
        checks: ["scheme-upto"],
        scheme: "upto",
      },
      "no --facilitator was given",
    );
  } else {
    await recorder.run(
      {
        id: "facilitator-contract",
        title: "the facilitator settles upto through this contract",
        checks: ["scheme-upto"],
        scheme: "upto",
      },
      async (context) => {
        const health = (await (await fetch(`${target.facilitatorUrl}/health`)).json()) as {
          networks?: Partial<Record<string, { upto?: { contract?: string } }>>;
        };
        const upto = health.networks?.[NETWORK]?.upto;
        strictEqual(upto?.contract, record.contract_id, "/health names it");
        context.observe("health", upto);
      },
    );
  }

  await recorder.run(
    {
      id: "test6",
      title: "the TEST6 test token on chain runs the recorded WASM, is live and answers decimals() = 6",
      checks: ["second-asset"],
      asset: "TEST6",
    },
    async (context) => {
      const checked = await checkTest6OnChain(server, test6);
      const fetched = fetchWasmHash(test6.contract_id, TESTNET_RPC_URL, test6.network_passphrase);
      strictEqual(fetched, test6.wasm_sha256, "the fetched WASM");
      deepStrictEqual(test6.constructor, { name: test6.constructor.name, symbol: "TEST6", decimals: 6 });
      context.observe("contractId", test6.contract_id);
      context.observe("wasmSha256", test6.wasm_sha256);
      context.observe("fetchedSha256", fetched);
      context.observe("sourceRevision", test6.commit);
      context.observe("instanceTtlLedgers", checked.instanceLiveUntil - checked.latestLedger);
      context.observe("deploy", {
        ...test6.transactions.deploy,
        explorer: explorerUrl(test6.transactions.deploy.tx),
      });
    },
  );

  const evidence = buildEvidence(
    {
      kind: "upto-contract",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      packages: versions(["@stellar/stellar-sdk", "@rail402.dev/upto"]),
      command:
        "node --conditions=@rail402/source tools/conformance/src/upto-contract.ts" +
        (args.facilitator === undefined ? "" : ` --facilitator ${target.facilitatorUrl}`) +
        (args["no-rebuild"] ? " --no-rebuild" : ""),
      config: { rpcUrl: TESTNET_RPC_URL, stellarCli: stellarVersion(), rebuild: !args["no-rebuild"] },
      accounts: { upto: record.contract_id, test6: test6.contract_id },
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
  if (recorder.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
