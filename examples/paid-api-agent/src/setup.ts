/**
 * One-shot testnet setup for the demo: creates a facilitator, seller and buyer, issues a test
 * SEP-41 asset, deploys its contract, establishes trustlines and funds the buyer.
 *
 * Uses a self-issued asset and friendbot so the example runs with no faucet, no captcha and no
 * real value — a developer can go from clone to a settled payment without asking anyone for tokens.
 *
 * Prints shell-ready exports on stdout; progress goes to stderr.
 */
import {
  Keypair, TransactionBuilder, Networks, Operation, Asset, Horizon, rpc,
} from "@stellar/stellar-sdk";

const PASS = Networks.TESTNET;
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const note = (...a: unknown[]) => console.error("[setup] ", ...a);

const fund = async (kp: Keypair) =>
  (await fetch(`https://horizon-testnet.stellar.org/friendbot?addr=${kp.publicKey()}`)).ok;

async function submit(kp: Keypair, build: (b: TransactionBuilder) => void) {
  const acct = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASS });
  build(b);
  const tx = b.setTimeout(60).build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}

const issuer = Keypair.random();
const seller = Keypair.random();
const buyer = Keypair.random();
const facilitator = Keypair.random();

note("funding four testnet accounts via friendbot");
await Promise.all([fund(issuer), fund(seller), fund(buyer), fund(facilitator)]);

const ASSET = new Asset("DEMO", issuer.publicKey());
const SAC = ASSET.contractId(PASS);

// A classic asset's Stellar Asset Contract must be instantiated before it can be invoked;
// without this every transfer fails with Error(Storage, MissingValue).
note("deploying the asset contract", SAC);
{
  const acct = await server.getAccount(issuer.publicKey());
  const tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASS })
    .addOperation(Operation.createStellarAssetContract({ asset: ASSET }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`SAC deploy simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  prepared.sign(issuer);
  const sent = await server.sendTransaction(prepared);
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const got = await server.getTransaction(sent.hash).catch(() => null);
    if (got?.status === "SUCCESS") ok = true;
    if (got?.status === "FAILED") throw new Error("SAC deploy failed on-ledger");
  }
  if (!ok) throw new Error("SAC deploy timed out");
}

// Both sides need a trustline before they can hold the asset. The seller's is easy to forget and
// is exactly the failure our facilitator reports as a seller-side misconfiguration.
note("establishing trustlines for buyer and seller");
await submit(buyer, b => b.addOperation(Operation.changeTrust({ asset: ASSET })));
await submit(seller, b => b.addOperation(Operation.changeTrust({ asset: ASSET })));

note("funding the buyer with 100 DEMO");
await submit(issuer, b =>
  b.addOperation(Operation.payment({ destination: buyer.publicKey(), asset: ASSET, amount: "100" })),
);

note("ready");
console.log(`export FACILITATOR_STELLAR_SECRET=${facilitator.secret()}`);
console.log(`export CLIENT_STELLAR_PRIVATE_KEY=${buyer.secret()}`);
console.log(`export SELLER_ADDRESS=${seller.publicKey()}`);
console.log(`export PAYMENT_ASSET=${SAC}`);
console.log(`export DEMO_BUYER=${buyer.publicKey()}`);
console.log(`export DEMO_ISSUER=${issuer.publicKey()}`);
