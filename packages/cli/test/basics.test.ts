import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { isRail402Error, mergeCodes } from "@rail402.dev/errors";
import { agentCodes, defaultPaid, paymentError, type Paid } from "@rail402.dev/sdk";
import { sellerCodes } from "@rail402.dev/sdk/seller";
import { EgressError } from "@rail402.dev/safe-fetch";
import {
  EXIT,
  cliCodes,
  cliErrorCodes,
  defaultPaidOf,
  exitStatusFor,
  failureFrom,
  parseCommandLine,
  toJson,
  type CliErrorCode,
} from "@rail402.dev/cli";

function usageReason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isRail402Error(error) && error.code === "cli_usage_invalid") return error.reason;
    throw error;
  }
  throw new Error("expected cli_usage_invalid");
}

describe("command line", () => {
  it("dispatches on the first positional and accepts flags anywhere", () => {
    const parsed = parseCommandLine([
      "--json",
      "pay",
      "https://api.example/x",
      "--max",
      "0.05",
      "--query",
      "a=1",
      "--query",
      "b=2",
    ]);
    expect(parsed).toMatchObject({
      command: "pay",
      subcommand: undefined,
      positionals: ["https://api.example/x"],
      flags: { json: true, max: "0.05", query: ["a=1", "b=2"] },
    });
  });

  it("joins a search query and requires one", () => {
    expect(parseCommandLine(["search", "current", "weather", "--limit", "3"]).positionals).toEqual([
      "current weather",
    ]);
    expect(usageReason(() => parseCommandLine(["search"]))).toContain("needs a query");
  });

  it("refuses flags a command does not take, unknown flags and unknown commands", () => {
    expect(usageReason(() => parseCommandLine(["search", "x", "--max", "1"]))).toContain(
      "does not take --max",
    );
    expect(usageReason(() => parseCommandLine(["pay", "u", "--maxx", "1"]))).toContain("--maxx");
    expect(usageReason(() => parseCommandLine(["purchase", "q", "--tool", "t"]))).toContain(
      "does not take --tool",
    );
    expect(usageReason(() => parseCommandLine(["bogus\u001b[31m"]))).toBe(
      'Unknown command "bogus[31m"; see rail402 --help.',
    );
  });

  it("has no flag that takes a secret", () => {
    for (const flag of ["--secret", "--secret-key", "--seed"]) {
      expect(usageReason(() => parseCommandLine(["pay", "u", flag, "S"]))).toContain(flag.slice(2));
    }
  });

  it("requires subcommands and checks argument counts", () => {
    expect(usageReason(() => parseCommandLine(["session"]))).toContain("show, list, start, end, reconcile");
    expect(usageReason(() => parseCommandLine(["keys", "delete"]))).toContain("new, import, show, path");
    expect(parseCommandLine(["session", "start", "--name", "trip", "--ttl", "2h"])).toMatchObject({
      command: "session",
      subcommand: "start",
      flags: { name: "trip", ttl: "2h" },
    });
    expect(usageReason(() => parseCommandLine(["tx"]))).toContain("exactly 1");
    expect(usageReason(() => parseCommandLine(["resources", "extra"]))).toContain("takes no arguments");
    expect(parseCommandLine(["account", "status", Keypair.random().publicKey()]).positionals).toHaveLength(1);
  });

  it("answers help and version", () => {
    expect(parseCommandLine([]).command).toBe("help");
    expect(parseCommandLine(["--version"]).command).toBe("version");
    expect(parseCommandLine(["pay", "--help"])).toMatchObject({ command: "help", positionals: ["pay"] });
  });
});

