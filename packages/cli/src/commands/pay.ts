import {
  paymentError,
  type CallResult,
  type HttpOutcome,
  type McpOutcome,
  type SearchHit,
  type SearchPage,
} from "@rail402.dev/sdk";
import { stringFlag } from "../args.ts";
import { EXIT } from "../codes.ts";
import type { CommandHandler, CommandOutcome } from "../command.ts";
import { clean, fields, pretty } from "../output.ts";
import { hitText } from "./discovery.ts";
import {
  budgetLines,
  callInputFrom,
  capFlag,
  receiptLines,
  requiredCap,
  schemeFlag,
  targetFrom,
  typeFlag,
  withBuyer,
} from "./common.ts";

/** `rail402 quote <url>`: the unpaid probe and each payment option's verdict. Never signs. */
export const quote: CommandHandler = {
  pays: false,
  run: (input) =>
    withBuyer(input, { signer: true }, async ({ buyer }) => {
      const target = targetFrom(input.parsed.positionals[0] ?? "", input.parsed.flags);
      const maxAmount = capFlag(input.parsed.flags);
      if (target.kind === "mcp" && !input.context.json) {
        input.io.stderr("note: quoting an MCP tool calls it unpaid; a free tool runs.\n");
      }
      const result = await buyer.quote(target, {
        ...(maxAmount === undefined ? {} : { maxAmount }),
        signal: input.signal,
      });
      for (const warning of input.context.json ? [] : result.warnings) {
        input.io.stderr(`warning: ${clean(warning)}\n`);
      }
      return {
        result,
        human: () => {
          if (!result.paymentRequired) {
            return `${clean(result.resource)} answered ${String(result.status)} without asking for payment.`;
          }
          const lines = result.options.map((option) => {
            const price = `${option.amount ?? `${option.atomic} base units of`} ${clean(option.asset)}`;
            const verdict = option.acceptable
              ? option.index === result.chosen
                ? "acceptable (chosen)"
                : "acceptable"
              : `refused: ${option.refused?.code ?? "unknown"}: ${clean(option.refused?.reason ?? "")}`;
            return `  [${String(option.index)}] ${option.scheme} ${price} to ${option.payTo}, ${verdict}`;
          });
          const head = `${clean(result.resource)} asks for payment (${String(result.options.length)} option${result.options.length === 1 ? "" : "s"}):`;
          const tail =
            result.refused === null
              ? []
              : [`No option is acceptable: ${result.refused.code}: ${clean(result.refused.reason)}`];
          return [head, ...lines, ...tail].join("\n");
        },
      };
    }),
};

/** `rail402 pay <url> --max <amount>`: pays an HTTP resource or MCP tool given by URL. */
export const pay: CommandHandler = {
  pays: true,
  run: (input) => {
    const target = targetFrom(input.parsed.positionals[0] ?? "", input.parsed.flags);
    const maxAmount = requiredCap(input.parsed.flags);
    const scheme = schemeFlag(input.parsed.flags);
    const idempotencyKey = stringFlag(input.parsed.flags, "idempotency-key");
    return withBuyer(input, { signer: true, requireSigner: true }, async ({ buyer }) => {
      const result = await buyer.pay(target, {
        maxAmount,
        ...(scheme === undefined ? {} : { scheme }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        signal: input.signal,
      });
      return paidOutcome(result, undefined);
    });
  },
};

/** `rail402 purchase <query> --max <amount>`: searches, picks a result, pays it through its listing. */
export const purchase: CommandHandler = {
  pays: true,
  run: (input) => {
    const { flags } = input.parsed;
    const query = input.parsed.positionals[0] ?? "";
    const maxAmount = requiredCap(flags);
    const scheme = schemeFlag(flags);
    const type = typeFlag(flags);
    const idempotencyKey = stringFlag(flags, "idempotency-key");
    const call = callInputFrom(flags);
    const pickText = stringFlag(flags, "pick");
    return withBuyer(input, { signer: true, requireSigner: true }, async ({ buyer }) => {
      const result = await buyer.searchAndPay(query, {
        maxAmount,
        ...(scheme === undefined ? {} : { scheme }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(type === undefined ? {} : { filters: { type } }),
        ...(pickText === undefined ? {} : { pick: picker(pickText) }),
        call,
        signal: input.signal,
      });
      return paidOutcome(result, result.chosen);
    });
  },
};

/** `--pick 2` takes the second result; `--pick <listing id>` takes that listing. */
function picker(text: string): (page: SearchPage) => SearchPage["hits"][number] {
  return (page) => {
    const position = /^[1-9][0-9]{0,2}$/.test(text) ? Number(text) : undefined;
    const hit =
      position === undefined ? page.hits.find((item) => item.listingId === text) : page.hits[position - 1];
    if (hit === undefined) {
      throw paymentError("listing_not_found", {
        reason: `The search returned ${String(page.hits.length)} result${page.hits.length === 1 ? "" : "s"}; --pick ${text.slice(0, 64)} is not one of them.`,
      });
    }
    return hit;
  };
}

function paidOutcome(result: CallResult, chosen: SearchHit | undefined): CommandOutcome {
  // A payment was sent but its settlement is not known: the result stands, and a retry is unsafe.
  const exit = result.payment?.status === "unknown" ? EXIT.paid : EXIT.ok;
  return {
    result: chosen === undefined ? result : { ...result, chosen },
    exit,
    human: () => {
      const lines: string[] = [];
      if (chosen !== undefined) lines.push(`chose:\n${hitText(chosen, undefined)}`, "");
      if (result.replayed)
        lines.push("replayed: the stored result of an earlier call with this key; nothing was paid again.");
      if (result.payment === null) lines.push("paid:        nothing (the resource did not ask for payment)");
      else lines.push(...receiptLines(result.payment));
      if (result.budget !== null)
        lines.push(`budget (session ${result.budget.session}):`, ...budgetLines(result.budget));
      lines.push("", responseText(result.response));
      return lines.join("\n");
    },
  };
}

function responseText(response: HttpOutcome | McpOutcome): string {
  if (response.kind === "http") {
    const head = fields([
      ["status", String(response.status)],
      ["content-type", response.contentType],
      ["bytes", String(response.bytes)],
      ["truncated", response.truncated ? "yes" : undefined],
    ]);
    const body = response.json !== undefined ? pretty(response.json) : clean(response.text ?? "", 65_536);
    return `${head}\n\n${body}`;
  }
  const head = `tool result${response.isError ? " (error)" : ""}${response.truncated ? " (truncated)" : ""}:`;
  const parts = response.content.map((item) => clean(item.text, 65_536));
  if (response.structuredContent !== undefined) parts.push(pretty(response.structuredContent));
  return [head, ...parts].join("\n");
}
