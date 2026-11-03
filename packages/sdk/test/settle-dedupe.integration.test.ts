/**
 * The takeover cases of settle-dedupe.test.ts with the service's settlements in Postgres
 * (docker compose up -d postgres): each test gets a schema of its own.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withSettleDedupe } from "@rail402.dev/sdk/seller";
import { PostgresSettlementLedger, createDatabase, migrate } from "../../store-postgres/src/index.ts";
import { closeAll, send, signedPayment, sleep, startSeller, startService } from "./settle-harness.ts";

const URL = process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const opened: { readonly db: ReturnType<typeof createDatabase>; readonly schema: string }[] = [];

async function postgresLedger(): Promise<PostgresSettlementLedger> {
  // Not test_…: the store suites drop every test_ schema when they finish.
  const schema = `settle_e2e_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  await admin.schema.createSchema(schema).execute();
  await admin.destroy();
  const db = createDatabase({ connectionString: URL, schema, maxConnections: 5 });
  await migrate(db);
  opened.push({ db, schema });
  return new PostgresSettlementLedger(db);
}

afterEach(closeAll);

afterAll(async () => {
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  for (const { db, schema } of opened.splice(0)) {
    await db.destroy();
    await admin.schema.dropSchema(schema).cascade().execute();
  }
  await admin.destroy();
});

describe("serving each payment once through Rail402, with settlements in Postgres", () => {
  const wrapped = (url: string) => startSeller(withSettleDedupe(new HTTPFacilitatorClient({ url })));

  it("never serves a payment again whose first claim was taken over by another seller", async () => {
    const rail402 = await startService({ claimTtlMs: 400, ledger: await postgresLedger() });
    const a = await wrapped(rail402.url);
    const b = await wrapped(rail402.url);
    const payment = await signedPayment(a.base);
    rail402.stallNext();
    rail402.fail("cut");
    expect((await send(a.base, payment)).paid).toBe(false);
    // Past the claim's time to live.
    await rail402.claimed();
    await sleep(600);
    expect(await send(b.base, payment)).toEqual({ status: 200, paid: true });
    expect(await send(a.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(a.served() + b.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });

  it("never serves a payment again that waited on a claim another seller then took over", async () => {
    const rail402 = await startService({ claimTtlMs: 400, ledger: await postgresLedger() });
    const a = await wrapped(rail402.url);
    const b = await wrapped(rail402.url);
    const payment = await signedPayment(a.base);
    rail402.stallNext();
    rail402.fail("cut");
    expect((await send(a.base, payment)).paid).toBe(false);
    await rail402.claimed();
    const waiting = send(a.base, payment);
    await sleep(600);
    expect(await send(b.base, payment)).toEqual({ status: 200, paid: true });
    expect(await waiting).toMatchObject({ status: 402, paid: false });
    expect(a.served() + b.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });
});
