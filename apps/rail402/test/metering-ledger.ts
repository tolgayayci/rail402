import { settleFailed, settleSucceeded, type SettlementLedger } from "@rail402.dev/facilitator";

let sequence = 0;

/**
 * A settlement as the engine leaves it: claimed for `caller` at `serviceFeeUsd`, its envelope recorded
 * with `fee` charged, and finished `state` by `settledBy`.
 */
export async function settled(
  ledger: SettlementLedger,
  options: {
    readonly network?: string;
    readonly caller: string;
    readonly serviceFeeUsd: string;
    readonly fee: bigint;
    readonly state?: "succeeded" | "failed";
    readonly settledBy?: "rail402" | "third_party";
  },
): Promise<void> {
  const network = options.network ?? "stellar:testnet";
  const n = ++sequence;
  const tag = `${String(Date.now())}${String(n)}`;
  const { record } = await ledger.claim(
    { network, payer: `GPAYER${tag}`, nonce: String(n) },
    { payloadHash: `p${tag}`, requestHash: `r${tag}` },
    "owner",
    60_000,
    { caller: options.caller, serviceFeeUsd: options.serviceFeeUsd },
  );
  const hash = BigInt(tag).toString(16).padStart(64, "0");
  await ledger.recordEnvelope(record.id, "owner", {
    channel: "GCHANNEL",
    transactionHash: hash,
    innerTransactionHash: `1${hash.slice(1)}`,
    envelopeXdr: "AAAA",
    validUntil: 1,
    maxFeeStroops: "100000",
  });
  const state = options.state ?? "succeeded";
  await ledger.finish(
    record.id,
    state,
    state === "succeeded"
      ? settleSucceeded(network, hash, "GPAYER")
      : settleFailed({ code: "invalid_transaction_state", network }),
    { feeChargedStroops: options.fee, settledBy: options.settledBy ?? "rail402" },
  );
}
