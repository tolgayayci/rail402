/**
 * Operator commands for `upto`, run with the service's own environment:
 *
 *   node dist/upto.js ttl status          [--network stellar:pubnet]
 *   node dist/upto.js ttl extend          [--network stellar:pubnet] [--to LEDGERS]
 *   node dist/upto.js ttl restore         [--network stellar:pubnet]
 *   node dist/upto.js authority status    [--network stellar:pubnet]
 *   node dist/upto.js authority provision [--network stellar:pubnet]
 *
 * `ttl status` reads the settlement contract's instance and code TTLs and says what they call for.
 * `ttl extend` extends both entries now, to `--to` ledgers past the current one (default: the
 * configured target, or the network maximum less one day). `ttl restore` restores archived entries
 * and extends them; it is how an operator brings the contract back where automatic restoration is
 * off (pubnet by default). The sponsor pays for both, and both take the same lock as the service's
 * keeper, so they never race it. `authority provision` creates the network's settlement authority
 * (zero balance, sponsored reserve), which a service that does not provision accounts at startup
 * needs before it serves `upto`; `authority status` reports it, and its balance must stay zero.
 * Networks that do not serve `upto` are skipped. Every command prints one JSON line per network.
 */
import { parseArgs } from "node:util";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  MemoryTaskLock,
  authorityStatus,
  contractLiveness,
  deriveAuthorityKeypair,
  planContractTtl,
  provisionAuthority,
  silentLogger,
  type TaskLock,
} from "@rail402.dev/facilitator";
import { networkPassphrase, readContractTtl } from "@rail402.dev/stellar";
import { PostgresTaskLock, createDatabase } from "@rail402.dev/store-postgres";
import { ConfigError, loadConfig, type Config, type UptoConfig } from "./config.ts";
import { Metrics } from "./metrics.ts";
import { UptoTtlKeeper } from "./upto-keeper.ts";

const COMMANDS = ["ttl status", "ttl extend", "ttl restore", "authority status", "authority provision"];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { network: { type: "string" }, to: { type: "string" } },
  });
  const command = positionals.join(" ");
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`usage: upto <${COMMANDS.join("|")}> [--network …] [--to LEDGERS]`);
  }
  const to = values.to === undefined ? undefined : Number(values.to);
  if (to !== undefined && (command !== "ttl extend" || !Number.isInteger(to) || to < 1)) {
    throw new UsageError("--to takes a positive number of ledgers and applies to `ttl extend` only");
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) throw new UsageError(error.message, 78);
    throw error;
  }
  const networks = config.networks.filter(
    (network) => values.network === undefined || network.network === values.network,
  );
  if (networks.length === 0) throw new UsageError(`network ${values.network ?? ""} is not configured`);
  if (!networks.some((network) => network.upto !== undefined)) {
    throw new UsageError("no selected network serves upto (UPTO_ENABLED)");
  }

  const db =
    config.store.kind === "postgres" ? createDatabase({ connectionString: config.store.url }) : undefined;
  const lock: TaskLock = db === undefined ? new MemoryTaskLock() : new PostgresTaskLock(db);
  try {
    for (const network of networks) {
      const upto = network.upto;
      if (upto === undefined) continue;
      const sponsor = Keypair.fromSecret(network.sponsorSecret);
      const server = new rpc.Server(network.rpcUrl, {
        allowHttp: new URL(network.rpcUrl).protocol === "http:",
      });
      const report = { network: network.network, contract: upto.contract };

      if (command === "authority status" || command === "authority provision") {
        const authority = deriveAuthorityKeypair(sponsor, network.network);
        const created =
          command === "authority provision"
            ? await provisionAuthority({
                server,
                passphrase: networkPassphrase(network.network),
                sponsor,
                authority,
              })
            : undefined;
        const status = await authorityStatus(server, authority.publicKey());
        print({
          network: network.network,
          authority: status.address,
          present: status.exists,
          balanceStroops: status.balanceStroops.toString(),
          spendableStroops: status.spendableStroops.toString(),
          ...(created === undefined ? {} : { created }),
        });
      } else if (command === "ttl status") {
        print({ ...report, ...(await ttlStatus(server, upto)) });
      } else {
        const keeper = new UptoTtlKeeper({
          network: network.network,
          server,
          passphrase: networkPassphrase(network.network),
          sponsor,
          contract: upto.contract,
          wasmHash: upto.wasmHash,
          ttl: { ...upto.ttl, ...(to === undefined ? {} : { extendToLedgers: to }) },
          inclusionFeeStroops: network.inclusionFeeStroops,
          sponsorReserveStroops: network.sponsorReserveStroops,
          lock,
          metrics: new Metrics(),
          log: silentLogger,
        });
        const round = await keeper.maintain(command === "ttl extend" ? "extend" : "restore");
        if (round.skipped === true) {
          throw new UsageError(
            `${network.network}: another task is using the sponsor account (provisioning or a keeper round); try again shortly`,
            75,
          );
        }
        print({
          ...report,
          plan: round.plan.action,
          transactions: round.transactions.map((transaction) => ({
            action: transaction.action,
            hash: transaction.hash,
            ledger: transaction.ledger,
            feeChargedStroops: transaction.feeChargedStroops.toString(),
          })),
          ...ttlFields(round.liveness),
        });
        if (round.plan.action === "missing") process.exitCode = 1;
      }
    }
  } finally {
    await db?.destroy();
  }
}

async function ttlStatus(server: rpc.Server, upto: UptoConfig): Promise<Record<string, unknown>> {
  const reading = await readContractTtl(server, [upto.contract]);
  const live = reading.contracts.get(upto.contract);
  const liveness = contractLiveness(live, reading.latestLedger);
  const plan = planContractTtl(liveness, upto.ttl);
  return {
    latestLedger: reading.latestLedger,
    wasmHash: upto.wasmHash,
    ...(live?.wasmHash === undefined ? {} : { liveWasmHash: live.wasmHash }),
    ...(live === undefined
      ? {}
      : {
          instanceLiveUntil: live.instanceLiveUntil,
          ...(live.codeLiveUntil === undefined ? {} : { codeLiveUntil: live.codeLiveUntil }),
        }),
    ...ttlFields(liveness),
    plan: plan.action,
    keeper: { enabled: upto.ttl.keeper, autoRestore: upto.ttl.autoRestore },
  };
}

function ttlFields(liveness: ReturnType<typeof contractLiveness>): Record<string, unknown> {
  return {
    ...(liveness.instanceTtlLedgers === undefined ? {} : { instanceTtlLedgers: liveness.instanceTtlLedgers }),
    ...(liveness.codeTtlLedgers === undefined ? {} : { codeTtlLedgers: liveness.codeTtlLedgers }),
    archived: { instance: liveness.instanceArchived, code: liveness.codeArchived },
  };
}

class UsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 64) {
    super(message);
    this.exitCode = exitCode;
  }
}

function print(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`upto: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? error.exitCode : 1;
}
