import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount, Networks, type rpc, type xdr } from "@stellar/stellar-sdk";
import { encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { TESTNET } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";
import {
  UPTO_TESTNET_DEPLOYMENT,
  approveInvocation,
  authorizationPreimage,
  inspectUptoAuthorization,
  unsignedPayerEntry,
  type UptoTerms,
} from "@rail402.dev/upto";
import { UptoStellarScheme } from "@rail402.dev/upto/client";
import {
  KeyHolder,
  MemorySpendLedger,
  budgetSnapshot,
  decideSpend,
  exactScheme,
  isPaymentError,
  reconcile,
  uptoScheme,
  uptoSettledAmount,
  type DecideContext,
  type FlowChain,
  type PaymentError,
  type PaymentEvent,
  type SpendExpectation,
  type SpendIntent,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";
import { payHttp } from "../src/flow/http.ts";
import {
  countingSigner,
  flowContext,
  fundedChain,
  startSeller,
  type FakeSeller,
  type SellerRoute,
} from "./flow-harness.ts";
import { LATEST, testPolicy, usdc } from "./helpers.ts";
import { uptoSettlement } from "./chain-fixtures.ts";

const CONTRACT = UPTO_TESTNET_DEPLOYMENT.address;
const CAP = 500_000n;
const facilitator = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();

function terms(overrides: Partial<UptoTerms> = {}): UptoTerms {
  return {
    expirationLedger: LATEST + 12,
    facilitator,
    maxAmount: CAP,
    recipient: payTo,
    token: usdc,
    validAfterLedger: 0,
    ...overrides,
  };
}

/** The preimage a wallet receives for an upto authorization, optionally with a tampered tree. */
function uptoPreimage(
  payer: string,
  options: {
    readonly terms?: Partial<UptoTerms>;
    readonly contract?: string;
    readonly expiration?: number;
    readonly children?: (tree: xdr.SorobanAuthorizedInvocation) => xdr.SorobanAuthorizedInvocation[];
    readonly fn?: string;
  } = {},
): string {
  const contract = options.contract ?? CONTRACT;
  const signed = terms(options.terms);
  const entry = unsignedPayerEntry({ contract, payer, terms: signed, nonce: 9n });
  const root = entry.rootInvocation();
  if (options.fn !== undefined) root.function().contractFn().functionName(options.fn);
  if (options.children !== undefined) root.subInvocations(options.children(root));
  if (options.expiration !== undefined)
    entry.credentials().address().signatureExpirationLedger(options.expiration);
  return authorizationPreimage(entry, Networks.TESTNET).toXDR("base64");
}

describe("upto in the signing guard", () => {
  const payer = Keypair.random().publicKey();
  const expectation: SpendExpectation = {
    scheme: "upto",
    network: TESTNET,
    asset: usdc,
    payTo,
    amount: CAP,
    maxTimeoutSeconds: 60,
    effectiveCap: 1_000_000n,
    facilitator,
  };
  const context = async (overrides: Partial<DecideContext> = {}): Promise<DecideContext> => ({
    network: TESTNET,
    policy: await testPolicy(),
    adapters: [exactScheme(), uptoScheme()],
    signerAddress: payer,
    latestLedger: LATEST,
    expectation,
    ...overrides,
  });

  it("signs the exact tree: settle(terms) on the pinned contract with its single approval", async () => {
    const decision = decideSpend(uptoPreimage(payer), await context());
    expect(decision).toMatchObject({
      ok: true,
      intent: {
        scheme: "upto",
        contract: CONTRACT,
        asset: usdc,
        payer,
        recipient: payTo,
        maxAmount: CAP,
        nonce: 9n,
        expirationLedger: LATEST + 12,
        facilitator,
      },
    });
  });

  it.each([
    ["an unpinned settlement contract", { contract: randomContractId() }],
    ["another function", { fn: "settle_for" }],
    ["no approval", { children: () => [] }],
    [
      "a second approval",
      {
        children: (tree: xdr.SorobanAuthorizedInvocation) => [
          ...tree.subInvocations(),
          ...tree.subInvocations(),
        ],
      },
    ],
    [
      "an approval of more than the cap",
      { children: () => [approveInvocation(CONTRACT, payer, terms({ maxAmount: CAP + 1n }))] },
    ],
    [
      "an approval to another spender",
      { children: () => [approveInvocation(randomContractId(), payer, terms())] },
    ],
    ["terms expiring after the signature", { expiration: LATEST + 11 }],
    ["terms valid only later", { terms: { validAfterLedger: LATEST + 5 } }],
    ["a token outside the policy", { terms: { token: randomContractId() } }],
  ])("fails closed on %s", async (_name, options) => {
    expect(decideSpend(uptoPreimage(payer, options), await context())).toMatchObject({
      ok: false,
      code: "payment_authorization_rejected",
    });
  });

  it("binds the recipient, the cap and the settlement authority to the selected option", async () => {
    const other = Keypair.random().publicKey();
    for (const tampered of [{ recipient: other }, { maxAmount: CAP - 1n }, { facilitator: other }]) {
      const decision = decideSpend(uptoPreimage(payer, { terms: tampered }), await context());
      expect(decision).toMatchObject({ ok: false, code: "payment_authorization_rejected" });
    }
  });

  it("refuses a settlement authority that is the recipient or outside the allowed list", async () => {
    const self = decideSpend(
      uptoPreimage(payer, { terms: { facilitator: payTo } }),
      await context({ expectation: { ...expectation, facilitator: payTo } }),
    );
    expect(self).toMatchObject({ ok: false, code: "payment_facilitator_not_permitted" });
    const listed = await testPolicy({ uptoFacilitators: [Keypair.random().publicKey()] });
    expect(decideSpend(uptoPreimage(payer), await context({ policy: listed }))).toMatchObject({
      ok: false,
      code: "payment_facilitator_not_permitted",
    });
  });

  it("caps the authorized maximum and refuses upto when the policy does not enable it", async () => {
    const capped = decideSpend(
      uptoPreimage(payer),
      await context({ expectation: { ...expectation, effectiveCap: CAP - 1n } }),
    );
    expect(capped).toMatchObject({ ok: false, code: "payment_per_call_cap_exceeded" });
    const exactOnly = await testPolicy({ schemes: ["exact"] });
    expect(decideSpend(uptoPreimage(payer), await context({ policy: exactOnly }))).toMatchObject({
      ok: false,
      code: "payment_authorization_rejected",
    });
  });
});

describe("upto option checks", () => {
  const option = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
    scheme: "upto",
    network: TESTNET,
    asset: usdc,
    amount: CAP.toString(),
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, facilitatorAddress: facilitator },
    ...overrides,
  });
  const muxed = new MuxedAccount(new Account(payTo, "0"), "3").accountId();

  it.each([
    ["unsponsored fees", { extra: { facilitatorAddress: facilitator } }, "payment_fees_not_sponsored"],
    ["a muxed recipient", { payTo: muxed }, "payment_recipient_not_permitted"],
    ["no settlement authority", { extra: { areFeesSponsored: true } }, "payment_facilitator_not_permitted"],
    [
      "the recipient as its own authority",
      { extra: { areFeesSponsored: true, facilitatorAddress: payTo } },
      "payment_facilitator_not_permitted",
    ],
  ] as const)("refuses %s before signing", async (_name, overrides, code) => {
    const adapter = uptoScheme();
    expect(adapter.checkRequirements?.(option(overrides), await testPolicy())).toMatchObject({ code });
  });

  it("refuses a contract the policy does not pin", async () => {
    const adapter = uptoScheme({ contract: randomContractId() });
    expect(adapter.checkRequirements?.(option(), await testPolicy())).toMatchObject({
      code: "payment_scheme_not_permitted",
    });
    expect(uptoScheme().checkRequirements?.(option(), await testPolicy())).toBeUndefined();
    expect(uptoScheme().reserveAmount(option())).toBe(CAP);
  });
});

