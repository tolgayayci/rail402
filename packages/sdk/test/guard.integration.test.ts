/**
 * The signing guard and budget reconciliation against the private Stellar network
 * (docker compose --profile stellar up -d): real simulation, real authorization preimages from
 * @stellar/stellar-sdk, a real settlement and real transfer events.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  contract,
  nativeToScVal,
  rpc,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import { AssetDirectory, LatestLedger, TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, type IssuedAsset } from "@rail402.dev/testkit";
import {
  KeyHolder,
  MemorySpendLedger,
  checkGuardedPayload,
  createGuardedSigner,
  exactScheme,
  reconcile,
  resolvePolicy,
  rpcChainReader,
  windowSpecFor,
  type ReconcileOptions,
  type ResolvedPolicy,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";

const net = new LocalNetwork();
const available = await net.available();

/**
 * The upstream exact client's steps (exact/client/scheme.ts) with `allowHttp`, which the stock client
 * cannot set for a plain-HTTP RPC. The signer's `signAuthEntry` is passed unbound, as upstream does.
 */
function localExactClient(signer: ClientStellarSigner): SchemeNetworkClient {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
      const latest = await net.latestLedger();
      const expiration = latest + Math.ceil(requirements.maxTimeoutSeconds / 5);
      const assembled = await contract.AssembledTransaction.build({
        contractId: requirements.asset,
        method: "transfer",
        args: [
          nativeToScVal(signer.address, { type: "address" }),
          nativeToScVal(requirements.payTo, { type: "address" }),
          nativeToScVal(requirements.amount, { type: "i128" }),
        ],
        networkPassphrase: net.passphrase,
        rpcUrl: net.rpcUrl,
        allowHttp: true,
        parseResultXdr: (result: xdr.ScVal) => result,
      });
      await assembled.signAuthEntries({
        address: signer.address,
        signAuthEntry: signer.signAuthEntry,
        expiration,
      });
      await assembled.simulate();
      const built = assembled.built;
      if (built === undefined) throw new Error("not built");
      return { x402Version, payload: { transaction: built.toXDR() } };
    },
  };
}

const adapter: StellarSchemeAdapter = {
  ...exactScheme(),
  createClient: (signer) => localExactClient(signer),
};

/** Submits the buyer's signed transfer the way a facilitator does: re-sourced and fee-paid by a sponsor. */
async function settle(payload: Record<string, unknown>, sponsor: Keypair) {
  const inner = TransactionBuilder.fromXDR(String(payload["transaction"]), net.passphrase) as Transaction;
  const operation = inner.operations[0] as Operation.InvokeHostFunction;
  const account = await net.server.getAccount(sponsor.publicKey());
  const outer = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(Operation.invokeHostFunction({ func: operation.func, auth: operation.auth ?? [] }))
    .setTimeout(60)
    .build();
  const prepared = await net.server.prepareTransaction(outer);
  prepared.sign(sponsor);
  return net.submit(prepared);
}

describe.skipIf(!available)("guarded signer on a Stellar network", () => {
  let usdc: IssuedAsset;
  let buyer: KeyHolder;
  let seller: Keypair;
  let sponsor: Keypair;
  let policy: ResolvedPolicy;
  const ledger = new MemorySpendLedger();
  const clock = new LatestLedger(new rpc.Server(net.rpcUrl, { allowHttp: true }));

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    const payer = await net.holder(usdc, "10");
    buyer = KeyHolder.fromSecret(payer.secret());
    seller = await net.holder(usdc, "0");
    sponsor = Keypair.random();
    await net.fund(sponsor);
    const directory = new AssetDirectory(net.server, net.passphrase);
    policy = await resolvePolicy(
      TESTNET,
      { assets: [{ asset: usdc.sac, decimals: 7, perCall: "1", sessionTotal: "5" }] },
      { requireCaps: true, describe: (asset) => directory.describe(asset) },
    );
  });

  const option = (amount: string): PaymentRequirements => ({
    scheme: "exact",
    network: TESTNET,
    asset: usdc.sac,
    amount,
    payTo: seller.publicKey(),
    maxTimeoutSeconds: 10,
    extra: { areFeesSponsored: true },
  });

  async function guardedPayment(amount: string, callId: string) {
    const requirements = option(amount);
    const guard = createGuardedSigner(buyer, {
      network: TESTNET,
      policy,
      adapters: [exactScheme()],
      ledger,
      window: windowSpecFor(policy, buyer.address),
      clock,
      expectation: {
        scheme: "exact",
        network: TESTNET,
        asset: usdc.sac,
        payTo: requirements.payTo,
        amount: BigInt(amount),
        maxTimeoutSeconds: requirements.maxTimeoutSeconds,
        effectiveCap: 10_000_000n,
      },
      callId,
      resource: "https://seller.example/weather",
    });
    const { payload } = await adapter
      .createClient(guard, { url: net.rpcUrl })
      .createPaymentPayload(2, requirements);
    return { guard, payload, authorization: checkGuardedPayload(guard, payload) };
  }

  it("signs a real payment that settles, and reconciliation confirms it from the transfer event", async () => {
    const { authorization, payload } = await guardedPayment("2500000", "settles");
    expect(authorization.intent).toMatchObject({
      payer: buyer.address,
      recipient: seller.publicKey(),
      maxAmount: 2_500_000n,
    });
    ledger.markTransmitted(authorization.reservationId);
    ledger.markUnresolved(authorization.reservationId);

    const settled = await settle(payload, sponsor);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(2_500_000n);

    const report = await reconcile(ledger, rpcChainReader(net.server), {
      network: TESTNET,
      payer: buyer.address,
      maxAuthorizationSeconds: policy.maxAuthorizationSeconds,
    });
    expect(report.settled).toBe(1);
    expect(ledger.get(authorization.reservationId)).toMatchObject({
      state: "settled",
      verified: true,
      settledAmount: 2_500_000n,
      transaction: settled.txHash,
    });
  });

  it("releases an authorization that expired without moving money, and only then", async () => {
    const { authorization } = await guardedPayment("1500000", "expires");
    ledger.markTransmitted(authorization.reservationId);
    const chain = rpcChainReader(net.server);
    const options: ReconcileOptions = {
      network: TESTNET,
      payer: buyer.address,
      maxAuthorizationSeconds: policy.maxAuthorizationSeconds,
    };

    const early = await reconcile(ledger, chain, options);
    expect(early.released).toBe(0);
    expect(ledger.get(authorization.reservationId)?.state).toBe("transmitted");

    const expiration = authorization.intent.expirationLedger;
    for (let attempt = 0; attempt < 60 && (await net.latestLedger()) <= expiration; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const late = await reconcile(ledger, chain, options);
    expect(late.released).toBe(1);
    expect(ledger.get(authorization.reservationId)).toMatchObject({
      state: "released",
      releaseReason: "expired_unused",
    });
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(2_500_000n);
  });

  it("refuses to sign a payment above the per-call cap", async () => {
    const failed = await guardedPayment("10000001", "too-much").catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: "payment_per_call_cap_exceeded" });
  });
});
