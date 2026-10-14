import { describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount, type xdr, type rpc } from "@stellar/stellar-sdk";
import { TESTNET, baseAccount, type FoundTransfer, type TransferQuery } from "@rail402.dev/stellar";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
import {
  MemorySpendLedger,
  reconcile,
  type ChainReader,
  type PaymentEvent,
  type ReconcileOptions,
  type Reservation,
  type SpendLedger,
  type WindowSpec,
} from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";
import { exactSettlement, uptoSettlement, wrappedSettlements } from "./chain-fixtures.ts";
import { randomContractId } from "@rail402.dev/testkit";
import { usdc } from "./helpers.ts";

const T0 = 1_800_000_000_000;

interface FakeChain extends ChainReader {
  latest: number;
  transfers: FoundTransfer[];
  queries: TransferQuery[];
  oldest: number;
  failing: boolean;
  /** The settlement transactions behind the transfers, by hash. */
  settlements: Map<string, rpc.Api.GetSuccessfulTransactionResponse>;
}

interface ChainTransfer {
  readonly found: FoundTransfer;
  readonly settlement: rpc.Api.GetSuccessfulTransactionResponse;
}

function chain(latest: number, transfers: ChainTransfer[] = []): FakeChain {
  const fake: FakeChain = {
    latest,
    transfers: transfers.map((transfer) => transfer.found),
    settlements: new Map(transfers.map((transfer) => [transfer.found.transaction, transfer.settlement])),
    queries: [],
    oldest: 1,
    failing: false,
    latestLedger: () => Promise.resolve(fake.latest),
    findTransfers: (query) => {
      fake.queries.push(query);
      if (fake.failing) return Promise.reject(new Error("rpc down"));
      if (query.startLedger < fake.oldest || query.endLedger > fake.latest)
        return Promise.resolve("out_of_range");
      return Promise.resolve(
        fake.transfers.filter(
          (transfer) =>
            transfer.contract === query.asset &&
            transfer.from === query.from &&
            transfer.ledger >= query.startLedger &&
            transfer.ledger <= query.endLedger,
        ),
      );
    },
    transaction: (hash) => {
      if (fake.failing) return Promise.reject(new Error("rpc down"));
      return Promise.resolve(fake.settlements.get(hash) ?? "missing");
    },
  };
  return fake;
}

const payer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const facilitator = Keypair.random().publicKey();
const CONTRACT = UPTO_TESTNET_DEPLOYMENT.address;

let nextNonce = 1n;

function setup(ledger: SpendLedger = new MemorySpendLedger()) {
  const spec: WindowSpec = {
    network: TESTNET,
    payer,
    name: "default",
    ttlMs: 86_400_000,
    caps: { [usdc]: { perCall: 1_000_000n, total: 10_000_000n, decimals: 7 } },
    autoRenew: true,
    autoCreate: true,
  };
  const signed = (
    amount: bigint,
    expirationLedger: number,
    options: { scheme?: "exact" | "upto"; payTo?: string; signedAt?: number } = {},
  ) => {
    const row = ledger.reserve(
      spec,
      {
        callId: crypto.randomUUID(),
        scheme: options.scheme ?? "exact",
        asset: usdc,
        payTo: options.payTo ?? seller,
        resource: "r",
        amount,
      },
      T0,
    );
    const nonce = nextNonce++;
    const signedAtLedger = options.signedAt ?? expirationLedger - 20;
    ledger.markSigned(row.id, { nonce, expirationLedger, signedAtLedger }, T0);
    return { ...row, nonce, expirationLedger };
  };
  return { ledger, spec, signed };
}

type SignedRow = ReturnType<ReturnType<typeof setup>["signed"]>;

const randomHash = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");

/**
 * A transfer on chain made with `row`'s own authorization: for exact the transfer of its amount, for
 * upto the settlement of `amount` under its cap. `consumed: false` carries the authorization without
 * the host consuming it.
 */
