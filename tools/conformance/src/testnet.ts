/**
 * Shared fixtures for runs against the public Stellar testnet: a Friendbot-funded treasury that buys
 * Circle USDC from the testnet XLM/USDC pool and hands it to fresh accounts, plus the provenance
 * every evidence file records.
 */
import { execFileSync } from "node:child_process";
import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { requirementsFor, type LocalNetwork } from "@rail402.dev/testkit";

export const NETWORK = "stellar:testnet";
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_FRIENDBOT_URL = "https://friendbot.stellar.org";
// Circle's testnet USDC issuer; its Stellar Asset Contract is USDC_TESTNET_ADDRESS.
export const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
export { USDC_TESTNET_ADDRESS };

export const log = (message: string) => {
  process.stderr.write(`${new Date().toISOString()}  ${message}\n`);
};

/** An account a run keeps across reruns, and how it was obtained. */
export interface OperatorAccount {
  readonly keypair: Keypair;
  /** `derived` from the operator's sponsor seed, or `fresh` when no seed was given. */
  readonly origin: "derived" | "fresh";
}

/**
 * A testnet account that stays the same across an operator's runs and that only the operator can sign
 * for: derived with HKDF from the fee sponsor's seed in the file `RAIL402_SPONSOR_SECRET_FILE` names
 * (the evidence run's sponsor) and `label`, as the service derives its channels. Without that file it
 * is a fresh random account. The seed is read from the file only, never from an argument.
 */
export function operatorAccount(
  label: string,
  secretFile = process.env["RAIL402_SPONSOR_SECRET_FILE"],
): OperatorAccount {
  if (secretFile === undefined || secretFile === "") return { keypair: Keypair.random(), origin: "fresh" };
  const sponsor = Keypair.fromSecret(readFileSync(secretFile, "utf8").trim());
  const seed = hkdfSync("sha256", sponsor.rawSecretKey(), "rail402 conformance account", label, 32);
  return { keypair: Keypair.fromRawEd25519Seed(Buffer.from(seed)), origin: "derived" };
}

export class Treasury {
  readonly net: LocalNetwork;
  readonly keypair = Keypair.random();

  constructor(net: LocalNetwork) {
    this.net = net;
  }

  /** Funds the treasury with Friendbot and buys `usdc` USDC from the testnet XLM/USDC pool. */
  async open(usdc: string): Promise<this> {
    await this.net.fund(this.keypair);
    await this.net.classic(this.keypair, [
      Operation.changeTrust({ asset: USDC }),
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "5000",
        destination: this.keypair.publicKey(),
        destAsset: USDC,
        destAmount: usdc,
        path: [],
      }),
    ]);
    return this;
  }

  /**
   * New accounts with 5 XLM; with a USDC trustline and `usdc` USDC unless `trust` is false. A
   * transaction carries at most 20 signatures, so trustlines are opened 19 accounts at a time.
   */
  async accounts(count: number, usdc: string, trust = true): Promise<Keypair[]> {
    const created = Array.from({ length: count }, () => Keypair.random());
    for (let start = 0; start < created.length; start += 19) {
      const batch = created.slice(start, start + 19);
      await this.net.classic(
        this.keypair,
        batch.map((account) =>
          Operation.createAccount({ destination: account.publicKey(), startingBalance: "5" }),
        ),
      );
      if (!trust) continue;
      await this.net.classic(
        this.keypair,
        batch.map((account) => Operation.changeTrust({ asset: USDC, source: account.publicKey() })),
        batch,
      );
      if (usdc !== "0") {
        await this.net.classic(
          this.keypair,
          batch.map((account) =>
            Operation.payment({ destination: account.publicKey(), asset: USDC, amount: usdc }),
          ),
        );
      }
    }
    return created;
  }

  /**
   * Makes `account` a funded testnet account with a USDC trustline, creating it when it does not
   * exist, so a fixed account can be reused across runs.
   */
  async adopt(account: Keypair): Promise<Keypair> {
    try {
      await this.net.server.getAccount(account.publicKey());
    } catch {
      await this.net.classic(this.keypair, [
        Operation.createAccount({ destination: account.publicKey(), startingBalance: "5" }),
      ]);
    }
    await this.net.classic(
      this.keypair,
      [Operation.changeTrust({ asset: USDC, source: account.publicKey() })],
      [account],
    );
    return account;
  }

  /** Moves USDC from the treasury to any address (G… or C…) through the asset contract. */
  async transfer(to: string, amount: bigint): Promise<void> {
    const account = await this.net.server.getAccount(this.keypair.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.net.passphrase,
    })
      .addOperation(
        new Contract(USDC_TESTNET_ADDRESS).call(
          "transfer",
          nativeToScVal(this.keypair.publicKey(), { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(amount, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await this.net.server.prepareTransaction(transaction);
    prepared.sign(this.keypair);
    await this.net.submit(prepared);
  }
}

/** A signed exact payment in USDC, built the way the stock client builds it. */
export async function usdcPayment(
  net: LocalNetwork,
  payer: Keypair,
  payTo: string,
  amount: bigint,
  expirationLedger?: number,
) {
  const requirements = requirementsFor(USDC_TESTNET_ADDRESS, payTo, amount);
  const payload = await net.payment(
    payer,
    requirements,
    expirationLedger === undefined ? {} : { expirationLedger },
  );
  return { payload, requirements };
}

export function versions(names: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of names) {
    // The package as this tool resolves it: its own dependency link, which for a workspace package
    // points at the package's source directory.
    const manifest = new URL(`../node_modules/${name}/package.json`, import.meta.url);
    found[name] = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  }
  return found;
}

export function gitCommit(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "unknown";
  }
}
