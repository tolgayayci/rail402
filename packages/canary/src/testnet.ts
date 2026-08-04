import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { X402Error } from "@x402-stellar/errors";

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
  const response = await fetch(`${HORIZON_URL}/friendbot?addr=${kp.publicKey()}`);
  if (!response.ok) {
    throw setupFailure(
      `Friendbot refused to fund ${kp.publicKey()} (HTTP ${response.status}). Testnet funding is unavailable, so this run proves nothing about the facilitator.`,
      { account: kp.publicKey(), status: response.status },
    );
  }
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
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    const got = await server.getTransaction(hash).catch(() => null);
    if (got?.status === "SUCCESS") return;
    if (got?.status === "FAILED") {
      throw setupFailure(`Setup transaction ${hash} failed on-ledger.`, { hash });
    }
  }
  throw setupFailure(`Setup transaction ${hash} did not confirm within 30 seconds.`, { hash });
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

  await Promise.all([friendbotFund(issuer), friendbotFund(buyer), friendbotFund(seller)]);

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
