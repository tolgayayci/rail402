import { describe, expect, it } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { explainFailedTransaction, explainSimulation } from "@rail402.dev/facilitator";
import { inspectExactTransaction } from "@rail402.dev/stellar";
import {
  PASSPHRASE,
  address,
  buildTransfer,
  contractError,
  errorEvent,
  randomContractId,
} from "@rail402.dev/testkit";

async function transfer() {
  const built = await buildTransfer();
  const inspection = inspectExactTransaction(built.xdr, PASSPHRASE);
  if (!inspection.ok) throw new Error(inspection.code);
  return inspection.transfer;
}

const simulating = (simulation: unknown) =>
  ({ simulateTransaction: () => Promise.resolve(simulation) }) as unknown as rpc.Server;

describe("explainSimulation", () => {
  it("names archived ledger state when simulation asks for a restore", async () => {
    const server = simulating({
      latestLedger: 1,
      events: [],
      transactionData: {},
      minResourceFee: "1",
      restorePreamble: { transactionData: {}, minResourceFee: "1" },
    });
    expect(await explainSimulation(server, await transfer())).toMatchObject({
      code: "invalid_exact_stellar_payload_archived_state",
    });
  });

  it("returns nothing when the payment now simulates cleanly", async () => {
    const server = simulating({ latestLedger: 1, events: [], transactionData: {}, minResourceFee: "1" });
    expect(await explainSimulation(server, await transfer())).toBeUndefined();
  });
});

describe("explainFailedTransaction", () => {
  const asset = randomContractId();
  const from = Keypair.random().publicKey();
  const to = Keypair.random().publicKey();
  const failed = (events: xdr.DiagnosticEvent[]) =>
    ({
      status: rpc.Api.GetTransactionStatus.FAILED,
      ledger: 42,
      diagnosticEventsXdr: events,
      resultXdr: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result: xdr.TransactionResultResult.txFailed([]),
        ext: new xdr.TransactionResultExt(0),
      }),
    }) as unknown as rpc.Api.GetFailedTransactionResponse;

  it("names the on-chain cause of an included settlement that failed", () => {
    const missing = errorEvent({
      contract: asset,
      error: contractError(13),
      message: "trustline entry is missing for account",
      args: [address(to)],
    });
    expect(explainFailedTransaction(failed([missing]), { asset, from, to })).toMatchObject({
      code: "invalid_exact_stellar_payload_recipient_trustline_missing",
    });
  });

  it("falls back to invalid_transaction_state with the ledger and result code", () => {
    const explained = explainFailedTransaction(failed([]), { asset, from, to });
    expect(explained.code).toBe("invalid_transaction_state");
    expect(explained.reason).toContain("ledger 42");
    expect(explained.reason).toContain("txFailed");
  });
});
