import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { paymentError, type CallResult, type PayOptions, type PaymentTarget } from "@rail402.dev/sdk";
import { COMMANDS, EXIT } from "@rail402.dev/cli";
import {
  LISTING_ID,
  TX_HASH,
  budgetSnapshot,
  cli,
  fakeBuyer,
  hit,
  openWith,
  paidResult,
  sandboxHome,
  seller,
  type FakeBuyer,
} from "./helpers.ts";

let home: ReturnType<typeof sandboxHome>;
beforeEach(() => {
  home = sandboxHome();
});
afterEach(() => {
  home.dispose();
});

const run = (argv: string[], buyer: FakeBuyer, env: Record<string, string> = {}) =>
  cli(argv, { ...home.env, ...env }, { openBuyer: openWith(buyer) });

describe("output contract", () => {
  it("writes exactly one success document with the command and network", async () => {
    const buyer = fakeBuyer();
    const result = await run(["search", "weather", "--json", "--type", "http", "--limit", "5"], buyer);
    expect(result.status).toBe(EXIT.ok);
    expect(result.stderr).toBe("");
    expect(result.json()).toMatchObject({
      v: 1,
      ok: true,
      command: "search",
      network: "stellar:testnet",
      result: {
        query: "weather",
        hits: [{ listingId: LISTING_ID }],
        nextCursor: null,
        partialResults: false,
      },
    });
    expect(buyer.calls[0]?.method).toBe("search");
    expect(buyer.calls[0]?.args.slice(0, 2)).toMatchObject(["weather", { type: "http", limit: 5 }]);
  });

  it("selects JSON through RAIL402_OUTPUT and writes one failure document", async () => {
    const buyer = fakeBuyer({
      search: () => Promise.reject(paymentError("discovery_unavailable")),
    });
    const result = await run(["search", "weather"], buyer, { RAIL402_OUTPUT: "json" });
    expect(result.status).toBe(EXIT.unavailable);
    expect(result.json()).toEqual({
      v: 1,
      ok: false,
      command: "search",
      error: {
        code: "discovery_unavailable",
        reason: "The Bazaar is unreachable or failed; retry shortly.",
        retryable: true,
        paid: "none",
      },
    });
  });

  it("reports usage errors in the selected format", async () => {
    const buyer = fakeBuyer();
    const text = await run(["search", "x", "--limit", "0"], buyer);
    expect(text.status).toBe(EXIT.usage);
    expect(text.stdout).toBe("");
    expect(text.stderr).toBe("error: cli_usage_invalid: --limit is an integer from 1 to 50.\n");
    const json = await run(["--json", "resources", "--nope"], buyer);
    expect(json.json()).toMatchObject({
      ok: false,
      command: "resources",
      error: { code: "cli_usage_invalid" },
    });
    expect((await run(["pay", "--json"], buyer)).json()).toMatchObject({ ok: false, command: "pay" });
    expect((await run(["session", "start", "--json", "--bogus"], buyer)).json()).toMatchObject({
      command: "session start",
    });
    expect((await run(["--json", "bogus"], buyer)).json()).toMatchObject({ command: "rail402" });
  });

  it("answers help as one JSON document with --json", async () => {
    const help = await run(["--help", "--json"], fakeBuyer());
    expect(help.status).toBe(EXIT.ok);
    const document = help.json() as { ok: boolean; command: string; result: { text: string } };
    expect(document).toMatchObject({ ok: true, command: "help" });
    expect(document.result.text).toContain("rail402");
    expect((await run(["pay", "--help", "--json"], fakeBuyer())).json()).toMatchObject({ command: "help" });
  });

  it("names every flag a command takes, and both schemes, in the help", async () => {
    const help = await run(["--help", "--json"], fakeBuyer());
    const text = (help.json() as { result: { text: string } }).result.text;
    for (const [command, spec] of Object.entries(COMMANDS)) {
      if (command === "help" || command === "version") continue;
      for (const flag of Object.keys(spec.options))
        expect(text, `${command} --${flag}`).toContain(`--${flag}`);
    }
    expect(text.match(/--scheme exact\|upto/g)).toHaveLength(3);
    expect(text).not.toMatch(/--scheme exact(?!\|upto)/);
  });

  it("never opens a key for commands that only read", async () => {
    const buyer = fakeBuyer();
    const open = openWith(buyer);
    for (const argv of [["search", "q"], ["resources"], ["listing", LISTING_ID], ["tx", TX_HASH]]) {
      await cli(argv, home.env, { openBuyer: open });
    }
    expect(open.opened.every((entry) => !entry.signer)).toBe(true);
  });
});

