/**
 * The `TEST6` test token on the public testnet: its committed deployment record, checked against the
 * address tests import (`TEST6_TESTNET`) and against the chain. Runs that pay in `TEST6` read the token
 * from here, so they use exactly the deployed contract the record describes.
 */
import { readFileSync } from "node:fs";
import { AssetDirectory, networkPassphrase, readContractTtl } from "@rail402.dev/stellar";
import { TEST6_TESTNET, type LocalNetwork } from "@rail402.dev/testkit";
import {
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  type Keypair,
  type rpc,
} from "@stellar/stellar-sdk";
import { z } from "zod";

/** `contracts/testing/deployments/test6-testnet.json` in this repository. */
export const TEST6_RECORD_PATH = new URL(
  "../../../contracts/testing/deployments/test6-testnet.json",
  import.meta.url,
);

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const transaction = z.object({ tx: hex64, ledger: z.number().int().positive() });

/** The fields of the deployment record a run relies on; other fields are kept but not checked. */
export const test6RecordSchema = z.looseObject({
  contract: z.literal("test-token"),
  caip2: z.literal("stellar:testnet"),
  network_passphrase: z.string(),
  contract_id: z.string().regex(/^C[A-Z2-7]{55}$/),
  constructor: z.object({
    name: z.string().min(1),
    symbol: z.literal("TEST6"),
    decimals: z.literal(6),
  }),
  wasm_sha256: hex64,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  transactions: z.looseObject({ upload: transaction, deploy: transaction }),
});

export type Test6Record = z.infer<typeof test6RecordSchema>;

/** A token as a conformance run uses it. */
export interface RunAsset {
  readonly contract: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Where its facts come from, recorded in evidence. */
  readonly record?: { readonly deployTx: string; readonly wasmSha256: string; readonly commit: string };
}

/**
 * Parses the committed record and checks it against `TEST6_TESTNET` (address, decimals, WASM hash)
 * and against the testnet passphrase. Throws on any difference.
 */
export function readTest6Record(path: URL | string = TEST6_RECORD_PATH): Test6Record {
  const record = test6RecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const mismatches = [
    record.network_passphrase === networkPassphrase("stellar:testnet") ? undefined : "network_passphrase",
    record.contract_id === TEST6_TESTNET.address ? undefined : "contract_id",
    record.constructor.decimals === TEST6_TESTNET.decimals ? undefined : "decimals",
    record.wasm_sha256 === TEST6_TESTNET.wasmHash ? undefined : "wasm_sha256",
  ].filter((field) => field !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`the TEST6 record disagrees with TEST6_TESTNET on ${mismatches.join(", ")}`);
  }
  return record;
}

/** `TEST6` as a run asset, from the checked record. */
export function test6Asset(record: Test6Record = readTest6Record()): RunAsset {
  return {
    contract: record.contract_id,
    symbol: record.constructor.symbol,
    decimals: record.constructor.decimals,
    record: {
      deployTx: record.transactions.deploy.tx,
      wasmSha256: record.wasm_sha256,
      commit: record.commit,
    },
  };
}

/**
 * Checks the deployed contract against the record, read-only: its instance is live, it runs the
 * recorded WASM, and `decimals()` answers 6. Throws on any difference, before a run spends funds.
 */
export async function checkTest6OnChain(
  server: rpc.Server,
  record: Test6Record = readTest6Record(),
): Promise<{ readonly instanceLiveUntil: number; readonly latestLedger: number }> {
  const reading = await readContractTtl(server, [record.contract_id]);
  const instance = reading.contracts.get(record.contract_id);
  if (instance === undefined) throw new Error(`TEST6 ${record.contract_id} is not live on testnet`);
  if (instance.wasmHash !== record.wasm_sha256) {
    throw new Error(`TEST6 runs WASM ${instance.wasmHash ?? "none"}, the record says ${record.wasm_sha256}`);
  }
  const token = await new AssetDirectory(server, record.network_passphrase).inspect(record.contract_id);
  if (!token.found || token.decimals !== record.constructor.decimals) {
    throw new Error(`TEST6 does not answer decimals() = ${String(record.constructor.decimals)}`);
  }
  return { instanceLiveUntil: instance.instanceLiveUntil, latestLedger: reading.latestLedger };
}

/** Mints 100 TEST6 to `to` (G… or C…) from the open faucet; `source` only pays the fee. */
export async function test6Faucet(
  net: LocalNetwork,
  source: Keypair,
  to: string,
  record: Test6Record = readTest6Record(),
): Promise<void> {
  const account = await net.server.getAccount(source.publicKey());
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(new Contract(record.contract_id).call("faucet", nativeToScVal(to, { type: "address" })))
    .setTimeout(60)
    .build();
  const prepared = await net.server.prepareTransaction(transaction);
  prepared.sign(source);
  await net.submit(prepared);
}
