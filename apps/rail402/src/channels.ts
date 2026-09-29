/**
 * Operator commands for channel accounts, run with the service's own environment:
 *
 *   node dist/channels.js status    [--network stellar:pubnet]
 *   node dist/channels.js provision [--network stellar:pubnet]
 *   node dist/channels.js retire    [--network stellar:pubnet] [--count N] [--force]
 *
 * `provision` creates the missing channel accounts; pubnet never does this at startup, so an
 * operator decides when the sponsor pays their reserves. `retire` merges the channel accounts back
 * into the sponsor, which returns their sponsored reserves. Run it with the service stopped, before
 * rotating the sponsor key or lowering CHANNEL_COUNT; it refuses while a settlement on the network
 * is unfinished or a channel is leased. `--count` covers channels beyond the configured count.
 * Every command prints one JSON line per network.
 */
import { parseArgs } from "node:util";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  deriveChannelKeypairs,
  existingAccounts,
  provisionChannels,
  retireChannels,
} from "@rail402.dev/facilitator";
import { networkPassphrase } from "@rail402.dev/stellar";
import {
  PostgresChannelPool,
  PostgresSettlementLedger,
  createDatabase,
  migrate,
} from "@rail402.dev/store-postgres";
import { ConfigError, loadConfig, type Config } from "./config.ts";

const COMMANDS = ["status", "provision", "retire"] as const;
type Command = (typeof COMMANDS)[number];

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      network: { type: "string" },
      count: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const command = positionals[0] as Command | undefined;
  if (command === undefined || !COMMANDS.includes(command) || positionals.length !== 1) {
    throw new UsageError(`usage: channels <${COMMANDS.join("|")}> [--network …] [--count N] [--force]`);
  }
  const count = values.count === undefined ? undefined : Number(values.count);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 1_000)) {
    throw new UsageError("--count must be an integer between 1 and 1000");
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

  const db =
    config.store.kind === "postgres" ? createDatabase({ connectionString: config.store.url }) : undefined;
  try {
    if (db !== undefined) await migrate(db);
    for (const network of networks) {
      const sponsor = Keypair.fromSecret(network.sponsorSecret);
      const channels = deriveChannelKeypairs(sponsor, network.network, count ?? network.channelCount);
      const addresses = channels.map((keypair) => keypair.publicKey());
      const server = new rpc.Server(network.rpcUrl, {
        allowHttp: new URL(network.rpcUrl).protocol === "http:",
      });
      const passphrase = networkPassphrase(network.network);
      const report = { network: network.network, sponsor: sponsor.publicKey(), channels: addresses.length };

      // Durable state tells whether any channel may still carry a settlement.
      const busy = async () => {
        if (db === undefined) return undefined;
        const unfinished = await new PostgresSettlementLedger(db).unfinished(network.network);
        const pool = await PostgresChannelPool.open(db, { network: network.network, addresses });
        return { unfinishedSettlements: unfinished.length, leasedChannels: await pool.inUse() };
      };

      if (command === "status") {
        const existing = await existingAccounts(server, addresses);
        print({
          ...report,
          present: existing.size,
          missing: addresses.filter((address) => !existing.has(address)),
          ...(await busy()),
        });
      } else if (command === "provision") {
        const result = await provisionChannels({ server, passphrase, sponsor, channels });
        print({ ...report, created: result.created, alreadyPresent: result.existing.length });
      } else {
        const state = await busy();
        if (state === undefined && !values.force) {
          throw new UsageError(
            "STORE=memory cannot show whether settlements are in flight; stop the service and pass --force",
          );
        }
        if (state !== undefined && (state.unfinishedSettlements > 0 || state.leasedChannels > 0)) {
          throw new UsageError(
            `${network.network}: ${String(state.unfinishedSettlements)} unfinished settlement(s) and ` +
              `${String(state.leasedChannels)} leased channel(s); stop the service and let it reconcile first`,
          );
        }
        const result = await retireChannels({ server, passphrase, sponsor, channels });
        print({ ...report, retired: result.retired, alreadyAbsent: result.absent.length });
      }
    }
  } finally {
    await db?.destroy();
  }
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
  process.stderr.write(`channels: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? error.exitCode : 1;
}