describe("discovery commands", () => {
  it("lists resources with the discovery filters", async () => {
    const buyer = fakeBuyer();
    const result = await run(
      [
        "resources",
        "--type",
        "mcp",
        "--extensions",
        "bazaar,other",
        "--offset",
        "10",
        "--limit",
        "20",
        "--as-of",
        "2026-09-30T00:00:00Z",
      ],
      buyer,
    );
    expect(result.status).toBe(0);
    expect(buyer.calls[0]?.args[0]).toMatchObject({
      type: "mcp",
      extensions: ["bazaar", "other"],
      offset: 10,
      limit: 20,
      asOf: "2026-09-30T00:00:00Z",
    });
    expect(result.stdout).toContain("Weather  [http GET]  0.001 USDC");
  });

  it("shows a listing and its versions", async () => {
    const buyer = fakeBuyer({
      listingVersions: () =>
        Promise.resolve([
          {
            version: 1,
            createdAt: "2026-09-30T00:00:00.000Z",
            cause: "settlement",
            transaction: TX_HASH,
            owner: seller,
            trust: "settled",
            state: "published",
            content: {},
          },
        ]),
    });
    const result = await run(["listing", LISTING_ID, "--versions", "--json"], buyer);
    expect(result.json().result).toMatchObject({
      listing: { state: "published" },
      versions: [{ version: 1 }],
    });
    const text = await run(["listing", LISTING_ID, "--versions"], buyer);
    expect(text.stdout).toContain(`v1  2026-09-30T00:00:00.000Z  settlement  published  ${TX_HASH}`);
  });

  it("strips terminal controls from seller text in human output", async () => {
    const buyer = fakeBuyer({
      search: () =>
        Promise.resolve({
          hits: [
            hit({
              seller: { serviceName: "Evil\u001b[2J\u009b1m", description: "x‮y", tags: [], mimeType: null },
            }),
          ],
          nextCursor: null,
          partialResults: false,
          method: "bm25",
        }),
    });
    const result = await run(["search", "q"], buyer);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/[\u001b\u009b‮]/);
    expect(result.stdout).toContain("Evil[2J1m");
  });
});

