/**
 * Secret canary scan of the buyer on the private Stellar network: the canary account pays stock
 * sellers through Rail402 with the unmodified upstream client signing through the guard, across a
 * settled payment and its replay, a refusal before signing, a resource that fails after payment, a
 * failed settlement, a redirect after payment, paid MCP tools and a resource and a tool that echo the
 * payment into their answer. Results, errors, events, the
 * budget, the SQLite ledger files and what the decoy origin received must hold no secret.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, SecretScanner } from "@rail402.dev/testkit";
import { KeyHolder, createBuyer, type Buyer, type PaymentEvent } from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";
import { decoyUnpaid, startSecretWorld, type SecretWorld } from "./secret-fixture.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("secret canary scan of the buyer on the local network", () => {
  let world: SecretWorld;
  let scanner: SecretScanner;
  let buyer: Buyer;
  let ledger: SqliteSpendLedger;
  let directory: string;
  const events: PaymentEvent[] = [];

  const outcome = async (name: string, run: () => Promise<unknown>): Promise<unknown> => {
    try {
      const result = await run();
      scanner.capture(`result ${name}`, result);
      return result;
    } catch (error) {
      scanner.capture(`error ${name}`, error);
      return error;
    }
  };
  const cap = { amount: "0.05", asset: "TUSD" };

  beforeAll(async () => {
    world = await startSecretWorld(net);
    world.proxy.trust();
    scanner = new SecretScanner(world.payer.secret());
    directory = mkdtempSync(join(tmpdir(), "rail402-secrets-it-"));
    ledger = new SqliteSpendLedger(join(directory, "ledger.sqlite"));
    buyer = await createBuyer({
      network: TESTNET,
      signer: scanner.tap(KeyHolder.fromSecret(world.payer.secret())),
      rpcUrl: world.proxy.url,
      bazaarUrl: world.rail402.url,
      facilitatorUrl: world.rail402.url,
      ledger,
      policy: {
        assets: [{ asset: world.asset.sac, symbol: "TUSD", decimals: 7, perCall: "0.5", sessionTotal: "2" }],
      },
      egress: { schemes: ["http:"], ports: [...world.ports], allowPrivateNetwork: "loopback" },
      onEvent: (event) => events.push(event),
    });
  });

  afterAll(async () => {
    await buyer.close();
    ledger.close();
    await world.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("pays through every outcome", async () => {
    const http = (path: string, key?: string) =>
      buyer.pay(
        { kind: "http", url: `${world.sellerUrl}${path}`, query: { city: "Ankara" } },
        { maxAmount: cap, ...(key === undefined ? {} : { idempotencyKey: key }) },
      );
    const paid = await outcome("paid", () => http("/weather", "canary-sdk-1"));
    expect(paid).toMatchObject({ paid: true, payment: { status: "settled", verifiedOnChain: true } });
    expect(await outcome("replayed", () => http("/weather", "canary-sdk-1"))).toMatchObject({
      replayed: true,
    });
    expect(await outcome("cap exceeded", () => http("/premium"))).toMatchObject({
      code: "payment_per_call_cap_exceeded",
    });
    expect(await outcome("resource failed", () => http("/broken"))).toMatchObject({
      code: "payment_settlement_unconfirmed",
    });
    expect(await outcome("settlement failed", () => http("/unsettled"))).toMatchObject({
      code: "payment_rejected",
      paid: "not_settled",
    });
    expect(await outcome("paid with an echo", () => http("/echo", "canary-sdk-echo"))).toMatchObject({
      paid: true,
      payment: { status: "settled" },
    });
    await outcome("echo replayed", () => http("/echo", "canary-sdk-echo"));
    expect(await outcome("redirect after paying", () => http("/redirect"))).toMatchObject({
      code: "payment_redirect_after_payment",
    });
    const tool = await outcome("mcp paid", () =>
      buyer.pay(
        { kind: "mcp", url: world.mcpSeller.url, toolName: "forecast", arguments: { city: "Rize" } },
        { maxAmount: cap },
      ),
    );
    expect(tool).toMatchObject({ paid: true, payment: { status: "settled" } });
    expect(
      await outcome("mcp paid with an echo", () =>
        buyer.pay({ kind: "mcp", url: world.mcpSeller.url, toolName: "echo-payment" }, { maxAmount: cap }),
      ),
    ).toMatchObject({ paid: true, payment: { status: "settled" } });
    await outcome("mcp tool failed", () =>
      buyer.pay({ kind: "mcp", url: world.mcpSeller.url, toolName: "broken" }, { maxAmount: cap }),
    );
    const hash = (paid as { payment: { transaction: string } }).payment.transaction;
    await outcome("inspect", () => buyer.inspectTransaction(hash));
    await outcome("reconcile", () => buyer.reconcile());
    await outcome("budget", () => buyer.budget());
  });

  it("leaks nothing, and the payment reached only the paid origin", () => {
    expect(world.paymentHeaders.length).toBeGreaterThanOrEqual(4);
    expect(world.decoy.requests).toHaveLength(0);
    expect(decoyUnpaid(world.decoy)).toBe(true);
    world.addReceivedPayments(scanner);
    scanner.capture("events", events);
    const file = join(directory, "ledger.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(file + suffix)) scanner.capture(`ledger file${suffix}`, readFileSync(file + suffix));
    }
    expect(scanner.needles).toBeGreaterThan(40);
    scanner.assertClean();
  });
});