/** A settlement transaction for a signed upto payload, as a facilitator would submit it. */
function settlementOf(
  authorization: string,
  amount: bigint,
  options: {
    readonly events?: "none" | "wrong_amount";
    readonly transfer?: boolean;
    readonly consumed?: boolean;
  } = {},
): rpc.Api.GetSuccessfulTransactionResponse {
  const inspected = inspectUptoAuthorization(authorization, CONTRACT);
  if (!inspected.ok) throw new Error("the authorization does not decode");
  const { payer, terms: signed, entry, nonce } = inspected.authorization;
  return uptoSettlement({ contract: CONTRACT, payer, terms: signed, amount, nonce, entry, ...options });
}

/** Signs an upto payload for `requirements` with the stock client, offline. */
async function signedPayload(key: KeyHolder, requirements: PaymentRequirements) {
  const client = new UptoStellarScheme(key, {
    latestLedger: () => Promise.resolve(LATEST),
    ledgerSeconds: 5,
  });
  const { payload } = await client.createPaymentPayload(2, requirements);
  return payload as { authorization: string };
}

describe("upto payloads and settlements", () => {
  const key = KeyHolder.random();
  const requirements: PaymentRequirements = {
    scheme: "upto",
    network: TESTNET,
    asset: usdc,
    amount: CAP.toString(),
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, facilitatorAddress: facilitator },
  };
  const intentFor = (authorization: string): SpendIntent => {
    const inspected = inspectUptoAuthorization(authorization, CONTRACT);
    if (!inspected.ok) throw new Error("the authorization does not decode");
    const { nonce, signatureExpirationLedger } = inspected.authorization;
    return {
      scheme: "upto",
      network: TESTNET,
      contract: CONTRACT,
      asset: usdc,
      payer: key.address,
      recipient: payTo,
      maxAmount: CAP,
      nonce,
      expirationLedger: signatureExpirationLedger,
      credential: "address",
      facilitator,
    };
  };

  it("accepts only the payload that carries the signed authorization", async () => {
    const adapter = uptoScheme();
    const payload = await signedPayload(key, requirements);
    const intent = intentFor(payload.authorization);
    expect(adapter.checkPayload(payload, intent)).toBeUndefined();
    const other = await signedPayload(key, requirements);
    expect(adapter.checkPayload(other, intent)).toMatch(/differs/);
    expect(adapter.checkPayload({ ...payload, signerAuthorizations: ["AAAA"] }, intent)).toMatch(/delegated/);
    expect(adapter.checkPayload({ ...payload, amount: "1" }, intent)).toMatch(/other than/);
    expect(adapter.checkPayload({ authorization: "garbage" }, intent)).toMatch(/malformed/);
    expect(adapter.checkPayload(payload, { ...intent, facilitator: payTo })).toMatch(/settlement authority/);
  });

  it("reads the settled amount from the settlement of this very authorization", async () => {
    const payload = await signedPayload(key, requirements);
    const intent = intentFor(payload.authorization);
    expect(uptoSettledAmount(settlementOf(payload.authorization, 125_000n), intent)).toBe(125_000n);
    expect(uptoSettledAmount(settlementOf(payload.authorization, 0n), intent)).toBe(0n);
    expect(uptoSettledAmount(settlementOf(payload.authorization, CAP), intent)).toBe(CAP);
    // The consumed authorization is spent whatever else the transaction shows: the amount is the
    // settlement contract's own record, and the whole cap when there is none.
    expect(uptoSettledAmount(settlementOf(payload.authorization, 1n, { events: "none" }), intent)).toBe(CAP);
    expect(
      uptoSettledAmount(settlementOf(payload.authorization, 1n, { events: "wrong_amount" }), intent),
    ).toBe(2n);
    expect(uptoSettledAmount(settlementOf(payload.authorization, 1n, { transfer: false }), intent)).toBe(1n);
    // An authorization carried along but never consumed by the host proves nothing.
    expect(
      uptoSettledAmount(settlementOf(payload.authorization, 1n, { consumed: false }), intent),
    ).toBeUndefined();
    // Another authorization's settlement (another nonce) is not this payment's.
    const other = await signedPayload(key, requirements);
    expect(uptoSettledAmount(settlementOf(other.authorization, 1n), intent)).toBeUndefined();
  });
});

