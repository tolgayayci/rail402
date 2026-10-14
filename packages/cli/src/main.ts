import { createRequire } from "node:module";
import { commandLabel, parseCommandLine, type CommandName, type ParsedCommand } from "./args.ts";
import { EXIT, type ExitStatus } from "./codes.ts";
import type { CliDeps, CommandHandler } from "./command.ts";
import { account } from "./commands/account.ts";
import { listing, resources, search } from "./commands/discovery.ts";
import { keys } from "./commands/keys.ts";
import { pay, purchase, quote } from "./commands/pay.ts";
import { seller } from "./commands/seller.ts";
import { session } from "./commands/session.ts";
import { tx } from "./commands/tx.ts";
import { resolveContext, wantsJson } from "./config.ts";
import { HELP, commandHelp } from "./help.ts";
import { failureFrom, reportFailure, reportSuccess, successDocument, type CliIo } from "./output.ts";
import { openBuyer } from "./runtime.ts";
import { readSecret } from "./secret-input.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const CLI_VERSION = version;

const HANDLERS: Readonly<Record<Exclude<CommandName, "help" | "version">, CommandHandler>> = {
  search,
  resources,
  listing,
  quote,
  pay,
  purchase,
  tx,
  session,
  keys,
  account,
  seller,
};

const defaultDeps: CliDeps = {
  openBuyer,
  fetch: (input, init) => globalThis.fetch(input, init),
  readSecret: () => readSecret(process.stdin, process.stderr),
};

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * Runs one rail402 command and returns its exit status. With --json (or RAIL402_OUTPUT=json), stdout
 * receives exactly one JSON document whether the command succeeds or fails.
 */
export async function run(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  io: CliIo = processIo,
  deps: Partial<CliDeps> = {},
): Promise<ExitStatus> {
  // Before parsing succeeds, --json is honoured if it appears at all.
  let json = argv.includes("--json") || wantsJson({ flags: {} }, env);
  let parsed: ParsedCommand;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    return reportFailure(io, json, commandLabel(argv), failureFrom(error, false));
  }
  json = wantsJson(parsed, env);

  if (parsed.command === "help") {
    const text = parsed.positionals[0] === undefined ? HELP : commandHelp(parsed.positionals[0]);
    io.stdout(json ? `${successDocument("help", undefined, { text })}\n` : text);
    return EXIT.ok;
  }
  if (parsed.command === "version") {
    io.stdout(json ? `${successDocument("version", undefined, { version })}\n` : `${version}\n`);
    return EXIT.ok;
  }

  const handler = HANDLERS[parsed.command];
  const label = parsed.subcommand === undefined ? parsed.command : `${parsed.command} ${parsed.subcommand}`;
  let context;
  try {
    context = resolveContext(parsed, env);
  } catch (error) {
    return reportFailure(io, json, label, failureFrom(error, false));
  }
  const signal = AbortSignal.timeout(context.timeoutMs);
  try {
    const outcome = await handler.run({
      parsed,
      context,
      io,
      deps: { ...defaultDeps, ...deps },
      signal,
    });
    reportSuccess(io, json, label, context.network, outcome.result, outcome.human);
    return outcome.exit ?? EXIT.ok;
  } catch (error) {
    return reportFailure(io, json, label, failureFrom(error, handler.pays));
  }
}

/** The bin's entry: runs the command from process.argv. */
export async function main(): Promise<number> {
  return run(process.argv.slice(2));
}
