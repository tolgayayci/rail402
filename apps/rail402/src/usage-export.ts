import type { Kysely } from "kysely";
import { PostgresSettlementLedger, PostgresUsageMeter, type Database } from "@rail402.dev/store-postgres";

/** One caller's metered usage on one network and day: the basis of off-chain billing. */
export interface UsageExportRow {
  readonly day: string;
  /** `key:<id>` or `public`. */
  readonly caller: string;
  readonly network: string;
  /** Successful settlements Rail402 landed. */
  readonly settlements: number;
  /** Volume moved, per asset contract, in base units. */
  readonly amounts: readonly { readonly asset: string; readonly amount: string }[];
  /** Fees the sponsor was charged for the caller's transactions, in stroops. */
  readonly sponsoredFeeStroops: string;
  /** Service fees accrued at the price recorded with each settlement, in US dollars. */
  readonly serviceFeeUsd: string;
}

/**
 * Usage per caller × network × day for the days `from`..`to` (inclusive, `YYYY-MM-DD`): settlements,
 * sponsored fees and service fees from the settlement ledger, volume per asset from the daily meter.
 */
export async function exportUsage(
  db: Kysely<Database>,
  options: { readonly from: string; readonly to: string; readonly caller?: string },
): Promise<UsageExportRow[]> {
  const start = new Date(`${options.from}T00:00:00Z`);
  const end = new Date(new Date(`${options.to}T00:00:00Z`).getTime() + 86_400_000);
  const [ledger, settled] = await Promise.all([
    new PostgresSettlementLedger(db).usageSince(options.caller, start, end),
    new PostgresUsageMeter(db).settledBetween(options.from, options.to, options.caller),
  ]);
  const rows = new Map<string, { -readonly [K in keyof UsageExportRow]: UsageExportRow[K] }>();
  const row = (day: string, caller: string, network: string) => {
    const id = `${day}\u0000${caller}\u0000${network}`;
    let entry = rows.get(id);
    if (entry === undefined) {
      entry = {
        day,
        caller,
        network,
        settlements: 0,
        amounts: [],
        sponsoredFeeStroops: "0",
        serviceFeeUsd: "0.0000000",
      };
      rows.set(id, entry);
    }
    return entry;
  };
  for (const entry of ledger) {
    const target = row(entry.day, entry.caller, entry.network);
    target.settlements = entry.succeeded;
    target.sponsoredFeeStroops = entry.sponsoredFeeStroops.toString();
    target.serviceFeeUsd = entry.serviceFeeUsd;
  }
  for (const entry of settled) {
    const target = row(entry.day, entry.subject, entry.network);
    target.amounts = [...target.amounts, { asset: entry.asset, amount: entry.settledAmount }];
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) || a.caller.localeCompare(b.caller) || a.network.localeCompare(b.network),
  );
}

/** The rows as CSV with a header line; amounts as `asset=amount` joined by `;`. */
export function usageCsv(rows: readonly UsageExportRow[]): string {
  const lines = ["day,caller,network,settlements,amounts,sponsored_fee_stroops,service_fee_usd"];
  for (const entry of rows) {
    const amounts = entry.amounts.map((item) => `${item.asset}=${item.amount}`).join(";");
    lines.push(
      [
        entry.day,
        entry.caller,
        entry.network,
        entry.settlements,
        amounts,
        entry.sponsoredFeeStroops,
        entry.serviceFeeUsd,
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