describe("pay", () => {
  it("requires --max, before any key is read", async () => {
    const buyer = fakeBuyer();
    const open = openWith(buyer);
    const result = await cli(["pay", "https://api.example/x", "--json"], home.env, { openBuyer: open });
    expect(result.status).toBe(EXIT.usage);
    expect(result.json().error).toMatchObject({ code: "payment_cap_required", paid: "none" });
    expect(open.opened).toHaveLength(0);
  });

  it("builds the HTTP target and payment options from the flags", async () => {
    const buyer = fakeBuyer();
    const result = await run(
      [
        "pay",
        "https://api.example/search",
        "--method",
        "post",
        "--query",
        "q=a",
        "--query",
        "q=b",
        "--header",
        "accept: application/json",
        "--data",
        '{"n":1}',
        "--max",
        "0.05 USDC",
        "--idempotency-key",
        "order-1234",
        "--scheme",
        "exact",
        "--json",
      ],
      buyer,
    );
    expect(result.status).toBe(0);
    const [target, options] = buyer.calls[0]?.args as [PaymentTarget, PayOptions];
    expect(target).toEqual({
      kind: "http",
      url: "https://api.example/search",
      method: "POST",
      query: { q: ["a", "b"] },
      headers: { accept: "application/json" },
      body: { n: 1 },
    });
    expect(options).toMatchObject({
      maxAmount: { amount: "0.05", asset: "USDC" },
      idempotencyKey: "order-1234",
      scheme: "exact",
    });
    expect(result.json().result).toMatchObject({ paid: true, payment: { transaction: TX_HASH } });
  });

  it("builds an MCP tool target and refuses HTTP flags with it", async () => {
    const buyer = fakeBuyer();
    await run(
      [
        "pay",
        "https://mcp.example/mcp",
        "--tool",
        "forecast",
        "--args",
        '{"city":"Ankara"}',
        "--max",
        "0.01",
      ],
      buyer,
    );
    expect(buyer.calls[0]?.args[0]).toEqual({
      kind: "mcp",
      url: "https://mcp.example/mcp",
      toolName: "forecast",
      arguments: { city: "Ankara" },
    });
    const refused = await run(
      ["pay", "https://mcp.example/mcp", "--tool", "t", "--query", "a=1", "--max", "1"],
      buyer,
    );
    expect(refused.status).toBe(EXIT.usage);
    expect(refused.stderr).toContain("--query applies to HTTP resources");
    const args = await run(
      ["pay", "https://x.example/", "--args", "[1]", "--tool", "t", "--max", "1"],
      buyer,
    );
    expect(args.stderr).toContain("Tool arguments are a JSON object.");
  });

  it("refuses a cap whose asset disagrees with --asset", async () => {
    const result = await run(
      ["pay", "https://x.example/", "--max", "1 USDC", "--asset", "EURC", "--json"],
      fakeBuyer(),
    );
    expect(result.json().error).toMatchObject({ code: "payment_cap_invalid" });
    expect(result.status).toBe(EXIT.usage);
  });

  it("prints the receipt, budget and response", async () => {
    const result = await run(["pay", "https://api.example/x", "--max", "0.01"], fakeBuyer());
    expect(result.stdout).toContain(`paid:        0.001 USDC to ${seller} (settled, verified on chain)`);
    expect(result.stdout).toContain(`transaction: ${TX_HASH}`);
    expect(result.stdout).toContain("USDC: spent 0.001, pending 0, remaining 0.999 of 1");
    expect(result.stdout).toContain('"temperature": 21');
  });

  it("exits 5 when a payment may have moved money, and 4 when it was refused", async () => {
    const unconfirmed = fakeBuyer({
      pay: () => Promise.reject(paymentError("payment_settlement_unconfirmed", { callId: "call-9" })),
    });
    const failed = await run(["pay", "https://api.example/x", "--max", "0.01", "--json"], unconfirmed);
    expect(failed.status).toBe(EXIT.paid);
    expect(failed.json().error).toMatchObject({
      code: "payment_settlement_unconfirmed",
      paid: "unknown",
      details: { callId: "call-9" },
    });
    const human = await run(["pay", "https://api.example/x", "--max", "0.01"], unconfirmed);
    expect(human.stderr).toContain(
      "paid: unknown (money may have moved; check rail402 session show before retrying)",
    );

    const rejected = fakeBuyer({ pay: () => Promise.reject(paymentError("payment_rejected")) });
    expect((await run(["pay", "https://api.example/x", "--max", "0.01"], rejected)).status).toBe(
      EXIT.rejected,
    );

    const unknownReceipt = paidResult();
    const pending: CallResult = {
      ...unknownReceipt,
      payment:
        unknownReceipt.payment === null
          ? null
          : { ...unknownReceipt.payment, status: "unknown", settled: null },
    };
    const result = await run(
      ["pay", "https://api.example/x", "--max", "0.01", "--json"],
      fakeBuyer({ pay: () => Promise.resolve(pending) }),
    );
    expect(result.status).toBe(EXIT.paid);
    expect(result.json()).toMatchObject({ ok: true, result: { payment: { status: "unknown" } } });
  });

  it("treats an unexpected failure during a payment as possibly paid", async () => {
    const buyer = fakeBuyer({ pay: () => Promise.reject(new TypeError("socket went away")) });
    const result = await run(["pay", "https://api.example/x", "--max", "0.01", "--json"], buyer);
    expect(result.status).toBe(EXIT.paid);
    expect(result.json().error).toMatchObject({ code: "cli_internal_error", paid: "unknown" });
  });
});

