import { readFileSync, statSync } from "node:fs";
import { HTTP_METHODS, type HttpMethod } from "@rail402.dev/sdk";
import type { OriginReport, ValidationReport } from "@rail402.dev/sdk/seller";
import { stringFlag } from "../args.ts";
import { EXIT, usage } from "../codes.ts";
import type { CommandHandler, CommandInput, CommandOutcome } from "../command.ts";
import { clean, fields } from "../output.ts";

/**
 * `rail402 seller check <url>` checks a live paid resource the way the Rail402 catalog will: the
 * unpaid request, the catalog's own validation of its discovery metadata, whether payTo can receive
 * the asset, whether the facilitator settles it, and the domain's stellar.toml claim.
 * `rail402 seller validate <file>` runs the catalog's validation on a saved PAYMENT-REQUIRED (JSON,
 * or the header's base64) and shows the listing it would produce.
 *
 * Both exit 0 when the resource would be cataloged and 3 when not; nothing is signed.
 */
export const seller: CommandHandler = {
  pays: false,
  run: (input) => (input.parsed.subcommand === "check" ? check(input) : validate(input)),
};

const MAX_FILE_BYTES = 65_536;

async function check(input: CommandInput): Promise<CommandOutcome> {
  const { flags } = input.parsed;
  const url = input.parsed.positionals[0] ?? "";
  const tool = stringFlag(flags, "tool");
  const method = methodFlag(input);
  const argsText = stringFlag(flags, "args");
  if (tool === undefined && argsText !== undefined) throw usage("--args applies to MCP tools; add --tool.");
  if (tool !== undefined && method !== undefined)
    throw usage("--method applies to HTTP resources, not MCP tools.");
  let args: unknown;
  if (argsText !== undefined) {
    try {
      args = JSON.parse(argsText) as unknown;
    } catch {
      throw usage("--args must be valid JSON.");
    }
    if (args === null || typeof args !== "object" || Array.isArray(args))
      throw usage("--args is a JSON object.");
  }
  const { agent, facilitatorUrl } = input.context;
  const { checkSellerOrigin } = await import("@rail402.dev/sdk/seller");
  const report = await checkSellerOrigin(url, {
    network: agent.network,
    rpcUrl: agent.rpcUrl,
    ...(facilitatorUrl === undefined ? {} : { facilitatorUrl }),
    ...(method === undefined ? {} : { method }),
    ...(tool === undefined ? {} : { toolName: tool }),
    ...(args === undefined ? {} : { arguments: args as Record<string, unknown> }),
    allowLoopback: agent.egress.allowPrivateNetwork === "loopback",
    signal: input.signal,
  });
  return {
    result: report,
    exit: report.ok ? EXIT.ok : EXIT.refused,
    human: () => originText(report),
  };
}

async function validate(input: CommandInput): Promise<CommandOutcome> {
  const path = input.parsed.positionals[0] ?? "";
  const required = readPaymentRequired(path);
  const method = methodFlag(input);
  const { validateListing } = await import("@rail402.dev/sdk/seller");
  const report = await validateListing(required as Parameters<typeof validateListing>[0], {
    network: input.context.network,
    allowLoopback: input.context.agent.egress.allowPrivateNetwork === "loopback",
    ...(method === undefined ? {} : { method }),
  });
  return {
    result: report,
    exit: report.catalogable ? EXIT.ok : EXIT.refused,
    human: () => validationText(report),
  };
}

function methodFlag(input: CommandInput): HttpMethod | undefined {
  const text = stringFlag(input.parsed.flags, "method")?.toUpperCase();
  if (text === undefined) return undefined;
  if (!HTTP_METHODS.includes(text as HttpMethod))
    throw usage(`--method is one of ${HTTP_METHODS.join(", ")}.`);
  return text as HttpMethod;
}

/** A PaymentRequired from a file: JSON, or the base64 PAYMENT-REQUIRED header value. */
function readPaymentRequired(path: string): unknown {
  let text: string;
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("not a small file");
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw usage("rail402 seller validate needs a readable file of at most 64 KiB.");
  }
  const decoded = text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(decoded);
  } catch {
    throw usage("The file holds neither PaymentRequired JSON nor a base64 PAYMENT-REQUIRED header value.");
  }
  const shaped = body as { x402Version?: unknown; accepts?: unknown; resource?: unknown } | null;
  if (
    shaped === null ||
    typeof shaped !== "object" ||
    shaped.x402Version !== 2 ||
    !Array.isArray(shaped.accepts)
  ) {
    throw usage("The file is not an x402 version 2 PaymentRequired (x402Version 2 and an accepts list).");
  }
  if (shaped.resource === null || typeof shaped.resource !== "object") {
    throw usage("The PaymentRequired has no resource.");
  }
  return body;
}

function originText(report: OriginReport): string {
  const lines = [
    fields([
      ["resource", report.url],
      ["type", report.type],
      ["status", report.status === undefined ? undefined : String(report.status)],
      ["result", report.ok ? "ok: the catalog would list it after a settlement" : "problems found"],
      [
        "domain",
        report.domain === undefined
          ? undefined
          : `${report.domain.host} ${report.domain.claimsOwner ? "lists payTo in its stellar.toml" : "does not list payTo in a stellar.toml"}${
              report.domain.homeDomainMatches === undefined
                ? ""
                : report.domain.homeDomainMatches
                  ? "; payTo names it as its home_domain"
                  : "; payTo does not name it as its home_domain"
            }`,
      ],
    ]),
  ];
  if (report.validation !== undefined) lines.push(validationText(report.validation));
  for (const item of report.receivable ?? []) {
    const state =
      item.receivable === undefined ? "undecidable" : item.receivable ? "can receive" : "cannot receive";
    lines.push(`payTo ${item.payTo} ${state} ${item.asset}`);
  }
  for (const finding of report.findings) lines.push(`finding: ${finding.code}: ${clean(finding.reason)}`);
  return lines.join("\n");
}

function validationText(report: ValidationReport): string {
  const lines = [
    report.catalogable
      ? "catalog: would be listed"
      : `catalog: would not be listed: ${report.code ?? "unknown"}: ${clean(report.reason ?? "")}`,
  ];
  if (report.preview !== undefined) {
    const { preview } = report;
    lines.push(
      fields([
        ["listing", `${preview.type} ${preview.method ?? preview.toolName ?? ""}`.trim()],
        ["resource", preview.resource],
        ["route", preview.routeTemplate],
        ["payTo", preview.payTo],
        ["price", `${preview.amount} base units of ${preview.asset}`],
      ]),
    );
  }
  if (report.dropped.length > 0)
    lines.push(`dropped by the catalog: ${report.dropped.map((item) => clean(item)).join(", ")}`);
  for (const item of report.lint)
    lines.push(`advice: ${item.code} at ${clean(item.path)}: ${clean(item.reason)}`);
  return lines.join("\n");
}
