import type { ParsedCommand } from "./args.ts";
import type { ExitStatus } from "./codes.ts";
import type { CliContext } from "./config.ts";
import type { CliIo } from "./output.ts";
import type { OpenBuyer } from "./runtime.ts";

/** What commands may use from outside; tests substitute doubles. */
export interface CliDeps {
  readonly openBuyer: OpenBuyer;
  /** For Friendbot and other operator-configured endpoints. */
  readonly fetch: typeof fetch;
  /** Reads a secret seed for `keys import`: without echo on a terminal, or from a pipe. */
  readonly readSecret: () => Promise<string>;
}

export interface CommandInput {
  readonly parsed: ParsedCommand;
  readonly context: CliContext;
  readonly io: CliIo;
  readonly deps: CliDeps;
  readonly signal: AbortSignal;
}

export interface CommandOutcome {
  readonly result: unknown;
  readonly human: () => string;
  /** Defaults to 0. */
  readonly exit?: ExitStatus;
}

export interface CommandHandler {
  /** Whether the command can sign a payment: then an unexpected failure means `paid: unknown`. */
  readonly pays: boolean;
  run(input: CommandInput): Promise<CommandOutcome>;
}
