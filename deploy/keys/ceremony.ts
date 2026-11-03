/**
 * Key custody for a facilitator's fee sponsor on a real-funds network: a cold treasury account that the
 * operator keeps offline (a hardware wallet) becomes a high-weight signer of the hot sponsor, so that a
 * leaked hot seed can spend the hot balance but cannot remove the cold signer, change thresholds or merge
 * the account. Thresholds follow Stellar's operation levels: a fee bump needs the fee account's low
 * threshold; create-account, payment and invoke-host-function need medium; set-options for signers or
 * thresholds and account-merge need high.
 *
 * Every builder here returns an unsigned or locally signed transaction and a review summary. Nothing in
 * this module submits to a network; `deploy/keys/cli.ts` submits only on the testnet.
 */
import { createHash } from "node:crypto";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

export type CustodyNetwork = "testnet" | "pubnet";

export const PASSPHRASES: Readonly<Record<CustodyNetwork, string>> = {
  testnet: Networks.TESTNET,
  pubnet: Networks.PUBLIC,
};

/** Weights and thresholds: the hot key meets low and medium, only the cold key meets high. */
export const SIGNER_PLAN = {
  hotWeight: 10,
  coldWeight: 20,
  low: 1,
  medium: 10,
  high: 20,
} as const;

export interface SignerSet {
  readonly masterWeight: number;
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  /** Additional signers: ed25519 public key → weight. */
  readonly signers: Readonly<Record<string, number>>;
}

/** Why a sponsor's signer set does not give the cold key sole control of the account; empty when it does. */
export function signerSetProblems(set: SignerSet, cold: string): string[] {
  const problems: string[] = [];
  const coldWeight = set.signers[cold] ?? 0;
  if (coldWeight === 0) problems.push("the cold treasury key is not a signer");
  else if (coldWeight < set.high)
    problems.push(`the cold key's weight ${coldWeight} is below the high threshold ${set.high}`);
  if (set.masterWeight >= set.high) problems.push("the hot key alone meets the high threshold");
  if (set.masterWeight < set.medium)
    problems.push("the hot key cannot meet the medium threshold it needs to sponsor");
  if (set.masterWeight < set.low)
    problems.push("the hot key cannot meet the low threshold it needs to fee-bump");
  if (set.low < 1) problems.push("the low threshold is 0, so any signer weight passes it");
  const others = Object.entries(set.signers).filter(([key, weight]) => key !== cold && weight > 0);
  for (const [key] of others) problems.push(`an unexpected signer ${key} holds weight`);
  return problems;
}

/** The SHA-256 a hardware wallet shows for a transaction, as hex. */
export function transactionHash(tx: Transaction): string {
  return tx.hash().toString("hex");
}

export interface Review {
  readonly network: CustodyNetwork;
  readonly passphrase: string;
  readonly source: string;
  readonly hash: string;
  readonly operations: readonly string[];
}

export function reviewOf(tx: Transaction, network: CustodyNetwork): Review {
  return {
    network,
    passphrase: PASSPHRASES[network],
    source: tx.source,
    hash: transactionHash(tx),
    operations: tx.operations.map((op) => {
      const text = describeOperation(op);
      return op.source !== undefined && op.source !== tx.source ? `${text} (on account ${op.source})` : text;
    }),
  };
}

function describeOperation(op: Transaction["operations"][number]): string {
  if (op.type === "payment") {
    return `payment of ${op.amount} ${op.asset.isNative() ? "XLM" : op.asset.getCode()} to ${op.destination}`;
  }
  if (op.type !== "setOptions") return op.type;
  const parts: string[] = [];
  if (op.signer !== undefined && "ed25519PublicKey" in op.signer) {
    parts.push(`signer ${op.signer.ed25519PublicKey} weight ${op.signer.weight ?? 0}`);
  }
  if (typeof op.masterWeight === "number") parts.push(`master weight ${op.masterWeight}`);
  if (typeof op.lowThreshold === "number") parts.push(`low ${op.lowThreshold}`);
  if (typeof op.medThreshold === "number") parts.push(`medium ${op.medThreshold}`);
  if (typeof op.highThreshold === "number") parts.push(`high ${op.highThreshold}`);
  return `set options: ${parts.join(", ")}`;
}

/** The review a person reads before signing, one fact per line. */
export function reviewSummary(review: Review): string {
  return [
    `network     ${review.network} (${review.passphrase})`,
    `source      ${review.source}`,
    ...review.operations.map((line, index) => `operation ${index + 1} ${line}`),
    `tx hash     ${review.hash}`,
  ].join("\n");
}

function requireAccount(label: string, value: string): void {
  if (!StrKey.isValidEd25519PublicKey(value)) throw new Error(`${label} must be a G… account address`);
}

export interface SequencedAccount {
  readonly id: string;
  /** The account's current sequence number, as Horizon or RPC reports it. */
  readonly sequence: string;
}

/**
 * The one-time transaction that adds the cold signer and sets the thresholds. Its source is the
 * sponsor and, before it applies, the sponsor's own key is the only signer, so the hot key signs it.
 */
