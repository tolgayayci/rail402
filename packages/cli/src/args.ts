import { parseArgs } from "node:util";
import { usage } from "./codes.ts";

/**
 * The command line: `rail402 [global flags] <command> [subcommand] [arguments] [flags]`, parsed with
 * `node:util.parseArgs` in strict mode. Flags may appear anywhere; a flag that the command does not
 * take is refused rather than ignored, so a misspelt cap never goes unnoticed.
 */

type Option = { readonly type: "string" | "boolean"; readonly multiple?: boolean; readonly short?: string };

/** Flags every command takes. */
const GLOBAL_OPTIONS = {
  network: { type: "string" },
  "rpc-url": { type: "string" },
  "bazaar-url": { type: "string" },
  "facilitator-url": { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
  "key-file": { type: "string" },
  config: { type: "string" },
  "allow-http": { type: "boolean" },
  "allow-private-network": { type: "boolean" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const satisfies Record<string, Option>;

/** Flags that describe a call to a paid resource. */
const CALL_OPTIONS = {
  method: { type: "string" },
  query: { type: "string", multiple: true },
  header: { type: "string", multiple: true },
  data: { type: "string" },
  "data-file": { type: "string" },
  tool: { type: "string" },
  transport: { type: "string" },
  args: { type: "string" },
  "args-file": { type: "string" },
} as const satisfies Record<string, Option>;

const PAY_OPTIONS = {
  max: { type: "string" },
  asset: { type: "string" },
  scheme: { type: "string" },
  session: { type: "string" },
  "idempotency-key": { type: "string" },
} as const satisfies Record<string, Option>;

interface CommandSpec {
  readonly subcommands?: readonly string[];
  /** Positional arguments after the (sub)command: exact count, or "rest" to join them with spaces. */
  readonly positionals: number | "rest" | "optional";
  readonly options: Readonly<Record<string, Option>>;
}

export const COMMANDS = {
  search: {
    positionals: "rest",
    options: {
      type: { type: "string" },
      "max-price": { type: "string" },
      asset: { type: "string" },
      "pay-to": { type: "string" },
      scheme: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
  },
  resources: {
    positionals: 0,
    options: {
      type: { type: "string" },
      "pay-to": { type: "string" },
      scheme: { type: "string" },
      extensions: { type: "string", multiple: true },
      limit: { type: "string" },
      offset: { type: "string" },
      "as-of": { type: "string" },
    },
  },
  listing: { positionals: 1, options: { versions: { type: "boolean" } } },
  quote: { positionals: 1, options: { ...CALL_OPTIONS, max: { type: "string" }, asset: { type: "string" } } },
  pay: { positionals: 1, options: { ...CALL_OPTIONS, ...PAY_OPTIONS } },
  purchase: {
    positionals: "rest",
    options: {
      query: CALL_OPTIONS.query,
      header: CALL_OPTIONS.header,
      data: CALL_OPTIONS.data,
      "data-file": CALL_OPTIONS["data-file"],
      args: CALL_OPTIONS.args,
      "args-file": CALL_OPTIONS["args-file"],
      ...PAY_OPTIONS,
      pick: { type: "string" },
      type: { type: "string" },
      "path-param": { type: "string", multiple: true },
    },
  },
  tx: { positionals: 1, options: {} },
  session: {
    subcommands: ["show", "list", "start", "end", "reconcile"],
    positionals: 0,
    options: {
      name: { type: "string" },
      "max-total": { type: "string" },
      ttl: { type: "string" },
      force: { type: "boolean" },
    },
  },
  keys: {
    subcommands: ["new", "import", "show", "path"],
    positionals: 0,
    options: { name: { type: "string" } },
  },
  account: {
    subcommands: ["setup", "status"],
    positionals: "optional",
    options: { asset: { type: "string" }, usdc: { type: "string" }, yes: { type: "boolean" } },
  },
  seller: {
    subcommands: ["check", "validate"],
    positionals: 1,
    options: { method: { type: "string" }, tool: { type: "string" }, args: { type: "string" } },
  },
  version: { positionals: 0, options: {} },
  help: { positionals: "optional", options: {} },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

export type FlagValue = string | boolean | string[] | undefined;

export interface ParsedCommand {
  readonly command: CommandName;
  readonly subcommand: string | undefined;
  readonly positionals: readonly string[];
  /** Every flag given, by long name. */
  readonly flags: Readonly<Record<string, FlagValue>>;
}

const ALL_OPTIONS: Record<string, Option> = { ...GLOBAL_OPTIONS };
for (const spec of Object.values(COMMANDS) as CommandSpec[]) {
  for (const [name, option] of Object.entries(spec.options)) {
    const known = ALL_OPTIONS[name];
    if (known !== undefined && (known.type !== option.type || known.multiple !== option.multiple)) {
      throw new TypeError(`flag --${name} is declared with two different shapes`);
    }
    ALL_OPTIONS[name] = option;
  }
}

function isCommand(value: string | undefined): value is CommandName {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

/** Parses argv (without the node and script paths). */
/**
 * The command a command line names, for labelling a failure raised before it parses: `pay`, or
 * `session start`; `rail402` when no command is recognisable.
 */
export function commandLabel(argv: readonly string[]): string {
  let positionals: string[];
  try {
    positionals = parseArgs({
      args: [...argv],
      options: ALL_OPTIONS,
      strict: false,
      allowPositionals: true,
    }).positionals;
  } catch {
    return "rail402";
  }
  const [first, second] = positionals;
  if (!isCommand(first) || first === "help" || first === "version") return "rail402";
  const spec: CommandSpec = COMMANDS[first];
  return second !== undefined && spec.subcommands?.includes(second) === true ? `${first} ${second}` : first;
}

export function parseCommandLine(argv: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: ALL_OPTIONS,
      strict: true,
      allowPositionals: true,
      allowNegative: false,
    });
  } catch (error) {
    throw usage(
      error instanceof Error ? (error.message.split("\n")[0] ?? "Invalid arguments.") : "Invalid arguments.",
    );
  }
  const flags = parsed.values as Record<string, FlagValue>;
  const [first, ...rest] = parsed.positionals;

  if (first === undefined) {
    if (flags["version"] === true)
      return { command: "version", subcommand: undefined, positionals: [], flags };
    return { command: "help", subcommand: undefined, positionals: [], flags };
  }
  if (!isCommand(first)) throw usage(`Unknown command "${printable(first)}"; see rail402 --help.`);
  const spec: CommandSpec = COMMANDS[first];
  if (flags["help"] === true) return { command: "help", subcommand: undefined, positionals: [first], flags };

  let subcommand: string | undefined;
  let positionals = rest;
  if (spec.subcommands !== undefined) {
    const [candidate, ...after] = rest;
    if (candidate === undefined || !spec.subcommands.includes(candidate)) {
      throw usage(`rail402 ${first} needs one of: ${spec.subcommands.join(", ")}.`);
    }
    subcommand = candidate;
    positionals = after;
  }

  for (const name of Object.keys(flags)) {
    if (!Object.hasOwn(GLOBAL_OPTIONS, name) && !Object.hasOwn(spec.options, name)) {
      throw usage(
        `rail402 ${first}${subcommand === undefined ? "" : ` ${subcommand}`} does not take --${name}.`,
      );
    }
  }

  const label = `rail402 ${first}${subcommand === undefined ? "" : ` ${subcommand}`}`;
  if (spec.positionals === "rest") {
    if (positionals.length === 0) throw usage(`${label} needs a query.`);
    positionals = [positionals.join(" ")];
  } else if (spec.positionals === "optional") {
    if (positionals.length > 1) throw usage(`${label} takes at most one argument.`);
  } else if (positionals.length !== spec.positionals) {
    throw usage(
      spec.positionals === 0
        ? `${label} takes no arguments; got "${printable(positionals.join(" "))}".`
        : `${label} takes exactly ${String(spec.positionals)} argument.`,
    );
  }
  return { command: first, subcommand, positionals, flags };
}

/** Reads a string flag. */
export function stringFlag(flags: ParsedCommand["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Reads a repeatable string flag. */
export function listFlag(flags: ParsedCommand["flags"], name: string): readonly string[] {
  const value = flags[name];
  return Array.isArray(value) ? value : [];
}

export function booleanFlag(flags: ParsedCommand["flags"], name: string): boolean {
  return flags[name] === true;
}

/** Text from the command line, made safe to echo in an error. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}