const transfer = (
  row: SignedRow,
  ledger: number,
  options: { amount?: bigint; hash?: string; consumed?: boolean } = {},
): ChainTransfer => {
  const amount = options.amount ?? row.amount;
  const hash = options.hash ?? randomHash();
  const settlement =
    row.scheme === "exact"
      ? exactSettlement({
          asset: usdc,
          payer,
          payTo: row.payTo,
          amount,
          nonce: row.nonce,
          consumed: options.consumed,
        })
      : uptoSettlement({
          contract: CONTRACT,
          payer,
          terms: {
            expirationLedger: row.expirationLedger,
            facilitator,
            maxAmount: row.amount,
            recipient: row.payTo,
            token: usdc,
            validAfterLedger: 0,
          },
          amount,
          nonce: row.nonce,
          consumed: options.consumed,
        });
  return {
    found: {
      contract: usdc,
      from: payer,
      to: baseAccount(row.payTo) ?? row.payTo,
      amount,
      ledger,
      transaction: hash,
    },
    settlement,
  };
};

const options = (
  events: PaymentEvent[] = [],
  overrides: Partial<ReconcileOptions> = {},
): ReconcileOptions => ({
  network: TESTNET,
  payer,
  maxAuthorizationSeconds: 300,
  now: () => T0,
  onEvent: (event) => events.push(event),
  ...overrides,
});

const state = (ledger: SpendLedger, row: Reservation) => ledger.get(row.id);

