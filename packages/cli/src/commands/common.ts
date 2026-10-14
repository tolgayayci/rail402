import { readFileSync, statSync } from "node:fs";
import { isRail402Error } from "@rail402.dev/errors";
import {
  HTTP_METHODS,
  paymentError,
  parseMoney,
  type BudgetSnapshot,
  type CallInput,
  type HttpMethod,
  type Money,
  type PaymentEventListener,
  type PaymentTarget,
  type QueryInput,
  type Receipt,
  type SchemeName,
} from "@rail402.dev/sdk";
import { listFlag, printable, stringFlag, type ParsedCommand } from "../args.ts";
import { usage } from "../codes.ts";
import type { CommandInput } from "../command.ts";
import { clean, toJson } from "../output.ts";
import type { OpenBuyerOptions, OpenedBuyer } from "../runtime.ts";

type Flags = ParsedCommand["flags"];

/** Largest request body or argument file read from disk. */
const MAX_INPUT_FILE_BYTES = 65_536;

/** Opens the buyer, runs `body`, and always closes it. */
export async function withBuyer<T>(
  input: CommandInput,
  options: Omit<OpenBuyerOptions, "onEvent">,
  body: (opened: OpenedBuyer) => Promise<T>,
): Promise<T> {
  const opened = await input.deps.openBuyer(input.context, {
    ...options,
    ...(input.context.verbose ? { onEvent: eventWriter(input) } : {}),
  });
  try {
    return await body(opened);
  } finally {
    await opened.close();
  }
}

/** --verbose: payment events as JSON lines on stderr. Events carry no secrets or payloads. */
function eventWriter(input: CommandInput): PaymentEventListener {
  return (event) => {
    input.io.stderr(`${toJson({ event })}\n`);
  };
}

