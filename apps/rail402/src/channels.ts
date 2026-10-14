/**
 * Operator commands for channel accounts, run with the service's own environment:
 *
 *   node dist/channels.js status    [--network stellar:pubnet]
 *   node dist/channels.js provision [--network stellar:pubnet]
 *   node dist/channels.js retire    [--network stellar:pubnet] [--count N] [--force]
 *
 * `provision` creates the missing channel accounts and the network's `upto` settlement authority;
 * pubnet never does this at startup, so an operator decides when the sponsor pays their reserves.
 * The authority, like a channel, is derived from the sponsor, holds no balance and has its reserve
 * sponsored; `status` reports its balance, which must stay zero. `retire` merges the channel accounts
 * and the authority back into the sponsor, which returns their sponsored reserves. Run it with the service stopped, before
 * rotating the sponsor key or lowering CHANNEL_COUNT; it refuses while a settlement on the network
 * is unfinished or a channel is leased. `--count` covers channels beyond the configured count.
 * With Postgres, `status` also lists the transaction hashes of unresolvable settlements: past their
 * time bound, but older than the RPC's retained history, so only Horizon or a history archive can
 * tell whether they were included.
 * Every command prints one JSON line per network.
 */
import { parseArgs } from "node:util";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  authorityStatus,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  existingAccounts,
  historyCovers,
  ledgerCloseSeconds,
  provisionAuthority,
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
      const authority = deriveAuthorityKeypair(sponsor, network.network);
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

      // Settlements the service keeps unfinished because the RPC can no longer prove their outcome.
      const unresolvable = async () => {
        if (db === undefined) return undefined;
        const hashes: string[] = [];
        for (const record of await new PostgresSettlementLedger(db).unfinished(network.network)) {
          if (record.transactionHash === undefined || record.validUntil === undefined) continue;
          const found = await server.getTransaction(record.transactionHash);
          if (
            found.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
            ledgerCloseSeconds(found.latestLedgerCloseTime) > record.validUntil &&
            !historyCovers(record, found.oldestLedgerCloseTime)
          ) {
            hashes.push(record.transactionHash);
          }
        }
        return { unresolvableSettlements: hashes };
      };

      if (command === "status") {
        const existing = await existingAccounts(server, addresses);
        const status = await authorityStatus(server, authority.publicKey());
        print({
          ...report,
          present: existing.size,
          missing: addresses.filter((address) => !existing.has(address)),
          authority: {
            address: status.address,
            present: status.exists,
            balanceStroops: status.balanceStroops.toString(),
          },
          ...(await busy()),
          ...(await unresolvable()),
        });
      } else if (command === "provision") {
        const result = await provisionChannels({ server, passphrase, sponsor, channels });
        const authorityCreated = await provisionAuthority({ server, passphrase, sponsor, authority });
        print({
          ...report,
          created: result.created,
          alreadyPresent: result.existing.length,
          authority: { address: authority.publicKey(), created: authorityCreated },
        });
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
        const result = await retireChannels({
          server,
          passphrase,
          sponsor,
          channels: [...channels, authority],
        });
        const retired = result.retired.filter((address) => address !== authority.publicKey());
        print({
          ...report,
          retired,
          alreadyAbsent: result.absent.filter((address) => address !== authority.publicKey()).length,
          authority: {
            address: authority.publicKey(),
            retired: result.retired.includes(authority.publicKey()),
          },
        });
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
