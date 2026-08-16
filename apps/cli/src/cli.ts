#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolveConfig, type GlobalFlags } from "./config.js";
import { render, type CmdResult } from "./format.js";
import {
  cmdFund,
  cmdWhoami,
  cmdSearch,
  cmdPay,
  cmdBuy,
  cmdTx,
  cmdFeed,
  cmdSupported,
  cmdConfig,
  type Ctx,
} from "./commands.js";

/**
 * rail402 — a command-line x402 wallet and agent tool for Stellar.
 *
 * Handlers in commands.ts are pure (they return a CmdResult); this file owns argument parsing,
 * config resolution, dispatch, and rendering. Every endpoint defaults to Rail402's hosted testnet
 * infrastructure and is overridable, so the same binary drives your own facilitator or explorer.
 */

const VALUE_FLAGS = new Set([
  "facilitator",
  "explorer",
  "explorer-web",
  "network",
  "secret",
  "max",
  "type",
  "limit",
  "method",
  "query",
  "seller",
  "scheme",
]);
const BOOL_FLAGS = new Set(["json", "help", "version"]);

interface Parsed {
  positionals: string[];
  flags: Record<string, string>;
  queries: string[];
  bools: Set<string>;
}

function parse(argv: string[]): Parsed {
  const flags: Record<string, string> = {};
  const queries: string[] = [];
  const bools = new Set<string>();
  const positionals: string[] = [];
  let i = 0;
  const nextValue = (name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      console.error(`option --${name} needs a value`);
      process.exit(2);
    }
    i += 1;
    return v;
  };
  for (; i < argv.length; i++) {
    let token = argv[i] ?? "";
    if (token === "-h") token = "--help";
    if (token === "-v") token = "--version";
    if (token.startsWith("--")) {
      let name = token.slice(2);
      let inline: string | undefined;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (BOOL_FLAGS.has(name)) {
        bools.add(name);
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const val = inline ?? nextValue(name);
        if (name === "query") queries.push(val);
        else flags[name] = val;
        continue;
      }
      console.error(`unknown option: --${name}\n\nRun \`rail402 help\` for usage.`);
      process.exit(2);
    }
    positionals.push(token);
  }
  return { positionals, flags, queries, bools };
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const HELP = `rail402 — a command-line x402 wallet & agent tool for Stellar

Usage:
  rail402 <command> [options]

Commands:
  fund                       Fund a testnet account via friendbot (generates one if no --secret)
  whoami                     Show your account address and balances
  search "<query>"           Search the Bazaar for paid resources
  buy "<query>" --max <amt>  Discover the cheapest match AND pay it
  pay <url> --max <amt>      Pay a known resource URL
  tx <hash>                  Look up a settlement on the explorer
  feed                       Recent x402 payments from the explorer
  supported                  What the facilitator supports
  config [show|set|path]     Show or change saved config (~/.rail402/config.json)
  help, version

Global options (default to Rail402's hosted testnet infrastructure, all overridable):
  --facilitator <url>        Facilitator base URL   (env RAIL402_FACILITATOR_URL)
  --explorer <url>           Explorer API base URL  (env RAIL402_EXPLORER_URL)
  --explorer-web <url>       Explorer web base URL  (env RAIL402_EXPLORER_WEB_URL)
  --network <caip2>          Network                (env RAIL402_NETWORK, default stellar:testnet)
  --secret <S…>              Stellar secret seed    (env RAIL402_SECRET)
  --json                     Machine-readable JSON output (for agents)

Command options:
  search/buy: --max <amt> --type <http|mcp> --limit <n>
  pay:        --max <amt> --method <GET|POST> --query k=v (repeatable)
  feed:       --limit <n> --seller <G…> --scheme <exact|upto>

Amounts are decimals in the asset's units (e.g. --max 0.10). Testnet only.
Docs: https://rail402.dev`;

function asType(v: string | undefined): "http" | "mcp" | undefined {
  return v === "http" || v === "mcp" ? v : undefined;
}

function parseQueries(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

async function dispatch(command: string, args: string[], parsed: Parsed, ctx: Ctx): Promise<CmdResult> {
  const { flags, queries } = parsed;
  const type = asType(flags.type);
  const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;

  switch (command) {
    case "fund":
      return cmdFund(ctx);
    case "whoami":
      return cmdWhoami(ctx);
    case "search":
      return cmdSearch(ctx, {
        query: args.join(" "),
        ...(flags.max ? { max: flags.max } : {}),
        ...(type ? { type } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      });
    case "buy":
      return cmdBuy(ctx, {
        query: args.join(" "),
        ...(flags.max ? { max: flags.max } : {}),
        ...(type ? { type } : {}),
      });
    case "pay": {
      const q = parseQueries(queries);
      return cmdPay(ctx, {
        url: args[0] ?? "",
        ...(flags.max ? { max: flags.max } : {}),
        ...(flags.method ? { method: flags.method } : {}),
        ...(Object.keys(q).length ? { query: q } : {}),
      });
    }
    case "tx":
      return cmdTx(ctx, { hash: args[0] ?? "" });
    case "feed":
      return cmdFeed(ctx, {
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        ...(flags.seller ? { seller: flags.seller } : {}),
        ...(flags.scheme ? { scheme: flags.scheme } : {}),
      });
    case "supported":
      return cmdSupported(ctx);
    case "config":
      return cmdConfig(ctx, {
        action: (args[0] as "show" | "set" | "path") || "show",
        ...(args[1] ? { key: args[1] } : {}),
        ...(args[2] ? { value: args[2] } : {}),
      });
    default:
      console.error(`unknown command: ${command}\n\nRun \`rail402 help\` for usage.`);
      process.exit(2);
  }
}

async function run(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  const command = parsed.positionals[0];

  if (parsed.bools.has("version") || command === "version") {
    process.stdout.write(readVersion() + "\n");
    return;
  }
  if (parsed.bools.has("help") || command === "help" || !command) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const globalFlags: GlobalFlags = {
    ...(parsed.flags.facilitator ? { facilitator: parsed.flags.facilitator } : {}),
    ...(parsed.flags.explorer ? { explorer: parsed.flags.explorer } : {}),
    ...(parsed.flags["explorer-web"] ? { explorerWeb: parsed.flags["explorer-web"] } : {}),
    ...(parsed.flags.network ? { network: parsed.flags.network } : {}),
    ...(parsed.flags.secret ? { secret: parsed.flags.secret } : {}),
  };
  const ctx: Ctx = { config: resolveConfig(globalFlags), fetchImpl: fetch };

  const result = await dispatch(command, parsed.positionals.slice(1), parsed, ctx);
  const code = render(result, parsed.bools.has("json"));
  process.exit(code);
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
