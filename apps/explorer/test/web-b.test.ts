/**
 * The payments list, the payment page, the report page and the error page: numbered pages over bounded
 * reads, the account filter, the same buyer and seller, the per-facilitator chart, and errors that say
 * where to go next.
 */
import { Keypair, MuxedAccount, Account } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { IndexNetwork, SettlementRow } from "@rail402.dev/x402-index";
import type { Position } from "../src/api/paging.ts";
import { COUNT_CAP, type DailyFacilitator, type PaymentFilterB, type ReadsB } from "../src/api/queries-b.ts";
import type { ComputedReport } from "../src/api/report.ts";
import { reportOf } from "./bazaar.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const x402org = rowOf(TRANSACTIONS["x402org-exact-1"]);
const buyer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x51)).publicKey();

/** `count` payments of `base` from `payer`, one ledger apart, newest last. */
const series = (base: SettlementRow, count: number, payer = base.payer, from = 9_000_000): SettlementRow[] =>
  Array.from({ length: count }, (_, i) => ({
    ...base,
    txHash: (from + i).toString(16).padStart(64, "0"),
    innerHash: null,
    ledger: from + i,
    payer,
    closedAt: new Date(Date.parse(base.closedAt) + i * 5_000).toISOString(),
  }));

/** The memory reader with the numbered reads, filtering its rows as the database reads do. */
class MemoryReaderB extends MemoryReader implements ReadsB {
  #select(filter: PaymentFilterB): SettlementRow[] {
    return this.rows.filter((row) => {
      const tier = row.attribution.tier;
      if (filter.facilitator !== undefined) {
        if (row.attribution.facilitatorId !== filter.facilitator) return false;
      } else if (filter.shaped === true ? tier !== "shaped" : tier !== "rail402" && tier !== "facilitator") {
        return false;
      }
      if (filter.scheme !== undefined && row.scheme !== filter.scheme) return false;
      if (filter.asset !== undefined && row.asset.contract !== filter.asset) return false;
      if (filter.fromLedger !== undefined && row.ledger < filter.fromLedger) return false;
      if (filter.account !== undefined) {
        if (filter.muxedId !== undefined)
          return row.payTo === filter.account && row.payToMuxedId === filter.muxedId;
        return row.payer === filter.account || row.payTo === filter.account;
      }
      return true;
    });
  }
  paymentsAt(_network: IndexNetwork, _epoch: string, filter: PaymentFilterB, offset: number, limit: number) {
    return Promise.resolve(this.#select(filter).slice(offset, offset + limit));
  }
  paymentsCount(_network: IndexNetwork, _epoch: string, filter: PaymentFilterB) {
    return Promise.resolve(Math.min(COUNT_CAP + 1, this.#select(filter).length));
  }
  sameParties(
    _network: IndexNetwork,
    _epoch: string,
    payer: string,
    payTo: string,
    around: Position,
    each: number,
  ) {
    const pair = this.rows.filter((row) => row.payer === payer && row.payTo === payTo);
    const newer = pair.filter((row) => row.ledger > around.ledger).slice(-each);
    const older = pair.filter((row) => row.ledger < around.ledger).slice(0, each);
    return Promise.resolve([...newer, ...older]);
  }
  dailyByFacilitator(): Promise<readonly DailyFacilitator[]> {
    const days = new Map<string, number>();
    for (const row of this.rows) {
      if (row.attribution.facilitatorId === null || row.attribution.tier === "shaped") continue;
      const key = `${row.closedAt.slice(0, 10)}|${row.attribution.facilitatorId}`;
      days.set(key, (days.get(key) ?? 0) + 1);
    }
    return Promise.resolve(
      [...days].map(([key, payments]) => {
        const [day = "", facilitatorId = ""] = key.split("|");
        return { day, facilitatorId, payments };
      }),
    );
  }
}

const rows = [...series(exact, 25, buyer), x402org];
const appB = (list: readonly SettlementRow[] = rows, report?: ComputedReport) =>
  testApp({ reader: new MemoryReaderB(list), ...(report === undefined ? {} : { report }) });
const text = async (app: ReturnType<typeof appB>, path: string, status = 200) => {
  const response = await app.request(path);
  expect(response.status, path).toBe(status);
  return response.text();
};
const linked = (html: string) => [...html.matchAll(/href="\/testnet\/tx\/([0-9a-f]{64})"/g)].map((m) => m[1]);

describe("the payments list", () => {
  it("numbers its pages, ten rows each, and shows a page past the end as the last one", async () => {
    const app = appB();
    const first = await text(app, "/testnet/payments");
    expect(first).toContain(">26 payments<");
    expect(first).toContain("1–10 of 26");
    expect(linked(first)).toHaveLength(10);
    expect(first).toContain('href="/testnet/payments?page=3"');
    const third = await text(app, "/testnet/payments?page=3");
    expect(linked(third)).toHaveLength(6);
    expect(await text(app, "/testnet/payments?page=99")).toContain("21–26 of 26");
    // An old cursor link still opens the list.
    expect(linked(await text(app, "/testnet/payments?cursor=1-1-0000000000"))).toHaveLength(10);
    for (const bad of ["page=0", "page=1001", "page=two", "colour=red", "offset=5", "account=nope"])
      await text(app, `/testnet/payments?${bad}`, 400);
  });

  it("filters by account, keeps the other filters in its links and in the download", async () => {
    const app = appB();
    const mine = await text(app, `/testnet/payments?account=${x402org.payer}&scheme=exact`);
    expect(linked(mine)).toEqual([x402org.txHash]);
    expect(mine).toContain(`href="/testnet/payments.csv?scheme=exact&amp;account=${x402org.payer}"`);
    expect(mine).toContain(`href="/testnet/payments?scheme=upto&amp;account=${x402org.payer}"`);
    expect(mine).toContain(`value="${x402org.payer}"`);
    const csv = await text(app, `/testnet/payments.csv?account=${buyer}`);
    expect(csv.trim().split("\r\n")).toHaveLength(26);
    expect(csv).not.toContain(x402org.txHash);
    // A muxed address lists what that muxed id received only.
    const muxedRow = { ...x402org, txHash: "f".repeat(64), payToMuxedId: "7" };
    const muxed = new MuxedAccount(new Account(x402org.payTo, "0"), "7").accountId();
    const html = await text(appB([...rows, muxedRow]), `/testnet/payments?account=${muxed}`);
    expect(linked(html)).toEqual([muxedRow.txHash]);
  });

  it("keeps the payments apart that no registered facilitator settled", async () => {
    const shaped = {
      ...x402org,
      txHash: "a".repeat(64),
      attribution: { ...x402org.attribution, tier: "shaped" as const, facilitatorId: null },
    };
    const app = appB([...rows, shaped]);
    expect(linked(await text(app, "/testnet/payments"))).not.toContain(shaped.txHash);
    const apart = await text(app, "/testnet/payments?facilitator=shaped");
    expect(linked(apart)).toEqual([shaped.txHash]);
    expect(apart).toContain("not registered · never in totals");
  });
});

describe("the payment page", () => {
  it("lists the same buyer and seller around the payment and links the buyer's list", async () => {
    const app = appB();
    const middle = rows[12];
    if (middle === undefined) throw new Error("no row");
    const html = await text(app, `/testnet/tx/${middle.txHash}`);
    expect(html).toContain("Same buyer and seller");
    const around = linked(html.slice(html.indexOf("Same buyer and seller")));
    expect(around).toHaveLength(5);
    expect(around).not.toContain(middle.txHash);
    expect(html).toContain(`href="/testnet/payments?account=${buyer}">All 25 →`);
    expect(html).toContain("s later");
    expect(html).toContain("s earlier");
    expect(html).toContain(">7 of 7<");
    expect(html).not.toContain('<li class="no">');
  });

  it("crosses out the facilitator check of a payment no registered facilitator settled", async () => {
    const shaped = {
      ...x402org,
      attribution: { ...x402org.attribution, tier: "shaped" as const, facilitatorId: null },
    };
    const twin = { ...shaped, txHash: "b".repeat(64), ledger: shaped.ledger + 1 };
    const html = await text(appB([shaped, twin]), `/testnet/tx/${shaped.txHash}`);
    expect(html).toContain("kept apart");
    expect(html).toContain('<li class="no">');
    expect(html).toContain(">6 of 7<");
    expect(html).toContain(`href="/testnet/payments?account=${shaped.payer}&amp;facilitator=shaped"`);
  });

  it("answers an unknown hash with stellar.expert and the other network", async () => {
    const app = testApp({ reader: new MemoryReaderB(rows), pubnet: true });
    const hash = "0".repeat(64);
    const html = await text(app, `/testnet/tx/${hash}`, 404);
    expect(html).toContain(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(html).toContain(`href="/tx/${hash}"`);
    expect(html).toContain("not found · 404");
    expect(html).not.toContain("explorer_not_found");
  });
});

describe("the report page", () => {
  const report = { document: reportOf(rows) } as unknown as ComputedReport;

  it("stacks registered payments per day by facilitator, and takes 7d, 30d or all", async () => {
    const app = appB(rows, report);
    const html = await text(app, "/testnet/ecosystem?range=all");
    expect(html).toContain('<i class="c-r4"></i>Rail402');
    expect(html).toContain('<i class="c-reg"></i>x402.org');
    expect(html).toContain('aria-current="true">All<');
    expect(html).toContain('id="fac-rail402"');
    expect(html).toContain('id="fac-x402-org"');
    await text(app, "/testnet/ecosystem?range=1y", 400);
    await text(app, "/testnet/ecosystem?colour=red", 400);
    // Without the index's daily totals the chart falls back to the report's, as one series.
    const plain = testApp({ reader: new MemoryReader(rows), report });
    expect(await text(plain, "/testnet/ecosystem")).not.toContain(
      '<i class="c-reg"></i>x402.org</span></div>',
    );
  });

  it("says there is no report yet in one card", async () => {
    const html = await text(appB(rows), "/testnet/ecosystem");
    expect(html).toContain("No report yet");
    expect(html).not.toContain("Download");
  });
});

describe("the methodology page", () => {
  it("moved to the docs", async () => {
    const response = await appB().request("/methodology");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://docs.rail402.dev/explorer");
  });
});
