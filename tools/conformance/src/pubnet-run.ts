/**
 * The whole-run ledger of a pubnet evidence run, from the command line (`run-evidence.sh --network
 * pubnet` drives it):
 *
 *   node --conditions=@rail402/source tools/conformance/src/pubnet-run.ts plan
 *       plans a run (spends nothing) and prints its id; the operator confirms it with
 *       RAIL402_PUBNET_RUN_CONFIRM
 *   … claim --run <id>     claims the planned run once and prints its ledger file (RAIL402_PUBNET_LEDGER)
 *   … status --ledger <f>  prints the run's totals
 *   … close --ledger <f>   closes the run: every later debit is refused
 *   … sweep --ledger <f>   returns the funds of every account the run registered (after a crash);
 *                          its fees are capped by the per-harness caps, not by the closed ledger
 *
 * Every command reads the same pubnet settings as the harnesses (RAIL402_PUBNET_*, the treasury
 * file, the fee ceilings); a run id binds them, so a changed setting needs a new plan.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-sdk";
import { ProfileError, ProfileNetwork, TreasuryFunder, resolveProfile, runMaterial } from "./network.ts";
import { RunLedger, planRun } from "./run-ledger.ts";
import { gitCommit, log } from "./testnet.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { run: { type: "string" }, ledger: { type: "string" } },
});

function material() {
  const profile = resolveProfile("pubnet");
  if (profile.funding.kind !== "treasury") throw new ProfileError("pubnet_treasury_missing", "no treasury");
  const treasury = Keypair.fromSecret(readFileSync(profile.funding.secretFile, "utf8").trim()).publicKey();
  return { profile, material: runMaterial(profile, treasury, gitCommit().replace(/-dirty$/, "")) };
}

async function main(): Promise<void> {
  const [command] = positionals;
  switch (command ?? "") {
    case "plan": {
      const { runId, path } = planRun(material().material);
      log(`planned pubnet run ${runId} (${path}); nothing was spent`);
      process.stdout.write(`${runId}\n`);
      return;
    }
    case "claim": {
      if (values.run === undefined) throw new Error("claim needs --run <id>");
      const ledger = RunLedger.claim(values.run, material().material, "run-evidence");
      process.stdout.write(`${ledger.path}\n`);
      return;
    }
    case "status": {
      if (values.ledger === undefined) throw new Error("status needs --ledger <file>");
      const ledger = RunLedger.inspect(values.ledger);
      process.stdout.write(
        `${JSON.stringify({ ...ledger.totals(), stranded: ledger.read().stranded }, null, 2)}\n`,
      );
      return;
    }
    case "close": {
      if (values.ledger === undefined) throw new Error("close needs --ledger <file>");
      RunLedger.inspect(values.ledger).close();
      log(`closed ${values.ledger}`);
      return;
    }
    case "sweep": {
      if (values.ledger === undefined) throw new Error("sweep needs --ledger <file>");
      const ledger = RunLedger.inspect(values.ledger);
      const { profile } = material();
      const funder = new TreasuryFunder(new ProfileNetwork(profile), profile, "recovery");
      funder.recover(ledger.registry(), ledger.seenAddresses());
      const sweep = await funder.sweepBack();
      log(`sweep-back ${sweep.status}: ${String(sweep.transactions.length)} transaction(s)`);
      if (sweep.status === "partial") process.exitCode = 1;
      return;
    }
    default:
      throw new Error("usage: pubnet-run.ts plan | claim --run <id> | status|close|sweep --ledger <file>");
  }
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
