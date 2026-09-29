/**
 * Runs the upstream x402 e2e suite against Rail402 on the Stellar testnet: every stock TypeScript
 * client and server in the suite pays through Rail402, then the suite checks Rail402's Bazaar.
 *
 *   node tools/conformance/src/upstream-e2e.ts --x402 ../x402 [--write]
 *
 * `--x402` is a checkout of x402-foundation/x402 at the tag of the @x402/stellar version Rail402
 * depends on, prepared as its e2e README describes: `pnpm install` in e2e/, the TypeScript
 * packages built, and `./setup.sh` run so components such as the Next.js server are built.
 * Rail402 joins the suite as an external facilitator (tools/conformance/upstream-e2e/), which the
 * suite supports without modification. The sponsor, buyer and seller are fresh Friendbot-funded
 * testnet accounts, so the run needs no secrets.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";

const { values: args } = parseArgs({
  options: {
    x402: { type: "string" },
    write: { type: "boolean", default: false },
  },
});

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const SUITE_ARGS = ["--testnet", "--families=stellar", "--facilitators=rail402", "--extensions=bazaar"];

const root = fileURLToPath(new URL("../../../", import.meta.url));
const horizon = new Horizon.Server(HORIZON_URL);
const log = (message: string) => {
  process.stderr.write(`${new Date().toISOString()}  ${message}\n`);
};

interface SuiteResult {
  readonly client: string;
  readonly server: string;
  readonly endpoint: string;
  readonly transport: string;
  readonly paymentFlow: string;
  readonly passed: boolean;
  readonly error?: string;
  readonly transaction?: string;
}

async function main() {
  if (args.x402 === undefined) throw new Error("--x402 <path to an x402 checkout> is required");
  const x402 = resolve(args.x402);
  const e2e = join(x402, "e2e");
  if (USDC.contractId(Networks.TESTNET) !== USDC_TESTNET_ADDRESS)
    throw new Error("USDC issuer/contract mismatch");

  const pinned = readVersion(join(root, "tools/conformance/node_modules/@x402/stellar/package.json"));
  const upstream = readVersion(join(x402, "typescript/packages/mechanisms/stellar/package.json"));
  if (upstream !== pinned) {
    throw new Error(`the x402 checkout has @x402/stellar ${upstream}; Rail402 depends on ${pinned}`);
  }

  const proxy = join(e2e, "facilitators/external-proxies/rail402");
  mkdirSync(proxy, { recursive: true });
  for (const name of ["test.config.json", "run.sh"]) {
    copyFileSync(join(root, "tools/conformance/upstream-e2e", name), join(proxy, name));
  }
  chmodSync(join(proxy, "run.sh"), 0o755);

  const sponsor = Keypair.random();
  const buyer = Keypair.random();
  const seller = Keypair.random();
  log(`funding sponsor ${sponsor.publicKey()}, buyer ${buyer.publicKey()}, seller ${seller.publicKey()}`);
  await Promise.all([fund(sponsor), fund(buyer), fund(seller)]);
  await classic(seller, [Operation.changeTrust({ asset: USDC })]);
  await classic(buyer, [
    Operation.changeTrust({ asset: USDC }),
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: "100",
      destination: buyer.publicKey(),
      destAsset: USDC,
      destAmount: "1",
      path: [],
    }),
  ]);
  log("buyer holds 1 USDC; seller has a USDC trustline");

  const resultsFile = join(mkdtempSync(join(tmpdir(), "rail402-e2e-")), "results.json");
  const command = ["pnpm", "test", ...SUITE_ARGS, `--output-json=${resultsFile}`];
  log(`running ${command.join(" ")} in ${e2e}`);
  const { code, output } = await run(command, e2e, {
    RAIL402_ROOT: root,
    FACILITATOR_STELLAR_PRIVATE_KEY: sponsor.secret(),
    CLIENT_STELLAR_PRIVATE_KEY: buyer.secret(),
    SERVER_STELLAR_ADDRESS: seller.publicKey(),
  });

  const report = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    summary: { total: number; passed: number; failed: number; durationMinutes: number };
    results: SuiteResult[];
  };
  const discovery = /Discovery Validation: (PASSED|FAILED)/.exec(output)?.[1] ?? "NOT RUN";
  const evidence = {
    run: new Date().toISOString(),
    command: `pnpm test ${SUITE_ARGS.join(" ")}`,
    exitCode: code,
    upstream: {
      repository: "x402-foundation/x402",
      commit: git(x402, "rev-parse", "HEAD"),
      version: upstream,
    },
    rail402: {
      commit: git(root, "rev-parse", "HEAD"),
      uncommittedChanges: git(root, "status", "--porcelain", "--untracked-files=no") !== "",
    },
    network: "stellar:testnet",
    accounts: { sponsor: sponsor.publicKey(), buyer: buyer.publicKey(), seller: seller.publicKey() },
    summary: report.summary,
    bazaarDiscoveryValidation: discovery,
    results: report.results.map((result) => ({
      client: result.client,
      server: result.server,
      endpoint: result.endpoint,
      transport: result.transport,
      paymentFlow: result.paymentFlow,
      passed: result.passed,
      ...(result.transaction === undefined ? {} : { transaction: result.transaction }),
      ...(result.error === undefined ? {} : { error: result.error }),
    })),
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(json);
  if (args.write) {
    const directory = join(root, "tools/conformance/evidence");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "upstream-e2e-stellar-testnet.json"), json);
    log("evidence written to tools/conformance/evidence/upstream-e2e-stellar-testnet.json");
  }
  if (code !== 0 || discovery !== "PASSED" || report.summary.total === 0) process.exitCode = 1;
}

/** Runs a command, echoing its output to stderr and returning it (the suite logs to both streams). */
function run(command: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ code: number; output: string }>((done, fail) => {
    const [file = "", ...rest] = command;
    const child = spawn(file, rest, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", fail);
    child.on("close", (code) => {
      done({ code: code ?? 1, output });
    });
  });
}

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

function git(cwd: string, ...rest: string[]): string {
  return execFileSync("git", rest, { cwd, encoding: "utf8" }).trim();
}

async function fund(account: Keypair) {
  const response = await fetch(`${FRIENDBOT_URL}?addr=${account.publicKey()}`);
  if (!response.ok) throw new Error(`friendbot: HTTP ${String(response.status)}`);
}

async function classic(source: Keypair, operations: ReturnType<typeof Operation.changeTrust>[]) {
  const account = await horizon.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 10),
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);
  for (const operation of operations) builder.addOperation(operation);
  const transaction = builder.build();
  transaction.sign(source);
  await horizon.submitTransaction(transaction);
}

await main();