describe("purchase", () => {
  it("searches and pays the picked listing with the call input", async () => {
    const second = hit({ listingId: "11111111-2222-4333-8444-555555555555" });
    let picked: unknown;
    const buyer = fakeBuyer({
      searchAndPay: (_query, options) => {
        picked = options.pick?.({
          hits: [hit(), second],
          nextCursor: null,
          partialResults: false,
          method: "hybrid",
        });
        return Promise.resolve({ ...paidResult(), chosen: second });
      },
    });
    const result = await run(
      [
        "purchase",
        "weather",
        "in",
        "Ankara",
        "--max",
        "0.01",
        "--pick",
        "2",
        "--type",
        "http",
        "--path-param",
        "city=Ankara",
        "--json",
      ],
      buyer,
    );
    expect(result.status).toBe(0);
    expect(picked).toBe(second);
    const [query, options] = buyer.calls[0]?.args as [string, Record<string, unknown>];
    expect(query).toBe("weather in Ankara");
    expect(options).toMatchObject({
      maxAmount: { amount: "0.01" },
      filters: { type: "http" },
      call: { pathParams: { city: "Ankara" } },
    });
    expect(result.json().result).toMatchObject({ chosen: { listingId: second.listingId } });
  });

  it("refuses a pick that is not among the results", async () => {
    const buyer = fakeBuyer({
      searchAndPay: (_query, options) => {
        options.pick?.({ hits: [hit()], nextCursor: null, partialResults: false, method: "hybrid" });
        return Promise.resolve({ ...paidResult(), chosen: hit() });
      },
    });
    const result = await run(["purchase", "weather", "--max", "0.01", "--pick", "3", "--json"], buyer);
    expect(result.status).toBe(EXIT.notFound);
    expect(result.json().error).toMatchObject({ code: "listing_not_found", paid: "none" });
  });
});

describe("quote and tx", () => {
  it("quotes without a cap and warns about MCP tools on stderr", async () => {
    const buyer = fakeBuyer({
      quote: () =>
        Promise.resolve({
          callId: "q-1",
          resource: "https://mcp.example/mcp",
          paymentRequired: false,
          status: 200,
          options: [],
          chosen: null,
          refused: null,
          warnings: ["A free MCP tool runs on the unpaid call: quoting it executed it."],
        }),
    });
    const result = await run(["quote", "https://mcp.example/mcp", "--tool", "free"], buyer);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("quoting an MCP tool calls it unpaid");
    expect(result.stderr).toContain("warning: A free MCP tool runs");
    expect(result.stdout).toContain("without asking for payment");
    expect(buyer.calls[0]?.args[1]).toEqual({ signal: expect.any(AbortSignal) as unknown });
  });

  it("explains a transaction", async () => {
    const result = await run(["tx", TX_HASH], fakeBuyer());
    expect(result.stdout).toContain("facilitator: https://testnet.rail402.dev (sponsored by its signer)");
    expect(result.stdout).toContain("0.001 USDC");
    const missing = fakeBuyer({
      inspectTransaction: () => Promise.reject(paymentError("transaction_not_found")),
    });
    expect((await run(["tx", TX_HASH], missing)).status).toBe(EXIT.notFound);
    const bad = fakeBuyer({
      inspectTransaction: () => Promise.reject(paymentError("transaction_hash_invalid")),
    });
    expect((await run(["tx", "xyz"], bad)).status).toBe(EXIT.usage);
  });

  it("prints the budget of the session", async () => {
    const buyer = fakeBuyer({ budget: () => Promise.resolve(budgetSnapshot({ session: "trip" })) });
    const result = await run(["session", "show", "--json"], buyer);
    // The double's ledger has no windows: only the default session may be shown without one.
    expect(result.status).toBe(0);
    const named = await run(["session", "show", "--name", "trip", "--json"], buyer);
    expect(named.json().error).toMatchObject({ code: "cli_usage_invalid" });
  });
});