export function integerFlag(flags: Flags, name: string, min: number, max: number): number | undefined {
  const text = stringFlag(flags, name);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!/^[0-9]{1,9}$/.test(text) || value < min || value > max) {
    throw usage(`--${name} is an integer from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

export function typeFlag(flags: Flags): "http" | "mcp" | undefined {
  const type = stringFlag(flags, "type");
  if (type === undefined || type === "http" || type === "mcp") return type;
  throw usage('--type is "http" or "mcp".');
}

export function schemeFlag(flags: Flags): SchemeName | undefined {
  const scheme = stringFlag(flags, "scheme");
  if (scheme === undefined || scheme === "exact" || scheme === "upto") return scheme;
  throw usage('--scheme is "exact" or "upto".');
}

/**
 * The per-call cap: `--max 0.05`, `--max "0.05 USDC"`, or `--max 0.05 --asset USDC`. Without an asset
 * the SDK uses the policy's first asset (USDC by default).
 */
export function capFlag(flags: Flags): Money | undefined {
  const text = stringFlag(flags, "max");
  const asset = stringFlag(flags, "asset");
  if (text === undefined) {
    if (asset !== undefined) throw usage("--asset names the asset of --max; add --max.");
    return undefined;
  }
  const money = parseMoney(text);
  if (money === undefined) {
    throw paymentError("payment_cap_invalid", {
      reason: '--max is a decimal amount and an optional asset, e.g. "0.05" or "0.05 USDC".',
    });
  }
  if (asset !== undefined && money.asset !== undefined && money.asset !== asset) {
    throw paymentError("payment_cap_invalid", {
      reason: `--max names ${money.asset} but --asset names ${printable(asset)}.`,
    });
  }
  const chosen = money.asset ?? asset;
  return chosen === undefined ? { amount: money.amount } : { amount: money.amount, asset: chosen };
}

/** The cap of a payment, which is required. */
export function requiredCap(flags: Flags): Money {
  const cap = capFlag(flags);
  if (cap === undefined) {
    throw paymentError("payment_cap_required", {
      reason: 'Every payment needs a per-call cap: add --max, e.g. --max "0.05 USDC".',
    });
  }
  return cap;
}

/** The resource to pay or quote, from a URL and the call flags. */
export function targetFrom(url: string, flags: Flags): PaymentTarget {
  const tool = stringFlag(flags, "tool");
  if (tool !== undefined) {
    for (const name of ["method", "query", "header", "data", "data-file"]) {
      if (flags[name] !== undefined)
        throw usage(`--${name} applies to HTTP resources; an MCP tool takes --args.`);
    }
    const transport = stringFlag(flags, "transport");
    if (transport !== undefined && transport !== "streamable-http" && transport !== "sse") {
      throw usage('--transport is "streamable-http" or "sse".');
    }
    const args = argumentsFrom(flags);
    return {
      kind: "mcp",
      url,
      toolName: tool,
      ...(args === undefined ? {} : { arguments: args }),
      ...(transport === undefined ? {} : { transport }),
    };
  }
  for (const name of ["args", "args-file", "transport"]) {
    if (flags[name] !== undefined) throw usage(`--${name} applies to MCP tools; add --tool.`);
  }
  const methodText = stringFlag(flags, "method")?.toUpperCase();
  if (methodText !== undefined && !HTTP_METHODS.includes(methodText as HttpMethod)) {
    throw usage(`--method is one of ${HTTP_METHODS.join(", ")}.`);
  }
  const call = httpCall(flags);
  return {
    kind: "http",
    url,
    ...(methodText === undefined ? {} : { method: methodText as HttpMethod }),
    ...(call.query === undefined ? {} : { query: call.query }),
    ...(call.headers === undefined ? {} : { headers: call.headers }),
    ...(call.body === undefined ? {} : { body: call.body }),
  };
}

/** How to call a listing chosen by `purchase`. */
export function callInputFrom(flags: Flags): CallInput {
  const call = httpCall(flags);
  const args = argumentsFrom(flags);
  const pathParams = pairs(listFlag(flags, "path-param"), "=", "--path-param", "name=value");
  return {
    ...call,
    ...(args === undefined ? {} : { arguments: args }),
    ...(pathParams === undefined ? {} : { pathParams }),
  };
}

function httpCall(flags: Flags): Pick<CallInput, "query" | "headers" | "body"> {
  const query = queryFrom(listFlag(flags, "query"));
  const headers = pairs(listFlag(flags, "header"), ":", "--header", "name: value");
  const data = stringFlag(flags, "data");
  const dataFile = stringFlag(flags, "data-file");
  if (data !== undefined && dataFile !== undefined) throw usage("Give --data or --data-file, not both.");
  const body =
    data !== undefined
      ? json(data, "--data")
      : dataFile !== undefined
        ? json(readInputFile(dataFile, "--data-file"), "--data-file")
        : undefined;
  return {
    ...(query === undefined ? {} : { query }),
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

/** MCP tool arguments: a JSON object from --args or --args-file. */
function argumentsFrom(flags: Flags): Readonly<Record<string, unknown>> | undefined {
  const text = stringFlag(flags, "args");
  const file = stringFlag(flags, "args-file");
  if (text !== undefined && file !== undefined) throw usage("Give --args or --args-file, not both.");
  if (text === undefined && file === undefined) return undefined;
  const value =
    text !== undefined
      ? json(text, "--args")
      : json(readInputFile(file as string, "--args-file"), "--args-file");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw usage("Tool arguments are a JSON object.");
  }
  return value as Record<string, unknown>;
}

function queryFrom(items: readonly string[]): QueryInput | undefined {
  if (items.length === 0) return undefined;
  const query: Record<string, string | string[]> = {};
  for (const item of items) {
    const index = item.indexOf("=");
    if (index < 1) throw usage("--query is name=value.");
    const name = item.slice(0, index);
    const value = item.slice(index + 1);
    const known = query[name];
    query[name] = known === undefined ? value : Array.isArray(known) ? [...known, value] : [known, value];
  }
  return query;
}

function pairs(
  items: readonly string[],
  separator: string,
  flag: string,
  shape: string,
): Record<string, string> | undefined {
  if (items.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const item of items) {
    const index = item.indexOf(separator);
    if (index < 1) throw usage(`${flag} is ${shape}.`);
    result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

/** Request bodies and tool arguments are JSON. */
function json(text: string, flag: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usage(`${flag} must be valid JSON.`);
  }
}

function readInputFile(path: string, flag: string): string {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_INPUT_FILE_BYTES) {
      throw usage(`${flag} must name a regular file of at most 64 KiB.`);
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isRail402Error(error)) throw error;
    throw usage(`${flag}: the file could not be read.`);
  }
}

/** One line per asset of a budget snapshot. */
export function budgetLines(budget: BudgetSnapshot): string[] {
  return budget.assets.map(
    (asset) =>
      `  ${asset.asset}: spent ${asset.spent}, pending ${asset.pending}, remaining ${asset.remaining} of ${asset.sessionCap} (per call ≤ ${asset.perCallCap})`,
  );
}

export function receiptLines(receipt: Receipt): string[] {
  const settled = receipt.settled ?? receipt.authorized;
  return [
    `paid:        ${settled.amount} ${clean(receipt.asset)} to ${receipt.payTo} (${receipt.status}${receipt.verifiedOnChain ? ", verified on chain" : ""})`,
    ...(receipt.scheme === "upto"
      ? [
          `authorized:  up to ${receipt.authorized.amount} ${clean(receipt.asset)} (upto; ${receipt.verifiedOnChain ? "the rest of the cap is back in the budget" : "the rest of the cap stays pending until the chain proves the settlement"})`,
        ]
      : []),
    ...(receipt.transaction === null ? [] : [`transaction: ${receipt.transaction}`]),
    ...(receipt.explorerUrl === null ? [] : [`explorer:    ${receipt.explorerUrl}`]),
  ];
}