describe("paying upto over HTTP", () => {
  let seller: FakeSeller;
  /** What the seller reports it settled, per path. */
  const charged: Record<string, { amount: string; transaction: string }> = {};
  const hashFor = (path: string) => Buffer.from(path.padEnd(32, "-")).toString("hex").slice(0, 64);

  beforeAll(async () => {
    const route =
      (path: string, amount: string, transaction = hashFor(path)): SellerRoute =>
      (request, response, s) => {
        const option = {
          scheme: "upto",
          amount: CAP.toString(),
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true, facilitatorAddress: facilitator },
        };
        if (request.payment === undefined) {
          s.paymentRequired(response, option);
          return;
        }
        charged[path] = { amount, transaction };
        response
          .writeHead(200, {
            "content-type": "application/json",
            "payment-response": encodePaymentResponseHeader({
              success: true,
              transaction,
              network: TESTNET,
              payer: "",
              amount,
            }),
          })
          .end('{"ok":true}');
      };
    seller = await startSeller({
      "/partial": route("/partial", "125000"),
      "/max": route("/max", CAP.toString()),
      "/zero-onchain": route("/zero-onchain", "0"),
      "/zero-offchain": route("/zero-offchain", "0", ""),
    });
  });

  afterAll(async () => {
    await seller.close();
  });

  /** A chain whose getTransaction returns the settlement of what the seller received. */
  const chainFor = (path: string, latest = LATEST): FlowChain =>
    fundedChain({
      getTransaction: () => {
        const request = seller.seen.findLast(
          (seen) => seen.path.startsWith(path) && seen.payment !== undefined,
        );
        const authorization = (request?.payment?.payload as { authorization: string }).authorization;
        return Promise.resolve(settlementOf(authorization, BigInt(charged[path]?.amount ?? "0")));
      },
      reader: {
        latestLedger: () => Promise.resolve(latest),
        findTransfers: () => Promise.resolve([]),
        transaction: () => Promise.resolve("missing"),
      },
    });

  const pay = async (path: string, verify: "sync" | "off", events: PaymentEvent[] = []) => {
    const ledger = new MemorySpendLedger();
    const context = await flowContext({
      signer: countingSigner(),
      ledger,
      adapters: [exactScheme(), uptoScheme({ ledgerSeconds: 5 })],
      chain: chainFor(path),
      ports: [seller.port],
      verify,
      events,
    });
    const result = await payHttp(
      context,
      { kind: "http", url: `${seller.url}${path}` },
      { maxAmount: { amount: "0.1" } },
    );
    const usage = () => {
      if (context.spec === undefined) throw new Error("no budget window");
      const [asset] = budgetSnapshot(ledger, context.spec, context.policy).assets;
      return { spent: asset?.spent, pending: asset?.pending };
    };
    return { result, usage, context, ledger };
  };

  it("reserves the cap, then keeps only the proven charge of a partial settlement", async () => {
    const events: PaymentEvent[] = [];
    const { result, usage } = await pay("/partial", "sync", events);
    expect(result.payment).toMatchObject({
      status: "settled",
      scheme: "upto",
      authorized: { amount: "0.05", atomic: CAP.toString() },
      settled: { amount: "0.0125", atomic: "125000" },
      verifiedOnChain: true,
    });
    expect(usage()).toEqual({ spent: "0.0125", pending: "0" });
    expect(events.filter((event) => event.type === "reserved")).toEqual([
      expect.objectContaining({ amount: CAP.toString() }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "released", reason: "settled_below_cap", amount: "375000" }),
    );
  });

  it("keeps the unproven remainder pending until the chain shows the settlement", async () => {
    const { result, usage } = await pay("/partial", "off");
    expect(result.payment).toMatchObject({ settled: { atomic: "125000" }, verifiedOnChain: false });
    expect(usage()).toEqual({ spent: "0.0125", pending: "0.0375" });
  });

  it("spends the whole cap for a maximum settlement", async () => {
    const { result, usage } = await pay("/max", "sync");
    expect(result.payment).toMatchObject({ settled: { atomic: CAP.toString() }, verifiedOnChain: true });
    expect(usage()).toEqual({ spent: "0.05", pending: "0" });
  });

  it("releases the whole cap once a zero settlement is proven on chain", async () => {
    const { result, usage } = await pay("/zero-onchain", "sync");
    expect(result.payment).toMatchObject({ settled: { atomic: "0" }, verifiedOnChain: true });
    expect(usage()).toEqual({ spent: "0", pending: "0" });
  });

  it("holds an off-chain zero settlement until its authorization expires unused", async () => {
    const { result, usage, context, ledger } = await pay("/zero-offchain", "sync");
    expect(result.payment).toMatchObject({
      status: "settled",
      transaction: null,
      settled: { atomic: "0" },
      verifiedOnChain: false,
    });
    expect(usage()).toEqual({ spent: "0", pending: "0.05" });
    const payer = context.signer?.address ?? "";
    // Before expiry nothing is proven; after it, no transfer proves the zero.
    expect(
      await reconcile(ledger, chainFor("/zero-offchain", LATEST).reader, {
        network: TESTNET,
        payer,
        maxAuthorizationSeconds: 300,
      }),
    ).toMatchObject({ settled: 0, waiting: 1 });
    expect(
      await reconcile(ledger, chainFor("/zero-offchain", LATEST + 1_000).reader, {
        network: TESTNET,
        payer,
        maxAuthorizationSeconds: 300,
      }),
    ).toMatchObject({ settled: 1, released: 0 });
    expect(usage()).toEqual({ spent: "0", pending: "0" });
  });
});

