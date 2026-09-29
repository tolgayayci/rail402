/**
 * Canonical-client conformance run: an unmodified x402 buyer pays an unmodified x402 seller whose
 * facilitator is Rail402, on the Stellar testnet, in Circle USDC.
 *
 *   node tools/conformance/src/canonical-exact.ts --facilitator http://localhost:8080 [--write]
 *
 * Buyer: @x402/fetch + @x402/stellar's stock ExactStellarScheme client, default spend controls.
 * Seller: @x402/express paymentMiddleware + x402ResourceServer + HTTPFacilitatorClient({ url }).
 * Nothing here patches, wraps or reconfigures the x402 packages beyond their documented options.
 * The script creates and funds fresh testnet accounts, so it needs no secrets.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import express from "express";
import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClient } from "@x402/stellar/exact/client";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    price: { type: "string", default: "$0.01" },
    write: { type: "boolean", default: false },
  },
});

const NETWORK = "stellar:testnet";
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
// Circle's testnet USDC issuer; its Stellar Asset Contract is USDC_TESTNET_ADDRESS.
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);
const log = (message: string) => {
  process.stderr.write(`${new Date().toISOString()}  ${message}\n`);
};

async function main() {
  if (USDC.contractId(Networks.TESTNET) !== USDC_TESTNET_ADDRESS)
    throw new Error("USDC issuer/contract mismatch");

  const buyer = Keypair.random();
  const seller = Keypair.random();
  log(`funding buyer ${buyer.publicKey()} and seller ${seller.publicKey()} with Friendbot`);
  await Promise.all([fund(buyer), fund(seller)]);
  await classic(seller, [Operation.changeTrust({ asset: USDC })]);
  log("buyer: USDC trustline and 1 USDC bought from the testnet XLM/USDC pool");
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

  // --- seller: stock @x402/express middleware pointed at the facilitator under test -----------
  const facilitator = new HTTPFacilitatorClient({ url: args.facilitator });
  const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactStellarServer());
  const app = express();
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: { scheme: "exact", price: args.price, network: NETWORK, payTo: seller.publicKey() },
          description: "Weather report",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );
  app.get("/weather", (_req, res) => {
    res.json({ report: { weather: "sunny", temperature: 21 } });
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const resourceUrl = `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}/weather`;

  // --- buyer: stock @x402/fetch with the stock Stellar client scheme -------------------------
  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: NETWORK, client: new ExactStellarClient(createEd25519Signer(buyer.secret(), NETWORK)) },
    ],
  });

  const before = {
    buyer: await usdcBalance(buyer.publicKey()),
    seller: await usdcBalance(seller.publicKey()),
  };
  log(`buyer requests ${resourceUrl} (facilitator ${args.facilitator})`);
  const started = performance.now();
  const response = await fetchWithPayment(resourceUrl);
  const elapsedMs = Math.round(performance.now() - started);
  const body: unknown = await response.json();
  listener.close();

  const header = response.headers.get("PAYMENT-RESPONSE");
  if (response.status !== 200 || header === null) {
    throw new Error(`paid request failed: HTTP ${String(response.status)} ${JSON.stringify(body)}`);
  }
  const settlement = decodePaymentResponseHeader(header);
  if (!settlement.success) throw new Error(`settlement failed: ${JSON.stringify(settlement)}`);

  const onChain = await server.getTransaction(settlement.transaction);
  if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${settlement.transaction} is ${onChain.status}`);
  }
  const after = {
    buyer: await usdcBalance(buyer.publicKey()),
    seller: await usdcBalance(seller.publicKey()),
  };
  const paid = before.buyer - after.buyer;
  if (paid <= 0n || after.seller - before.seller !== paid) {
    throw new Error(
      `balances do not reconcile: buyer paid ${String(paid)}, seller received ${String(after.seller - before.seller)}`,
    );
  }

  const health = await fetch(new URL("health", `${args.facilitator.replace(/\/+$/, "")}/`)).catch(
    () => undefined,
  );
  const deployed = health?.ok === true ? ((await health.json()) as { version?: string }).version : undefined;
  const evidence = {
    run: "canonical-exact",
    date: new Date().toISOString(),
    network: NETWORK,
    facilitator: args.facilitator,
    facilitatorVersion: deployed ?? "not reported",
    rail402Commit: gitCommit(),
    packages: versions([
      "@x402/core",
      "@x402/fetch",
      "@x402/express",
      "@x402/stellar",
      "@stellar/stellar-sdk",
    ]),
    command: `node tools/conformance/src/canonical-exact.ts --facilitator ${args.facilitator}`,
    request: { url: "GET /weather", price: args.price, status: response.status, elapsedMs },
    settlement: {
      transaction: settlement.transaction,
      ledger: onChain.ledger,
      payer: settlement.payer,
      payTo: seller.publicKey(),
      asset: USDC_TESTNET_ADDRESS,
      amount: paid.toString(),
      feeChargedStroops: onChain.resultXdr.feeCharged().toString(),
      explorer: `https://stellar.expert/explorer/testnet/tx/${settlement.transaction}`,
    },
    balances: {
      buyer: { before: before.buyer.toString(), after: after.buyer.toString() },
      seller: { before: before.seller.toString(), after: after.seller.toString() },
    },
  };

  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(output);
  if (args.write) {
    const directory = new URL("../evidence/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL("canonical-exact-stellar-testnet.json", directory), output);
    log("evidence written to tools/conformance/evidence/canonical-exact-stellar-testnet.json");
  }
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

async function usdcBalance(address: string): Promise<bigint> {
  const call = new Contract(USDC_TESTNET_ADDRESS).call(
    "balance",
    nativeToScVal(address, { type: "address" }),
  );
  const account = await server.getAccount(address);
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(call)
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) {
    throw new Error(`balance of ${address} could not be read`);
  }
  return scValToNative(simulation.result.retval) as bigint;
}

function versions(names: string[]): Record<string, string> {
  const require = createRequire(import.meta.url);
  const result: Record<string, string> = {};
  for (const name of names) {
    const entry = require.resolve(name);
    const root = entry.slice(
      0,
      entry.lastIndexOf(`/node_modules/${name}/`) + `/node_modules/${name}/`.length,
    );
    result[name] = (JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string }).version;
  }
  return result;
}

function gitCommit(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "unknown";
  }
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
