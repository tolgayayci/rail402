import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { X402Error } from "@rail402/errors";

/**
 * Throwaway testnet fixtures for a canary run.
 *
 * The canary issues its **own** SEP-41 asset and funds every account from friendbot, so a nightly
 * run needs no faucet, no captcha, no secret, and touches nothing of value. That is not a
 * convenience: a monitoring check that depends on a funded account somebody has to top up is a
 * check that eventually stops running, and a check that stops running is worse than no check
 * because the badge it produced stays green.
 *
 * Testnet only, by construction — the passphrase and both endpoints are constants in this file.
 */

export const NETWORK = "stellar:testnet";
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";

/** Generous ceiling for the classic setup transactions; these are not the path under test. */
const SETUP_FEE = "1000000";

export interface Fixtures {
  readonly issuer: Keypair;
  readonly buyer: Keypair;
  readonly seller: Keypair;
  /** Contract address of the issued asset's SAC — this is what `accepts.asset` names. */
  readonly assetContractId: string;
  readonly assetCode: string;
}

const server = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

const setupFailure = (reason: string, details?: Record<string, unknown>): X402Error =>
  new X402Error("canary_setup_failed", {
    reason,
    ...(details === undefined ? {} : { details }),
  });

export async function friendbotFund(kp: Keypair): Promise<void> {
  // Testnet friendbot is intermittently unavailable (observed 200, a 307 redirect, and 500 within the
  // same minute), so one call is not a reliable fund. Retry with backoff before declaring testnet
  // funding down. Pure setup robustness — it changes nothing about what the facilitator is measured on.
  let lastStatus = 0;
  let funded = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(2500);
    const response = await fetch(`${HORIZON_URL}/friendbot?addr=${kp.publicKey()}`).catch(() => null);
    if (response?.ok || response?.status === 400) {
      funded = true; // 400 is friendbot's "account already exists" — funded is funded.
      break;
    }
    lastStatus = response?.status ?? 0;
  }
  if (!funded) {
    throw setupFailure(
      `Friendbot could not fund ${kp.publicKey()} after 8 attempts (last HTTP ${lastStatus}). Testnet funding is unavailable right now, so this run proves nothing about the facilitator.`,
      { account: kp.publicKey(), status: lastStatus },
    );
  }
  // Friendbot funds via Horizon, but the Soroban RPC indexes accounts separately and lags — more so
  // now that friendbot 307-redirects and takes several seconds. The next setup step calls
  // `server.getAccount`, so wait until the funded account is actually visible on the RPC rather than
  // racing it. Racing it is exactly the "Account not found" that aborts a run in its own setup,
  // before it ever reaches the facilitator.
  for (let attempt = 0; attempt < 25; attempt++) {
    const visible = await server
      .getAccount(kp.publicKey())
      .then(() => true)
      .catch(() => false);
    if (visible) return;
    await sleep(1000);
  }
  throw setupFailure(
    `Friendbot accepted funding for ${kp.publicKey()} but it never appeared on the Soroban RPC (testnet indexing lag).`,
    { account: kp.publicKey() },
  );
}

/** Submit a signed classic transaction. Exported so canaries can move ledger state deliberately. */
export async function submitClassic(
  kp: Keypair,
  build: (b: TransactionBuilder) => void,
): Promise<void> {
  const account = await horizon.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: SETUP_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  build(builder);
  const tx = builder.setTimeout(60).build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

async function awaitTransaction(hash: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(1000);
    const got = await server.getTransaction(hash).catch(() => null);
    if (got?.status === "SUCCESS") return;
    if (got?.status === "FAILED") {
      throw setupFailure(`Setup transaction ${hash} failed on-ledger.`, { hash });
    }
  }
  throw setupFailure(`Setup transaction ${hash} did not confirm within 60 seconds.`, { hash });
}

/**
 * Instantiate a classic asset's Stellar Asset Contract.
 *
 * Skipping this is a silent trap: every subsequent `transfer` fails with
 * `Error(Storage, MissingValue)`, which reads like a facilitator bug rather than a missing deploy.
 */
async function deployAssetContract(issuer: Keypair, asset: Asset): Promise<void> {
  const account = await server.getAccount(issuer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: SETUP_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw setupFailure(`Simulating the asset-contract deploy failed: ${simulation.error}`);
  }
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(issuer);
  const sent = await server.sendTransaction(prepared);
  await awaitTransaction(sent.hash);
}

/**
 * Create an issuer, a buyer and a seller; issue an asset; establish both trustlines; fund the buyer.
 *
 * The seller's trustline is the one people forget, and its absence is exactly the seller-side
 * misconfiguration the facilitator reports as its own error code — so establishing it here keeps
 * the canary measuring discovery rather than rediscovering that.
 *
 * @param assetCode - 1–12 character asset code, unique per run so runs never share ledger state
 */
export async function prepareFixtures(assetCode: string): Promise<Fixtures> {
  const issuer = Keypair.random();
  const buyer = Keypair.random();
  const seller = Keypair.random();

  // Sequential, not concurrent: three simultaneous friendbot calls are what tip an already-flaky
  // testnet friendbot into 429/500. One at a time is slower but far likelier to complete.
  await friendbotFund(issuer);
  await friendbotFund(buyer);
  await friendbotFund(seller);

  const asset = new Asset(assetCode, issuer.publicKey());
  await deployAssetContract(issuer, asset);

  await submitClassic(buyer, b => b.addOperation(Operation.changeTrust({ asset })));
  await submitClassic(seller, b => b.addOperation(Operation.changeTrust({ asset })));
  await submitClassic(issuer, b =>
    b.addOperation(Operation.payment({ destination: buyer.publicKey(), asset, amount: "100" })),
  );

  return {
    issuer,
    buyer,
    seller,
    assetContractId: asset.contractId(NETWORK_PASSPHRASE),
    assetCode,
  };
}

/** Friendbot-fund a fresh keypair for use as a facilitator settlement signer. */
export async function fundedSigner(): Promise<Keypair> {
  const kp = Keypair.random();
  await friendbotFund(kp);
  return kp;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