export function buildSignerSetup(
  sponsor: SequencedAccount,
  cold: string,
  network: CustodyNetwork,
  fee = "1000",
): Transaction {
  requireAccount("the sponsor", sponsor.id);
  requireAccount("the cold treasury", cold);
  if (cold === sponsor.id) throw new Error("the cold treasury must be a different account from the sponsor");
  return new TransactionBuilder(new Account(sponsor.id, sponsor.sequence), {
    fee,
    networkPassphrase: PASSPHRASES[network],
  })
    .addOperation(
      Operation.setOptions({ signer: { ed25519PublicKey: cold, weight: SIGNER_PLAN.coldWeight } }),
    )
    .addOperation(
      Operation.setOptions({
        masterWeight: SIGNER_PLAN.hotWeight,
        lowThreshold: SIGNER_PLAN.low,
        medThreshold: SIGNER_PLAN.medium,
        highThreshold: SIGNER_PLAN.high,
      }),
    )
    .setTimeout(600)
    .build();
}

/**
 * A top-up of the hot sponsor from the cold treasury. The destination must be the sponsor address that
 * was recorded when the sponsor was created, so a mistyped or substituted address is refused before the
 * transaction exists.
 */
export function buildTopUp(
  treasury: SequencedAccount,
  destination: string,
  recordedSponsor: string,
  amountXlm: string,
  network: CustodyNetwork,
  fee = "1000",
): Transaction {
  requireAccount("the treasury", treasury.id);
  requireAccount("the destination", destination);
  if (destination !== recordedSponsor) {
    throw new Error(`the destination ${destination} is not the recorded sponsor ${recordedSponsor}`);
  }
  if (!/^\d{1,9}(\.\d{1,7})?$/.test(amountXlm) || Number(amountXlm) <= 0) {
    throw new Error("the amount must be a positive XLM amount with at most 7 decimals");
  }
  return new TransactionBuilder(new Account(treasury.id, treasury.sequence), {
    fee,
    networkPassphrase: PASSPHRASES[network],
  })
    .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: amountXlm }))
    .setTimeout(600)
    .build();
}

/**
 * The leak response's first transaction: the cold key locks the leaked hot key out of the sponsor by
 * setting its master weight to 0, a high-threshold change only the cold key can sign. The cold treasury
 * is the transaction's source and fee payer, and the set-options operation names the sponsor as its own
 * source, so the freeze uses no sequence number of the sponsor: whoever holds the leaked seed can spend
 * the hot balance until it applies, but cannot make it fail by using or bumping the sponsor's sequence.
 * From then on the hot seed can neither pay, sponsor nor fee-bump from the account, and the cold key
 * (weight 20, above every threshold) controls it alone. Unsigned: the cold key signs it on its hardware
 * wallet. The sweep is a separate transaction after it ({@link buildSweep}), so a balance the attacker
 * spent first cannot make the freeze fail.
 */
export function buildFreeze(
  cold: SequencedAccount,
  sponsor: string,
  network: CustodyNetwork,
  fee = "1000",
): Transaction {
  requireAccount("the cold treasury", cold.id);
  requireAccount("the sponsor", sponsor);
  if (cold.id === sponsor) throw new Error("the cold treasury must be a different account from the sponsor");
  return new TransactionBuilder(new Account(cold.id, cold.sequence), {
    fee,
    networkPassphrase: PASSPHRASES[network],
  })
    .addOperation(Operation.setOptions({ masterWeight: 0, source: sponsor }))
    .setTimeout(600)
    .build();
}

/**
 * The leak response's second transaction, sent once the freeze has applied: the cold key moves an
 * amount from the frozen sponsor to the cold treasury. Like the freeze, its source and fee payer is the
 * cold treasury and the payment names the sponsor as its source, so it does not depend on the sponsor's
 * sequence. Choose the amount from the sponsor's balance after the freeze, leaving its reserve: if the
 * balance is lower by the time it applies, only this transaction fails (`op_underfunded`), and it can be
 * rebuilt with the smaller amount. Unsigned: the cold key signs it on its hardware wallet.
 */
export function buildSweep(
  cold: SequencedAccount,
  sponsor: string,
  amountXlm: string,
  network: CustodyNetwork,
  fee = "1000",
): Transaction {
  requireAccount("the cold treasury", cold.id);
  requireAccount("the sponsor", sponsor);
  if (cold.id === sponsor) throw new Error("the cold treasury must be a different account from the sponsor");
  if (!/^\d{1,9}(\.\d{1,7})?$/.test(amountXlm) || Number(amountXlm) <= 0) {
    throw new Error("the sweep must be a positive XLM amount with at most 7 decimals");
  }
  return new TransactionBuilder(new Account(cold.id, cold.sequence), {
    fee,
    networkPassphrase: PASSPHRASES[network],
  })
    .addOperation(
      Operation.payment({ destination: cold.id, asset: Asset.native(), amount: amountXlm, source: sponsor }),
    )
    .setTimeout(600)
    .build();
}

/** A seed from a key file: the last non-comment line, which must be an S… seed. */
export function seedFromFile(text: string): Keypair {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"))
    .at(-1);
  if (line === undefined || !StrKey.isValidEd25519SecretSeed(line))
    throw new Error("the key file holds no S… seed");
  return Keypair.fromSecret(line);
}

/** A short fingerprint of a public key, for logs that must not show whole addresses twice. */
export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 12);
}