describe("reconcile", () => {
  it("settles an unresolved payment when its transfer is on chain, even before expiry", async () => {
    const { ledger, signed } = setup();
    const row = signed(500n, 200);
    ledger.markUnresolved(row.id, T0);
    const fake = chain(190, [transfer(row, 185)]);
    const events: PaymentEvent[] = [];
    const report = await reconcile(ledger, fake, options(events));
    expect(report).toMatchObject({ checked: 1, settled: 1, released: 0 });
    expect(state(ledger, row)).toMatchObject({ state: "settled", verified: true, settledAmount: 500n });
    expect(fake.queries).toEqual([{ asset: usdc, from: payer, startLedger: 180, endLedger: 190 }]);
    expect(events[0]).toMatchObject({ type: "settled", amount: "500" });
  });

  it("releases an expired authorization only when the chain shows no transfer for it", async () => {
    const { ledger, signed } = setup();
    const unused = signed(500n, 200);
    const inFlight = signed(300n, 400);
    const report = await reconcile(ledger, chain(201), options());
    expect(report).toMatchObject({ checked: 1, released: 1, waiting: 1 });
    expect(state(ledger, unused)).toMatchObject({ state: "released", releaseReason: "expired_unused" });
    // Not yet expired and not unresolved: another process may still be sending it.
    expect(state(ledger, inFlight)?.state).toBe("signed");
  });

  it("does not release a payment whose transfer is found, and matches the amount and base recipient", async () => {
    const { ledger, signed } = setup();
    const muxed = new MuxedAccount(new Account(seller, "0"), "12").accountId();
    const paid = signed(500n, 200, { payTo: muxed });
    const wrongAmount = signed(700n, 200);
    const fake = chain(250, [transfer(paid, 190), transfer(wrongAmount, 191, { amount: 699n })]);
    await reconcile(ledger, fake, options());
    expect(state(ledger, paid)).toMatchObject({ state: "settled", verified: true });
    expect(state(ledger, wrongAmount)).toMatchObject({ state: "released", releaseReason: "expired_unused" });
  });

  it("settles a payment only from a transfer made with its own authorization", async () => {
    const { ledger, signed } = setup();
    const first = signed(500n, 200);
    const second = signed(500n, 200);
    // The same amount to the same seller, but made with the second payment's authorization.
    await reconcile(ledger, chain(250, [transfer(second, 190)]), options());
    expect(state(ledger, first)).toMatchObject({ state: "released", releaseReason: "expired_unused" });
    expect(state(ledger, second)).toMatchObject({ state: "settled", verified: true });
  });

  it("does not count an authorization carried in a transaction that never consumed it", async () => {
    const { ledger, signed } = setup();
    const row = signed(500n, 200);
    ledger.markUnresolved(row.id, T0);
    const report = await reconcile(ledger, chain(190, [transfer(row, 185, { consumed: false })]), options());
    expect(report).toMatchObject({ settled: 0, waiting: 1 });
    expect(state(ledger, row)?.state).toBe("unresolved");
  });

  it.each([
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ])("never lets another payment's transfer release an upto cap early (%s ledger)", async (_name, create) => {
    const { ledger, spec, signed } = setup(create());
    // An upto authorization (cap 100000) and a later exact payment (10000) to one seller, both
    // left unresolved because the seller reported neither settlement.
    const upto = signed(100_000n, 160, { scheme: "upto", signedAt: 100 });
    const exact = signed(10_000n, 130, { signedAt: 101 });
    ledger.markUnresolved(upto.id, T0);
    ledger.markUnresolved(exact.id, T0);
    const window = ledger.window(spec, T0);

    // The seller settles only the exact payment; the upto row must not take its transfer.
    const fake = chain(110, [transfer(exact, 105)]);
    await reconcile(ledger, fake, options());
    expect(state(ledger, upto)?.state).toBe("unresolved");
    expect(state(ledger, exact)).toMatchObject({ state: "settled", verified: true });
    expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 10_000n, pending: 100_000n });

    // Later the seller settles the upto authorization for the full cap: the budget counts it all.
    const settlement = transfer(upto, 150, { amount: 100_000n });
    fake.transfers.push(settlement.found);
    fake.settlements.set(settlement.found.transaction, settlement.settlement);
    fake.latest = 170;
    await reconcile(ledger, fake, options());
    expect(state(ledger, upto)).toMatchObject({ state: "settled", verified: true, settledAmount: 100_000n });
    expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 110_000n, pending: 0n });
    ledger.close();
  });

  it.each([
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ])(
    "never lets a claim of another payment's hash release that payment (%s ledger)",
    async (_name, create) => {
      for (const order of ["claim first", "claim last"] as const) {
        const { ledger, spec, signed } = setup(create());
        // B's report is withheld and A is answered with B's hash; the seller settled both on chain.
        const b = signed(10_000n, 200);
        const a = signed(10_000n, 200);
        const proofB = transfer(b, 190);
        const proofA = transfer(a, 195);
        ledger.markUnresolved(b.id, T0);
        if (order === "claim first") {
          ledger.settle(
            a.id,
            { transaction: proofB.found.transaction, settledAmount: 10_000n, verified: false },
            T0,
          );
        }
        const fake = chain(250, [proofB, proofA]);
        await reconcile(ledger, fake, options());
        if (order === "claim last") {
          expect(
            ledger.settle(
              a.id,
              { transaction: proofB.found.transaction, settledAmount: 10_000n, verified: false },
              T0,
            ),
          ).toBe(false);
        }
        expect(state(ledger, b)).toMatchObject({
          state: "settled",
          verified: true,
          transaction: proofB.found.transaction,
        });
        expect(state(ledger, a)).toMatchObject({
          state: "settled",
          verified: true,
          transaction: proofA.found.transaction,
        });
        const window = ledger.window(spec, T0);
        expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 20_000n, pending: 0n });
        ledger.close();
      }
    },
  );

  it.each([
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ])("settles every payment a batch transaction consumed (%s ledger)", async (_name, create) => {
    const { ledger, spec, signed } = setup(create());
    const first = signed(600_000n, 200);
    const second = signed(400_000n, 200);
    ledger.markUnresolved(first.id, T0);
    ledger.markUnresolved(second.id, T0);
    const hash = randomHash();
    const batch = wrappedSettlements(randomContractId(), [
      transfer(first, 190).settlement,
      transfer(second, 190).settlement,
    ]);
    const fake = chain(250);
    for (const row of [first, second]) {
      fake.transfers.push({ ...transfer(row, 190, { hash }).found });
    }
    fake.settlements.set(hash, batch);
    await reconcile(ledger, fake, options());
    expect(state(ledger, first)).toMatchObject({ state: "settled", verified: true, transaction: hash });
    expect(state(ledger, second)).toMatchObject({ state: "settled", verified: true, transaction: hash });
    expect(ledger.usage(ledger.window(spec, T0).id).assets.get(usdc)).toEqual({
      spent: 1_000_000n,
      pending: 0n,
    });
    ledger.close();
  });

  it("settles each payer's payment from one batch transaction in a shared ledger file", async () => {
    const ledger = new SqliteSpendLedger(":memory:");
    const other = Keypair.random().publicKey();
    const specFor = (address: string): WindowSpec => ({
      network: TESTNET,
      payer: address,
      name: "default",
      ttlMs: 86_400_000,
      caps: { [usdc]: { perCall: 1_000_000n, total: 10_000_000n, decimals: 7 } },
      autoRenew: true,
      autoCreate: true,
    });
    const rows = [payer, other].map((address, index) => {
      const row = ledger.reserve(
        specFor(address),
        {
          callId: `c${String(index)}`,
          scheme: "exact",
          asset: usdc,
          payTo: seller,
          resource: "r",
          amount: 500n,
        },
        T0,
      );
      const nonce = 900n + BigInt(index);
      ledger.markSigned(row.id, { nonce, expirationLedger: 200, signedAtLedger: 180 }, T0);
      ledger.markUnresolved(row.id, T0);
      return { row, address, nonce };
    });
    const hash = randomHash();
    const batch = wrappedSettlements(
      randomContractId(),
      rows.map(({ address, nonce }) =>
        exactSettlement({ asset: usdc, payer: address, payTo: seller, amount: 500n, nonce }),
      ),
    );
    for (const { row, address } of rows) {
      const fake = chain(250);
      fake.transfers.push({
        contract: usdc,
        from: address,
        to: seller,
        amount: 500n,
        ledger: 190,
        transaction: hash,
      });
      fake.settlements.set(hash, batch);
      await reconcile(ledger, fake, options([], { payer: address }));
      expect(ledger.get(row.id)).toMatchObject({ state: "settled", verified: true, transaction: hash });
    }
    ledger.close();
  });

  it.each([
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ])("counts an upto settlement made through another contract (%s ledger)", async (_name, create) => {
    const { ledger, spec, signed } = setup(create());
    const unreported = signed(100_000n, 200, { scheme: "upto" });
    const zeroClaim = signed(100_000n, 200, { scheme: "upto" });
    const lowClaim = signed(100_000n, 200, { scheme: "upto" });
    ledger.markUnresolved(unreported.id, T0);
    // Claims a seller reported: zero off chain, and 1 base unit with a hash.
    ledger.settle(zeroClaim.id, { transaction: null, settledAmount: 0n, verified: false }, T0);
    const fake = chain(250);
    for (const row of [unreported, zeroClaim, lowClaim]) {
      const direct = transfer(row, 190, { amount: 100_000n });
      const hash = direct.found.transaction;
      fake.transfers.push(direct.found);
      fake.settlements.set(hash, wrappedSettlements(randomContractId(), [direct.settlement]));
      if (row === lowClaim)
        ledger.settle(row.id, { transaction: hash, settledAmount: 1n, verified: false }, T0);
    }
    await reconcile(ledger, fake, options());
    for (const row of [unreported, zeroClaim, lowClaim]) {
      expect(state(ledger, row)).toMatchObject({ state: "settled", verified: true, settledAmount: 100_000n });
    }
    expect(ledger.usage(ledger.window(spec, T0).id).assets.get(usdc)).toEqual({
      spent: 300_000n,
      pending: 0n,
    });
    ledger.close();
  });

  it("counts an upto authorization's whole cap when its settlement amount cannot be read", async () => {
    const { ledger, signed } = setup();
    const row = signed(100_000n, 200, { scheme: "upto" });
    ledger.markUnresolved(row.id, T0);
    const found = transfer(row, 190, { amount: 5_000n });
    const fake = chain(250);
    fake.transfers.push(found.found);
    fake.settlements.set(
      found.found.transaction,
      uptoSettlement({
        contract: CONTRACT,
        payer,
        terms: {
          expirationLedger: row.expirationLedger,
          facilitator,
          maxAmount: row.amount,
          recipient: row.payTo,
          token: usdc,
          validAfterLedger: 0,
        },
        amount: 5_000n,
        nonce: row.nonce,
        events: "none",
      }),
    );
    await reconcile(ledger, fake, options());
    expect(state(ledger, row)).toMatchObject({ state: "settled", verified: true, settledAmount: 100_000n });
  });

  it("confirms a reported settlement from the chain, and releases a false claim after expiry", async () => {
    const { ledger, signed } = setup();
    const honest = signed(400n, 200);
    const proof = transfer(honest, 195);
    ledger.settle(
      honest.id,
      { transaction: proof.found.transaction, settledAmount: 400n, verified: false },
      T0,
    );
    const liar = signed(600n, 200);
    ledger.settle(liar.id, { transaction: "bb".repeat(32), settledAmount: 600n, verified: false }, T0);
    const report = await reconcile(ledger, chain(260, [proof]), options());
    expect(report).toMatchObject({ settled: 1, released: 1 });
    expect(state(ledger, honest)).toMatchObject({ state: "settled", verified: true });
    expect(state(ledger, liar)).toMatchObject({ state: "released", releaseReason: "claim_false" });
  });

  it("keeps an upto remainder pending until the chain shows what moved", async () => {
    const { ledger, spec, signed } = setup();
    const row = signed(1_000n, 200, { scheme: "upto" });
    ledger.settle(row.id, { transaction: null, settledAmount: 300n, verified: false }, T0);
    const window = ledger.window(spec, T0);
    expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 300n, pending: 700n });
    await reconcile(ledger, chain(260, [transfer(row, 195, { amount: 250n })]), options());
    expect(state(ledger, row)).toMatchObject({ state: "settled", verified: true, settledAmount: 250n });
    expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 250n, pending: 0n });
  });

  it("asks again later while the RPC does not return the transaction behind a transfer", async () => {
    const { ledger, signed } = setup();
    const row = signed(500n, 200);
    const proof = transfer(row, 190);
    const fake = chain(250, [proof]);
    fake.settlements.clear();
    const report = await reconcile(ledger, fake, options());
    expect(report).toMatchObject({ deferred: 1, released: 0, checked: 0 });
    expect(state(ledger, row)?.state).toBe("unresolved");
    fake.settlements.set(proof.found.transaction, proof.settlement);
    await reconcile(ledger, fake, options());
    expect(state(ledger, row)).toMatchObject({ state: "settled", verified: true });
  });

  it("asks again later about a transaction whose meta this version cannot read", async () => {
    const { ledger, signed } = setup();
    const row = signed(500n, 200);
    const proof = transfer(row, 190);
    const fake = chain(250, [proof]);
    fake.settlements.set(proof.found.transaction, {
      ...proof.settlement,
      resultMetaXdr: { switch: () => 5 } as unknown as xdr.TransactionMeta,
    });
    const report = await reconcile(ledger, fake, options());
    expect(report).toMatchObject({ deferred: 1, released: 0 });
    expect(state(ledger, row)?.state).toBe("unresolved");
  });

  it.each([
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ])(
    "counts expired rows the RPC can no longer prove as spent, and stops checking them (%s ledger)",
    async (_name, create) => {
      const { ledger, spec, signed } = setup(create());
      const stale = [1, 2, 3, 4, 5, 6].map(() => signed(500n, 200, { signedAt: 180 }));
      const fake = chain(90_000);
      fake.oldest = 70_000;
      const events: PaymentEvent[] = [];
      const report = await reconcile(ledger, fake, options(events, { limit: 5 }));
      expect(report).toMatchObject({ unprovable: 5, deferred: 1, released: 0 });
      // A fresh row behind them is checked on the next bounded run, not starved.
      const fresh = signed(700n, 89_990, { signedAt: 80_000 });
      const next = await reconcile(ledger, fake, options(events, { limit: 5 }));
      expect(next).toMatchObject({ unprovable: 1, released: 1 });
      expect(state(ledger, fresh)).toMatchObject({ state: "released", releaseReason: "expired_unused" });
      for (const row of stale) {
        expect(state(ledger, row)).toMatchObject({ state: "settled", unprovable: true, settledAmount: 500n });
      }
      expect(ledger.unfinished(TESTNET, payer)).toEqual([]);
      expect(events.filter((event) => event.type === "unprovable")).toHaveLength(6);
      // Counted as spent in their own window; a renewed window does not carry them as pending.
      const window = ledger.window(spec, T0);
      expect(ledger.usage(window.id).assets.get(usdc)).toEqual({ spent: 3_000n, pending: 0n });
      const renewed = ledger.startWindow(spec, T0 + 1);
      expect(ledger.usage(renewed.id).assets.get(usdc)).toBeUndefined();
      ledger.close();
    },
  );

  it("keeps a row it cannot prove pending while its authorization is still valid", async () => {
    const { ledger, signed } = setup();
    const row = signed(500n, 95_000, { signedAt: 60_000 });
    ledger.markUnresolved(row.id, T0);
    const fake = chain(90_000);
    fake.oldest = 70_000;
    const report = await reconcile(ledger, fake, options());
    expect(report).toMatchObject({ awaitingProof: 1, unprovable: 0 });
    expect(state(ledger, row)).toMatchObject({ state: "unresolved", awaitingProof: true });
  });

  it("reconciles one reservation when asked to", async () => {
    const { ledger, signed } = setup();
    const target = signed(100n, 200);
    const other = signed(100n, 200);
    await reconcile(ledger, chain(300), options([], { only: target.id }));
    expect(state(ledger, target)).toMatchObject({ state: "released", releaseReason: "expired_unused" });
    expect(state(ledger, other)?.state).toBe("signed");
  });

  it("defers rows when the RPC fails mid-run and bounds the work per run", async () => {
    const { ledger, signed } = setup();
    signed(100n, 200);
    signed(100n, 200);
    signed(100n, 200);
    const fake = chain(300);
    const limited = await reconcile(ledger, fake, options([], { limit: 2 }));
    expect(limited).toMatchObject({ checked: 2, released: 2, deferred: 1 });
    fake.failing = true;
    const failed = await reconcile(ledger, fake, options());
    expect(failed).toMatchObject({ checked: 0, released: 0, deferred: 1 });
  });

  it("releases reservations abandoned before signing, and refuses without a ledger reading", async () => {
    const { ledger, spec } = setup();
    const stale = ledger.reserve(
      spec,
      { callId: "c", scheme: "exact", asset: usdc, payTo: seller, resource: "r", amount: 5n },
      T0,
    );
    const fresh = ledger.reserve(
      spec,
      { callId: "d", scheme: "exact", asset: usdc, payTo: seller, resource: "r", amount: 5n },
      T0 + 400_000,
    );
    const report = await reconcile(ledger, chain(1), options([], { now: () => T0 + 361_000 }));
    expect(report.released).toBe(1);
    expect(state(ledger, stale)).toMatchObject({ state: "released", releaseReason: "not_signed" });
    expect(state(ledger, fresh)?.state).toBe("reserved");

    const { ledger: other, signed } = setup();
    signed(1n, 5);
    const down: ChainReader = {
      latestLedger: () => Promise.reject(new Error("down")),
      findTransfers: () => Promise.resolve([]),
      transaction: () => Promise.resolve("missing"),
    };
    await expect(reconcile(other, down, options())).rejects.toMatchObject({ code: "rpc_unavailable" });
  });
});

