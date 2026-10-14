/**
 * Child process for the multi-process ledger test: opens the shared SQLite ledger and tries to reserve
 * `count` payments of `amount`, starting at `startAt` so every process competes at once.
 * Prints `{ reserved, refused }` as JSON.
 */
import { TESTNET, USDC } from "@rail402.dev/stellar";
import { isPaymentError } from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";

const [path = "", payer = "", count = "0", amount = "0", total = "0", startAt = "0"] = process.argv.slice(2);
const usdc = USDC[TESTNET].contract;
const ledger = new SqliteSpendLedger(path);
const spec = {
  network: TESTNET,
  payer,
  name: "default",
  ttlMs: 3_600_000,
  caps: { [usdc]: { perCall: BigInt(amount), total: BigInt(total), decimals: 7 } },
  autoRenew: true,
  autoCreate: true,
} as const;

while (Date.now() < Number(startAt)) {
  // Spin until the common start time.
}

let reserved = 0;
let refused = 0;
for (let index = 0; index < Number(count); index++) {
  try {
    ledger.reserve(spec, {
      callId: `${process.pid}-${index}`,
      scheme: "exact",
      asset: usdc,
      payTo: payer,
      resource: "concurrency",
      amount: BigInt(amount),
    });
    reserved++;
  } catch (error) {
    if (isPaymentError(error) && error.code === "payment_session_cap_exceeded") refused++;
    else throw error;
  }
}
ledger.close();
process.stdout.write(JSON.stringify({ reserved, refused }));
