/**
 * The key ceremony for a fee sponsor on a real-funds network, run from a checkout with dependencies:
 *
 *   node deploy/keys/cli.ts check-signers --network pubnet --sponsor G… --cold G… [--horizon URL]
 *       read the sponsor's signers and thresholds and say whether only the cold key meets high
 *   node deploy/keys/cli.ts signer-setup --network pubnet --sponsor G… --cold G… --sign-with FILE [--horizon URL]
 *       print the review and the hot-signed transaction that adds the cold signer and sets thresholds
 *   node deploy/keys/cli.ts signer-setup --network pubnet --sponsor G… --cold G… --unsigned [--sequence N]
 *       the same transaction unsigned, for the offline machine that holds the seed: sign it there with
 *       `node deploy/stellar-keys.ts --sign-xdr FILE --with KEY --network stellar:pubnet`, carry only the
 *       signed XDR back. With --sequence (the sponsor's current sequence) no network is used at all
 *   node deploy/keys/cli.ts freeze --network pubnet --sponsor G… --cold G… [--sequence N]
 *       the leak response: print the review and the unsigned transaction from the cold treasury that
 *       sets the hot key's weight to 0 on the sponsor (--sequence: the cold account's current sequence)
 *   node deploy/keys/cli.ts sweep --network pubnet --sponsor G… --cold G… --amount XLM [--sequence N]
 *       after the freeze applied: the unsigned transaction from the cold treasury that moves that amount
 *       from the frozen sponsor to the cold treasury
 *   node deploy/keys/cli.ts top-up --network pubnet --treasury G… --sponsor G… --recorded-sponsor FILE --amount XLM
 *       print the review and the unsigned top-up for the hardware wallet holding the treasury
 *   node deploy/keys/cli.ts rehearse [--horizon URL]
 *       the whole ceremony on the testnet with fresh accounts, ending with the checks that matter and
 *       the leak response (the hot key bumps its own sequence first; the cold key's freeze still
 *       applies, the sweep follows, and the hot key is refused afterwards)
 *
 * The sponsor seed itself is generated offline (`deploy/stellar-keys.ts --key-file stellar:pubnet` on an
 * offline machine, docs/operations.md "Mainnet sponsor custody");
 * this tool never creates a pubnet seed. It submits only on the testnet (`--submit`, and `rehearse`);
 * pubnet transactions are printed for review and submitted by the operator after signing.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Asset, Horizon, Keypair, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { signEnvelope } from "../stellar-keys.ts";
import {
  PASSPHRASES,
  SIGNER_PLAN,
  buildFreeze,
  buildSignerSetup,
  buildSweep,
  buildTopUp,
  reviewOf,
  reviewSummary,
  seedFromFile,
  signerSetProblems,
  type CustodyNetwork,
  type SignerSet,
} from "./ceremony.ts";

const HORIZON: Readonly<Record<CustodyNetwork, string>> = {
  testnet: "https://horizon-testnet.stellar.org",
  pubnet: "https://horizon.stellar.org",
};
const FRIENDBOT = "https://friendbot.stellar.org";

const out = (line: string) => process.stdout.write(`${line}\n`);

function network(value: string | undefined): CustodyNetwork {
  if (value !== "testnet" && value !== "pubnet") throw new Error("--network must be testnet or pubnet");
  return value;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === "") throw new Error(`--${name} is required`);
  return value;
}

export async function signerSetOf(server: Horizon.Server, account: string): Promise<SignerSet> {
  const loaded = await server.loadAccount(account);
  const master = loaded.signers.find((signer) => signer.key === account);
  return {
    masterWeight: master?.weight ?? 0,
    low: loaded.thresholds.low_threshold,
    medium: loaded.thresholds.med_threshold,
    high: loaded.thresholds.high_threshold,
    signers: Object.fromEntries(
      loaded.signers.filter((signer) => signer.key !== account).map((signer) => [signer.key, signer.weight]),
    ),
  };
}

async function sequenced(server: Horizon.Server, id: string) {
  const loaded = await server.loadAccount(id);
  return { id, sequence: loaded.sequence };
}

/** The account with the sequence given on the command line (offline), or as Horizon reports it. */
async function sequencedOrGiven(server: Horizon.Server, id: string, sequence: string | undefined) {
  if (sequence === undefined) return sequenced(server, id);
  if (!/^\d{1,19}$/.test(sequence))
    throw new Error("--sequence must be the account's current sequence number");
  return { id, sequence };
}

