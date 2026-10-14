/**
 * The unmodified @x402/stellar exact client signing through the guard on the public Stellar testnet.
 * Opt-in (RAIL402_TEST_PUBLIC_TESTNET=1) because it depends on the public RPC and Friendbot. It pays in
 * native XLM, so Friendbot funding is enough; nothing is submitted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Asset, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import { AssetDirectory, LatestLedger, TESTNET } from "@rail402.dev/stellar";
import {
  KeyHolder,
  MemorySpendLedger,
  NETWORK_DEFAULTS,
  checkGuardedPayload,
  createGuardedSigner,
  exactScheme,
  resolvePolicy,
  windowSpecFor,
  type ResolvedPolicy,
} from "@rail402.dev/sdk";

const enabled = process.env["RAIL402_TEST_PUBLIC_TESTNET"] === "1";
const rpcUrl = NETWORK_DEFAULTS[TESTNET].rpcUrl ?? "";
const xlm = Asset.native().contractId(Networks.TESTNET);

async function friendbot(address: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
  if (!response.ok) throw new Error(`friendbot ${response.status}`);
}

describe.skipIf(!enabled)("stock exact client through the guard (public testnet)", () => {
  const server = new rpc.Server(rpcUrl);
  const buyer = KeyHolder.random();
  const seller = Keypair.random();
  let policy: ResolvedPolicy;

  beforeAll(async () => {
    await Promise.all([friendbot(buyer.address), friendbot(seller.publicKey())]);
    const directory = new AssetDirectory(server, Networks.TESTNET);
    policy = await resolvePolicy(
      TESTNET,
      { assets: [{ asset: xlm, decimals: 7, perCall: "0.5", sessionTotal: "1" }] },
      { requireCaps: true, describe: (asset) => directory.describe(asset) },
    );
  }, 120_000);

  it("produces a payload carrying exactly the guarded authorization", async () => {
    const requirements = {
      scheme: "exact",
      network: TESTNET,
      asset: xlm,
      amount: "1000000",
      payTo: seller.publicKey(),
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    } as const;
    const ledger = new MemorySpendLedger();
    const guard = createGuardedSigner(buyer, {
      network: TESTNET,
      policy,
      adapters: [exactScheme()],
      ledger,
      window: windowSpecFor(policy, buyer.address),
      clock: new LatestLedger(server),
      expectation: {
        scheme: "exact",
        network: TESTNET,
        asset: xlm,
        payTo: requirements.payTo,
        amount: 1_000_000n,
        maxTimeoutSeconds: 60,
        effectiveCap: 5_000_000n,
      },
      callId: "stock-client",
    });
    const client = new x402Client()
      .register(TESTNET, exactScheme().createClient(guard, { url: rpcUrl }))
      .setSpendControls({
        allowedAssets: [{ network: TESTNET, asset: xlm, maxAmountPerPayment: "5000000" }],
      });
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://seller.example/weather" },
      accepts: [{ ...requirements, extra: { ...requirements.extra } }],
    });
    const authorization = checkGuardedPayload(guard, payload.payload);
    expect(authorization.intent).toMatchObject({
      payer: buyer.address,
      recipient: seller.publicKey(),
      maxAmount: 1_000_000n,
    });
    expect(ledger.get(authorization.reservationId)?.state).toBe("signed");
  }, 120_000);
});
