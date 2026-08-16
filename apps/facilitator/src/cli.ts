#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { createLogger } from "./logger.js";

/**
 * CLI entrypoint (the package `bin`), wrapping the server bootstrap in `index.ts`.
 *
 * The one job that makes `npx @rail402.dev/facilitator` "just work": on testnet, if no settlement
 * signer is configured, generate an EPHEMERAL keypair and friendbot-fund it, so a first-time user
 * needs no keypair, no faucet, and no flags. The generated key is per-process and never persisted —
 * it is a convenience for trying the service, loudly labelled as unfit for production.
 *
 * Everything else is a thin flag→env mapping: the CLI sets `process.env` and then imports
 * `./index.js`, which runs the same `main()` a plain `node dist/index.js` would. Configuration is
 * still validated there before the port binds, so a bad flag fails fast with a coded reason.
 */

const TESTNET = "stellar:testnet";
const FRIENDBOT = "https://friendbot.stellar.org";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const HELP = `rail402-facilitator — x402 facilitator for Stellar (verify · settle · supported + Bazaar)

Usage:
  rail402-facilitator [options]

Options:
  --secret <S…>        Settlement signer secret (or set FACILITATOR_STELLAR_SECRET).
                       On testnet you can OMIT this — an ephemeral key is generated and
                       friendbot-funded for you.
  --network <caip2>    Network(s), comma-separated (default: ${TESTNET}).
  --port <n>           Port to listen on (default: 4022).
  --catalog-db <path>  Persist the Bazaar catalog to this SQLite file (default: in-memory).
  -h, --help           Show this help.
  -v, --version        Show version.

Full config surface: apps/facilitator/.env.example and the operator guide.
Testnet only.`;

interface Opts {
  help?: boolean;
  version?: boolean;
  secret?: string;
  network?: string;
  port?: string;
  catalogDb?: string;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {};
  let i = 0;
  const nextValue = (flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      console.error(`option ${flag} needs a value`);
      process.exit(2);
    }
    i += 1;
    return v;
  };
  for (; i < argv.length; i++) {
    const token = argv[i] ?? "";
    let name = token;
    let inline: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    const value = (): string => inline ?? nextValue(name);
    switch (name) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      case "--secret":
        opts.secret = value();
        break;
      case "--network":
        opts.network = value();
        break;
      case "--port":
        opts.port = value();
        break;
      case "--catalog-db":
        opts.catalogDb = value();
        break;
      default:
        console.error(`unknown option: ${token}\n\n${HELP}`);
        process.exit(2);
    }
  }
  return opts;
}

async function friendbotFund(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  if (!res.ok && res.status !== 400) {
    // 400 with "op_already_exists" means the account is already funded — treat as success.
    const body = await res.text().catch(() => "");
    throw new Error(`friendbot returned ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.version) {
    console.log(readVersion());
    return;
  }

  // Flag → env, so loadConfig() (which reads process.env) picks them up.
  if (opts.network) process.env.STELLAR_NETWORKS = opts.network;
  if (opts.port) process.env.PORT = opts.port;
  if (opts.catalogDb) process.env.CATALOG_DB_PATH = opts.catalogDb;
  if (opts.secret) process.env.FACILITATOR_STELLAR_SECRET = opts.secret;

  const log = createLogger(process.env.LOG_LEVEL ?? "info");

  if (!process.env.FACILITATOR_STELLAR_SECRET) {
    const networks = (process.env.STELLAR_NETWORKS ?? TESTNET).split(",").map(n => n.trim());
    const testnetOnly = networks.every(n => n === TESTNET);
    if (!testnetOnly) {
      log.fatal(
        "no FACILITATOR_STELLAR_SECRET set — auto-provisioning is testnet-only; pass --secret",
      );
      process.exit(1);
    }
    const keypair = Keypair.random();
    log.warn(
      { address: keypair.publicKey() },
      "no signer configured — generating an EPHEMERAL testnet key and funding it via friendbot (NOT for production)",
    );
    try {
      await friendbotFund(keypair.publicKey());
    } catch (error) {
      log.fatal({ err: error }, "could not friendbot-fund the ephemeral signer");
      process.exit(1);
    }
    process.env.FACILITATOR_STELLAR_SECRET = keypair.secret();
    log.warn({ address: keypair.publicKey() }, "ephemeral signer funded — starting");
  }

  // Hand off to the server bootstrap. Importing runs main(), which validates config and binds.
  await import("./index.js");
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