describe("budget windows", () => {
  it.each([
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ])("keep an earlier window's unresolved payments pending after renewal (%s ledger)", (_name, create) => {
    const ledger = create();
    const spec: WindowSpec = {
      network: TESTNET,
      payer,
      name: "renewing",
      ttlMs: 60_000,
      caps: { [usdc]: { perCall: 1_000n, total: 1_000n, decimals: 7 } },
      autoRenew: true,
      autoCreate: true,
    };
    const request = { callId: "a", scheme: "exact" as const, asset: usdc, payTo: seller, resource: "r" };
    const row = ledger.reserve(spec, { ...request, amount: 800n }, T0);
    ledger.markSigned(row.id, { nonce: 7n, expirationLedger: 500, signedAtLedger: 480 }, T0);
    // The window renews while the authorization can still be settled.
    const renewed = ledger.window(spec, T0 + 61_000);
    expect(renewed.id).not.toBe(row.windowId);
    expect(ledger.usage(renewed.id).assets.get(usdc)).toEqual({ spent: 0n, pending: 800n });
    expect(() => ledger.reserve(spec, { ...request, callId: "b", amount: 300n }, T0 + 61_000)).toThrow(
      expect.objectContaining({ code: "payment_session_cap_exceeded" }) as Error,
    );
    // Once the chain shows it unused, the new window gets the budget back.
    ledger.release(row.id, "expired_unused", T0 + 62_000);
    expect(ledger.reserve(spec, { ...request, callId: "c", amount: 300n }, T0 + 62_000).state).toBe(
      "reserved",
    );
    ledger.close();
  });
});
