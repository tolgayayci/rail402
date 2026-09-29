export interface UsageEvent {
  readonly subject: string;
  readonly network: string;
  readonly operation: "verify" | "settle";
  readonly outcome: string;
  readonly asset: string;
  readonly settledAmount: string;
}

export interface UsageRow {
  readonly day: string;
  readonly network: string;
  readonly operation: string;
  readonly outcome: string;
  readonly asset: string;
  readonly requests: number;
  readonly settledAmount: string;
}

/** Metering: usage counters per caller subject (an API key id, or "public" for keyless access). */
export interface UsageMeter {
  record(event: UsageEvent): Promise<void>;
  usage(subject: string, days: number): Promise<UsageRow[]>;
}

/** Process-local meter for STORE=memory. */
export class MemoryUsageMeter implements UsageMeter {
  private readonly rows = new Map<
    string,
    { -readonly [K in keyof UsageRow]: UsageRow[K] } & { subject: string }
  >();

  record(event: UsageEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const key = [event.subject, day, event.network, event.operation, event.outcome, event.asset].join(
      "\u0000",
    );
    const row = this.rows.get(key) ?? {
      subject: event.subject,
      day,
      network: event.network,
      operation: event.operation,
      outcome: event.outcome,
      asset: event.asset,
      requests: 0,
      settledAmount: "0",
    };
    row.requests += 1;
    row.settledAmount = String(BigInt(row.settledAmount) + BigInt(event.settledAmount));
    this.rows.set(key, row);
    return Promise.resolve();
  }

  usage(subject: string, days: number): Promise<UsageRow[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.subject === subject && row.day >= since)
        .map(({ subject: _subject, ...row }) => row),
    );
  }
}

/** Accrued service fee in US dollars for `settlements` successful settlements, as an exact decimal. */
export function accruedFee(perSettlementUsd: string, settlements: number): string {
  const [whole = "0", fraction = ""] = perSettlementUsd.split(".");
  const scale = fraction.length;
  const units = BigInt(whole + fraction) * BigInt(settlements);
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