describe("a malicious upto scheme client", () => {
  let seller: FakeSeller;

  beforeAll(async () => {
    seller = await startSeller({
      "/metered": (request, response, s) => {
        if (request.payment === undefined) {
          s.paymentRequired(response, {
            scheme: "upto",
            amount: CAP.toString(),
            extra: { areFeesSponsored: true, facilitatorAddress: facilitator },
          });
        } else s.settled(response);
      },
    });
  });

  afterAll(async () => {
    await seller.close();
  });

  /** An upto adapter whose client signs something other than the requirements it was given. */
  const doubleSigning = (
    change: (requirements: PaymentRequirements) => PaymentRequirements,
    contract?: string,
  ): StellarSchemeAdapter => ({
    ...uptoScheme({ ledgerSeconds: 5 }),
    createClient: (signer, connection) => {
      const inner = new UptoStellarScheme(signer, {
        latestLedger: connection.latestLedger ?? (() => Promise.resolve(LATEST)),
        ledgerSeconds: 5,
        ...(contract === undefined ? {} : { contracts: contract }),
      });
      return {
        scheme: "upto",
        createPaymentPayload: (version, requirements, context) =>
          inner.createPaymentPayload(version, change(requirements), context),
      };
    },
  });

  it.each([
    ["another settlement contract", doubleSigning((requirements) => requirements, randomContractId())],
    [
      "another settlement authority",
      doubleSigning((requirements) => ({
        ...requirements,
        extra: { ...requirements.extra, facilitatorAddress: Keypair.random().publicKey() },
      })),
    ],
    [
      "another recipient",
      doubleSigning((requirements) => ({ ...requirements, payTo: Keypair.random().publicKey() })),
    ],
    ["a higher cap", doubleSigning((requirements) => ({ ...requirements, amount: (CAP + 1n).toString() }))],
  ])("is refused inside the signer when it signs for %s", async (_name, adapter) => {
    const signer = countingSigner();
    const ledger = new MemorySpendLedger();
    const context = await flowContext({ signer, ledger, adapters: [adapter], ports: [seller.port] });
    const before = seller.seen.length;
    let error: PaymentError | undefined;
    try {
      await payHttp(
        context,
        { kind: "http", url: `${seller.url}/metered` },
        { maxAmount: { amount: "0.1" } },
      );
    } catch (caught) {
      if (!isPaymentError(caught)) throw caught;
      error = caught;
    }
    expect(error).toMatchObject({ code: "payment_authorization_rejected", paid: "none" });
    expect(signer.signatures).toBe(0);
    // Only the unpaid probe reached the seller; the budget holds nothing.
    expect(seller.seen.slice(before).every((request) => request.payment === undefined)).toBe(true);
    if (context.spec === undefined) throw new Error("no budget window");
    expect(budgetSnapshot(ledger, context.spec, context.policy).assets[0]).toMatchObject({ pending: "0" });
  });
});