/** Submits a signed transaction; returns its hash, or the result codes when the network refuses it. */
async function submit(
  server: Horizon.Server,
  tx: Transaction,
): Promise<{ ok: true; hash: string } | { ok: false; codes: unknown }> {
  try {
    const result = await server.submitTransaction(tx);
    return { ok: true, hash: result.hash };
  } catch (error) {
    const codes = (error as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data
      ?.extras?.result_codes;
    return { ok: false, codes: codes ?? String(error) };
  }
}

async function fund(account: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT}?addr=${account}`, { redirect: "error" });
  if (!response.ok) throw new Error(`Friendbot refused ${account}: ${response.status}`);
}

/** The ceremony on the testnet with fresh accounts; returns what a drill records. */
export async function rehearse(horizonUrl = HORIZON.testnet) {
  const server = new Horizon.Server(horizonUrl);
  const hot = Keypair.random();
  const cold = Keypair.random();
  const outsider = Keypair.random();
  const startedAt = new Date().toISOString();
  await fund(hot.publicKey());
  await fund(cold.publicKey());

  // The setup goes the offline way: built unsigned, signed by the zero-dependency key tool, submitted.
  const unsignedSetup = buildSignerSetup(
    await sequenced(server, hot.publicKey()),
    cold.publicKey(),
    "testnet",
  );
  const offline = signEnvelope(unsignedSetup.toXDR(), "stellar:testnet", hot.secret());
  if (offline.hash !== unsignedSetup.hash().toString("hex"))
    throw new Error("the offline signature covers another hash");
  const setup = new Transaction(offline.signed, PASSPHRASES.testnet);
  const applied = await submit(server, setup);
  if (!applied.ok) throw new Error(`the signer setup was refused: ${JSON.stringify(applied.codes)}`);
  const set = await signerSetOf(server, hot.publicKey());
  const problems = signerSetProblems(set, cold.publicKey());

  // The hot key alone tries to remove the cold signer: it must not meet the high threshold.
  const takeover = new TransactionBuilder(await server.loadAccount(hot.publicKey()), {
    fee: "1000",
    networkPassphrase: PASSPHRASES.testnet,
  })
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: cold.publicKey(), weight: 0 } }))
    .setTimeout(120)
    .build();
  takeover.sign(hot);
  const takeoverResult = await submit(server, takeover);

  // The hot key alone pays (medium), as sponsoring channels and settlements needs.
  const createOutsider = new TransactionBuilder(await server.loadAccount(hot.publicKey()), {
    fee: "1000",
    networkPassphrase: PASSPHRASES.testnet,
  })
    .addOperation(Operation.createAccount({ destination: outsider.publicKey(), startingBalance: "2" }))
    .setTimeout(120)
    .build();
  createOutsider.sign(hot);
  const mediumResult = await submit(server, createOutsider);

  // The cold key tops up the hot sponsor, to the recorded address only.
  const topUp = buildTopUp(
    await sequenced(server, cold.publicKey()),
    hot.publicKey(),
    hot.publicKey(),
    "25",
    "testnet",
  );
  const topUpReview = reviewOf(topUp, "testnet");
  topUp.sign(cold);
  const topUpResult = await submit(server, topUp);
  let misdirected = "";
  try {
    buildTopUp(
      await sequenced(server, cold.publicKey()),
      outsider.publicKey(),
      hot.publicKey(),
      "25",
      "testnet",
    );
  } catch (error) {
    misdirected = error instanceof Error ? error.message : String(error);
  }

  // The leak response. The freeze is prepared before the attacker moves: whoever holds the leaked seed
  // bumps the sponsor's sequence (what would break a freeze sourced from the sponsor), and the cold
  // key's freeze still applies, because its source and fee payer is the cold account.
  const freeze = buildFreeze(await sequenced(server, cold.publicKey()), hot.publicKey(), "testnet");
  const freezeReview = reviewOf(freeze, "testnet");
  freeze.sign(cold);
  const sequenceBefore = BigInt((await server.loadAccount(hot.publicKey())).sequence);
  const race = new TransactionBuilder(await server.loadAccount(hot.publicKey()), {
    fee: "1000",
    networkPassphrase: PASSPHRASES.testnet,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: (sequenceBefore + 1_000_000n).toString() }))
    .setTimeout(120)
    .build();
  race.sign(hot);
  const raceResult = await submit(server, race);
  const sequenceAfterRace = (await server.loadAccount(hot.publicKey())).sequence;
  const freezeResult = await submit(server, freeze);
  const frozenSet = await signerSetOf(server, hot.publicKey());
  // The sweep is its own transaction, after the freeze, signed by the cold key alone.
  const sweep = buildSweep(await sequenced(server, cold.publicKey()), hot.publicKey(), "10", "testnet");
  const sweepReview = reviewOf(sweep, "testnet");
  sweep.sign(cold);
  const sweepResult = await submit(server, sweep);
  const afterFreeze = new TransactionBuilder(await server.loadAccount(hot.publicKey()), {
    fee: "1000",
    networkPassphrase: PASSPHRASES.testnet,
  })
    .addOperation(
      Operation.payment({ destination: outsider.publicKey(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(120)
    .build();
  afterFreeze.sign(hot);
  const afterFreezeResult = await submit(server, afterFreeze);

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    sponsor: hot.publicKey(),
    cold: cold.publicKey(),
    plan: SIGNER_PLAN,
    signerSetup: applied.hash,
    signerSetupSignedOffline: true,
    signerSet: set,
    signerSetProblems: problems,
    hotOnlyHighRefused: !takeoverResult.ok,
    hotOnlyHighCodes: takeoverResult.ok ? null : takeoverResult.codes,
    hotOnlyMedium: mediumResult.ok ? mediumResult.hash : null,
    topUp: topUpResult.ok ? topUpResult.hash : null,
    topUpReview,
    misdirectedTopUpRefused: misdirected,
    hotSequenceBump: raceResult.ok ? raceResult.hash : null,
    hotSequenceBefore: sequenceBefore.toString(),
    hotSequenceAfterBump: sequenceAfterRace,
    freezeBuiltBeforeBump: true,
    freeze: freezeResult.ok ? freezeResult.hash : null,
    freezeCodes: freezeResult.ok ? null : freezeResult.codes,
    freezeReview,
    frozenMasterWeight: frozenSet.masterWeight,
    sweep: sweepResult.ok ? sweepResult.hash : null,
    sweepReview,
    hotAfterFreezeRefused: !afterFreezeResult.ok,
    hotAfterFreezeCodes: afterFreezeResult.ok ? null : afterFreezeResult.codes,
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      network: { type: "string" },
      sponsor: { type: "string" },
      cold: { type: "string" },
      treasury: { type: "string" },
      "recorded-sponsor": { type: "string" },
      amount: { type: "string" },
      "sign-with": { type: "string" },
      unsigned: { type: "boolean", default: false },
      sequence: { type: "string" },
      submit: { type: "boolean", default: false },
      horizon: { type: "string" },
    },
  });
  switch (command) {
    case "check-signers": {
      const net = network(values.network);
      const server = new Horizon.Server(values.horizon ?? HORIZON[net]);
      const problems = signerSetProblems(
        await signerSetOf(server, required("sponsor", values.sponsor)),
        required("cold", values.cold),
      );
      for (const problem of problems) out(`problem: ${problem}`);
      if (problems.length > 0) process.exit(1);
      out("only the cold key meets the high threshold; the hot key meets medium");
      return;
    }
    case "signer-setup": {
      const net = network(values.network);
      const server = new Horizon.Server(values.horizon ?? HORIZON[net]);
      const sponsor = required("sponsor", values.sponsor);
      const tx = buildSignerSetup(
        await sequencedOrGiven(server, sponsor, values.sequence),
        required("cold", values.cold),
        net,
      );
      if (values.unsigned) {
        if (values["sign-with"] !== undefined) throw new Error("give --unsigned or --sign-with, not both");
        out(reviewSummary(reviewOf(tx, net)));
        out(`xdr ${tx.toXDR()}`);
        return;
      }
      const hot = seedFromFile(readFileSync(required("sign-with", values["sign-with"]), "utf8"));
      if (hot.publicKey() !== sponsor) throw new Error("the key file does not hold the sponsor's seed");
      tx.sign(hot);
      out(reviewSummary(reviewOf(tx, net)));
      if (values.submit) {
        if (net !== "testnet")
          throw new Error(
            "this tool submits only on the testnet; submit pubnet transactions yourself after review",
          );
        out(JSON.stringify(await submit(server, tx)));
      } else out(`xdr ${tx.toXDR()}`);
      return;
    }
    case "top-up": {
      const net = network(values.network);
      const server = new Horizon.Server(values.horizon ?? HORIZON[net]);
      const recorded = readFileSync(required("recorded-sponsor", values["recorded-sponsor"]), "utf8").trim();
      const tx = buildTopUp(
        await sequenced(server, required("treasury", values.treasury)),
        required("sponsor", values.sponsor),
        recorded,
        required("amount", values.amount),
        net,
      );
      out(reviewSummary(reviewOf(tx, net)));
      out(`xdr ${tx.toXDR()}`);
      return;
    }
    case "freeze": {
      const net = network(values.network);
      const server = new Horizon.Server(values.horizon ?? HORIZON[net]);
      const cold = required("cold", values.cold);
      const tx = buildFreeze(
        await sequencedOrGiven(server, cold, values.sequence),
        required("sponsor", values.sponsor),
        net,
      );
      out(reviewSummary(reviewOf(tx, net)));
      out(`xdr ${tx.toXDR()}`);
      return;
    }
    case "sweep": {
      const net = network(values.network);
      const server = new Horizon.Server(values.horizon ?? HORIZON[net]);
      const cold = required("cold", values.cold);
      const tx = buildSweep(
        await sequencedOrGiven(server, cold, values.sequence),
        required("sponsor", values.sponsor),
        required("amount", values.amount),
        net,
      );
      out(reviewSummary(reviewOf(tx, net)));
      out(`xdr ${tx.toXDR()}`);
      return;
    }
    case "rehearse": {
      out(JSON.stringify(await rehearse(values.horizon), null, 2));
      return;
    }
    case undefined:
    default:
      throw new Error("usage: cli.ts check-signers|signer-setup|freeze|sweep|top-up|rehearse [options]");
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
