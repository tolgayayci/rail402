import { describe, expect, it } from "vitest";
import { Address, Keypair, SorobanDataBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
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

describe("explainSimulation for a custom SEP-41 token", () => {
  /** A server whose enforcing simulation fails with a token error, and whose balance read answers `balance`. */
  const token = (balance: bigint | "fails", assetError = contractError(100)) =>
    ({
      simulateTransaction: (transaction: { operations: { func?: xdr.HostFunction }[] }) => {
        const call = transaction.operations[0]?.func?.invokeContract();
        if (call?.functionName().toString() === "balance") {
          if (balance === "fails") return Promise.reject(new Error("rpc down"));
          return Promise.resolve({
            latestLedger: 1,
            events: [],
            transactionData: new SorobanDataBuilder(),
            minResourceFee: "1",
            result: { auth: [], retval: nativeToScVal(balance, { type: "i128" }) },
          });
        }
        return Promise.resolve({
          latestLedger: 1,
          events: [errorEvent({ contract: call ? addressOf(call) : undefined, error: assetError })],
          error: "HostError: Error(Contract, #100)",
        });
      },
    }) as unknown as rpc.Server;
  const addressOf = (call: xdr.InvokeContractArgs) =>
    Address.fromScAddress(call.contractAddress()).toString();

  it("is insufficient_funds when the payer's balance is below the amount", async () => {
    const payment = await transfer();
    const explained = await explainSimulation(token(payment.amount - 1n), payment, "sep41");
    expect(explained?.code).toBe("insufficient_funds");
    expect(explained?.reason).toContain(`less than the amount ${payment.amount.toString()}`);
  });

  it("is token_rejected with the error number when the balance covers the amount", async () => {
    const payment = await transfer();
    expect(await explainSimulation(token(payment.amount), payment, "sep41")).toEqual({
      code: "invalid_exact_stellar_payload_token_rejected",
      reason: "The token contract rejected the transfer with error #100.",
    });
  });

  it("stays token_rejected when the balance cannot be read", async () => {
    const payment = await transfer();
    expect((await explainSimulation(token("fails"), payment, "sep41"))?.code).toBe(
      "invalid_exact_stellar_payload_token_rejected",
    );
  });

  it("reads no balance for a Stellar Asset Contract, whose errors are named by number", async () => {
    const payment = await transfer();
    expect((await explainSimulation(token("fails", contractError(10)), payment, "sac"))?.code).toBe(
      "insufficient_funds",
    );
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
    expect(explainFailedTransaction(failed([missing]), { asset, from, to }, "sac")).toMatchObject({
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