describe("codes and exit statuses", () => {
  it("merges the SDK, seller and CLI codes without clashes", () => {
    expect(() => mergeCodes(agentCodes, sellerCodes, cliCodes)).not.toThrow();
    expect(Object.keys(cliErrorCodes)).toHaveLength(
      Object.keys(agentCodes).length + Object.keys(sellerCodes).length + Object.keys(cliCodes).length,
    );
  });

  it("maps every code to a documented exit status by its default paid value", () => {
    const table: Record<string, number> = {};
    for (const code of Object.keys(cliErrorCodes) as CliErrorCode[]) {
      const spec = cliErrorCodes[code];
      const status = exitStatusFor({ code, paid: defaultPaidOf(code), retryable: spec.retryable });
      expect(status).toBeGreaterThanOrEqual(1);
      expect(status).toBeLessThanOrEqual(7);
      table[code] = status;
      // Retrying is only advertised when nothing was paid (payment_in_progress means: wait).
      if (spec.retryable && code !== "payment_in_progress") expect(defaultPaidOf(code)).toBe("none");
    }
    expect(table).toMatchObject({
      cli_usage_invalid: EXIT.usage,
      cli_config_invalid: EXIT.usage,
      key_file_insecure: EXIT.usage,
      payment_cap_required: EXIT.usage,
      payment_policy_invalid: EXIT.usage,
      payment_per_call_cap_exceeded: EXIT.refused,
      payment_session_cap_exceeded: EXIT.refused,
      payment_listing_mismatch: EXIT.refused,
      payment_fees_not_sponsored: EXIT.refused,
      payment_insufficient_funds: EXIT.refused,
      egress_destination_not_allowed: EXIT.refused,
      listing_not_payable: EXIT.refused,
      mcp_input_required_unsupported: EXIT.refused,
      payment_rejected: EXIT.rejected,
      payment_resource_failed: EXIT.paid,
      payment_settlement_unconfirmed: EXIT.paid,
      payment_redirect_after_payment: EXIT.paid,
      payment_in_progress: EXIT.paid,
      discovery_unavailable: EXIT.unavailable,
      rpc_unavailable: EXIT.unavailable,
      egress_timeout: EXIT.unavailable,
      mcp_protocol_error: EXIT.unavailable,
      payment_simulation_failed: EXIT.unavailable,
      account_friendbot_failed: EXIT.unavailable,
      cli_timeout: EXIT.unavailable,
      listing_not_found: EXIT.notFound,
      transaction_not_found: EXIT.notFound,
      mcp_tool_not_found: EXIT.notFound,
      account_not_found: EXIT.notFound,
      cli_internal_error: EXIT.internal,
    });
  });

  it("lets the paid value of an error decide first", () => {
    const paid = (value: Paid) =>
      exitStatusFor({ code: "cli_internal_error", paid: value, retryable: false });
    expect([paid("none"), paid("not_settled"), paid("settled"), paid("unknown")]).toEqual([1, 4, 5, 5]);
    expect(defaultPaid.payment_rejected).toBe("not_settled");
  });
});

describe("failures", () => {
  it("keeps an SDK error's code, paid value and receipt hash readable", () => {
    const hash = "d".repeat(64);
    const failure = failureFrom(
      paymentError("payment_resource_failed", {
        callId: "c-1",
        receipt: {
          status: "settled",
          scheme: "exact",
          network: "stellar:testnet",
          asset: "USDC",
          assetContract: "C",
          decimals: 7,
          authorized: { amount: "1", atomic: "10000000" },
          settled: null,
          payTo: "G",
          payer: "G",
          transaction: hash,
          explorerUrl: null,
          verifiedOnChain: true,
        },
      }),
      true,
    );
    expect(failure).toMatchObject({
      code: "payment_resource_failed",
      paid: "settled",
      retryable: false,
      details: { callId: "c-1", receipt: { transaction: hash } },
    });
  });

  it("reports an egress stage, a timeout, and redacts internal errors", () => {
    expect(failureFrom(new EgressError("egress_timeout", "response"), false)).toMatchObject({
      code: "egress_timeout",
      paid: "none",
      retryable: true,
      details: { stage: "response" },
    });
    const abort = new DOMException("aborted", "TimeoutError");
    expect(failureFrom(abort, false)).toMatchObject({ code: "cli_timeout", paid: "none", retryable: true });
    expect(failureFrom(abort, true)).toMatchObject({
      code: "cli_timeout",
      paid: "unknown",
      retryable: false,
    });
    const seed = Keypair.random().secret();
    const internal = failureFrom(new Error(`boom ${seed}`), true);
    expect(internal).toMatchObject({ code: "cli_internal_error", paid: "unknown" });
    expect(internal.reason).not.toContain(seed);
  });

  it("escapes terminal control characters that JSON leaves raw", () => {
    const text = toJson({ note: "a\u009b31mb‮c" });
    expect(text).toBe('{"note":"a\\u009b31mb\\u202ec"}');
    expect(JSON.parse(text)).toEqual({ note: "a\u009b31mb‮c" });
    expect(toJson({ amount: 10n })).toBe('{"amount":"10"}');
  });
});
