/**
 * The overview, search and account reads over a real Postgres: key ranges on the primary keys, the
 * daily and account totals the indexer keeps, and the pages they feed, with the reader's database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { RULES_VERSION, type SettlementRow } from "@rail402.dev/x402-index";
import {
  accountSample,
  accountsByPart,
  dailyByFacilitator,
  fees,
  paymentsByHashPrefix,
  topAccounts,
} from "../src/api/queries-a.ts";
import type { ComputedReport } from "../src/api/report.ts";
import type { ExplorerDatabase } from "../src/db.ts";
import { settlementToRow } from "../src/store.ts";
import { reportOf } from "./bazaar.ts";
import { dropDatabase, freshDatabase, testName } from "./database.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const NETWORK = exact.network;
const EPOCH = exact.epoch;
const DAY = 86_400_000;
const START = Date.parse(exact.closedAt);
const NOW = START + 3 * DAY;

/** Twelve payments from one buyer to one seller over three days, hashes starting "ab". */
const rows: SettlementRow[] = Array.from({ length: 12 }, (_, index) => ({
  ...exact,
  txHash: `ab${String(index).padStart(2, "0")}${"0".repeat(60)}`,
  innerHash: null,
  ledger: exact.ledger + index,
  txIndex: 0,
  closedAt: new Date(START + Math.floor(index / 4) * DAY).toISOString(),
}));

let db: Kysely<ExplorerDatabase>;

beforeAll(async () => {
  db = await freshDatabase("weba");
  await db.insertInto("settlements").values(rows.map(settlementToRow)).execute();
  await db
    .insertInto("indexed_ledgers")
    .values(
      rows.map((row) => ({
        network: NETWORK,
        epoch: EPOCH,
        ledger: row.ledger,
        status: "indexed",
        closed_at: row.closedAt,
        rules_version: RULES_VERSION,
      })),
    )
    .execute();
  const volume = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString();
  const total = (address: string, role: "payer" | "payTo") => ({
    network: NETWORK,
    epoch: EPOCH,
    address,
    role,
    asset_contract: exact.asset.contract,
    asset_code: exact.asset.code,
    asset_issuer: exact.asset.issuer,
    asset_verified: true,
    payments: rows.length,
    volume,
    first_at: rows[0]?.closedAt ?? exact.closedAt,
    last_at: rows.at(-1)?.closedAt ?? exact.closedAt,
  });
  await db
    .insertInto("account_totals")
    .values([total(exact.payer, "payer"), total(exact.payTo, "payTo")])
    .execute();
  await db
    .insertInto("seller_summaries")
    .values({ network: NETWORK, epoch: EPOCH, pay_to: exact.payTo, exact: rows.length, upto: 0, payers: 1 })
    .execute();
  await db
    .insertInto("daily_aggregates")
    .values(
      [0, 1, 2].map((offset) => ({
        network: NETWORK,
        epoch: EPOCH,
        day: new Date(START + offset * DAY).toISOString().slice(0, 10),
        tier: "rail402",
        facilitator_id: "rail402",
        scheme: "exact",
        asset_contract: exact.asset.contract,
        self_payment: false,
        payments: 4,
        volume: (BigInt(exact.amount) * 4n).toString(),
      })),
    )
    .execute();
}, 60_000);

afterAll(async () => {
  await db.destroy();
  await dropDatabase(testName("weba"));
});

describe("page reads", () => {
  it("finds payments by a hash prefix and accounts by either end", async () => {
    expect(await paymentsByHashPrefix(db, NETWORK, EPOCH, "ab0")).toHaveLength(10);
    expect((await paymentsByHashPrefix(db, NETWORK, EPOCH, "ab11")).map((row) => row.txHash)).toEqual([
      rows[11]?.txHash,
    ]);
    expect(await paymentsByHashPrefix(db, NETWORK, EPOCH, "ff")).toHaveLength(0);
    const prefix = await accountsByPart(db, NETWORK, EPOCH, exact.payer.slice(0, 5));
    expect(prefix.map((found) => found.address)).toContain(exact.payer);
    const suffix = await accountsByPart(db, NETWORK, EPOCH, exact.payTo.slice(-5));
    expect(suffix[0]).toEqual({ address: exact.payTo, received: 12, paid: 0 });
  });

  it("reads the daily totals, fees and top accounts", async () => {
    const day = (offset: number) => new Date(START + offset * DAY).toISOString().slice(0, 10);
    const daily = await dailyByFacilitator(db, NETWORK, EPOCH, day(0), day(1), exact.asset.contract);
    expect(daily.map((row) => [row.day, row.payments])).toEqual([
      [day(0), 4],
      [day(1), 4],
    ]);
    const paid = await fees(db, NETWORK, EPOCH, NOW);
    expect(paid.payments).toBe(12);
    expect(paid.sponsored).toBe(exact.fee.sponsored ? 12 : 0);
    const top = await topAccounts(db, NETWORK, EPOCH, "payTo", exact.asset.contract, NOW);
    expect(top[0]).toMatchObject({ address: exact.payTo, payments: 12, buyers: 1 });
  });

  it("samples an account's payments, and a fee payer's on its facilitator", async () => {
    const seller = await accountSample(db, NETWORK, EPOCH, exact.payTo, { sides: ["payer", "payTo"] });
    expect(seller.rows).toHaveLength(12);
    expect(seller.capped).toBe(false);
    expect(seller.first?.ledger).toBe(exact.ledger);
    const sponsor = await accountSample(db, NETWORK, EPOCH, exact.fee.payer, {
      sides: ["payer", "payTo"],
      feePaidFor: "rail402",
    });
    expect(sponsor.rows).toHaveLength(12);
  });
});

describe("pages over the database", () => {
  const report = { document: reportOf(rows) } as unknown as ComputedReport;
  const app = () =>
    testApp({ reader: Object.assign(new MemoryReader(rows), { database: db }), report, now: () => NOW });

  it("draws the overview's tiles, fees and top list from the database", async () => {
    const html = await (await app().request("/testnet?range=7d")).text();
    expect(html).toContain('<span class="dl"><b>+');
    expect(html).toContain(`href="/testnet/account/${exact.payTo}"`);
    expect(html).toContain("1 buyer<");
    expect(html).toContain("up to date");
    expect(html.match(/class="col"/g)).toHaveLength(7);
  });

  it("pages an account's payments ten at a time and names its counterparties", async () => {
    const html = await (await app().request(`/testnet/account/${exact.payTo}`)).text();
    expect(html).toContain("Top buyers");
    expect(html).toContain("latest 1–10 of 12");
    expect(html).toContain(`href="/testnet/account/${exact.payTo}?page=2#payments"`);
    const second = await (await app().request(`/testnet/account/${exact.payTo}?page=2`)).text();
    expect(second).toContain("latest 11–12 of 12");
    const sponsor = await (await app().request(`/testnet/account/${exact.fee.payer}`)).text();
    expect(sponsor).toContain("Payments it paid the fee for");
    expect(sponsor).toContain(`/testnet/tx/${rows[11]?.txHash ?? ""}`);
  });

  it("finds payments and accounts from the live search", async () => {
    const answer = (await (await app().request("/testnet/suggest?q=ab0")).json()) as {
      groups: { label: string; n: number; items: unknown[] }[];
    };
    expect(answer.groups.find((group) => group.label === "Payments")).toMatchObject({ n: 10 });
    const page = await (await app().request(`/testnet/search?q=${exact.payTo.slice(-6)}`)).text();
    expect(page).toContain(`href="/testnet/account/${exact.payTo}"`);
  });
});
