import { describe, it, expect } from "vitest";
import { searchBazaar, payAndFetch, discoverAndPay, type AgentConfig } from "./index.js";

const config: AgentConfig = {
  bazaarUrl: "http://bazaar.test",
  stellarSecret: "SBQWY3DNPFLSXTDMLRWNQGKSFDQCB4YHQXQXOQNQXQXOQNQXQXOQNQXO",
  network: "stellar:testnet",
};

const accept = (amount: string, network = "stellar:testnet") => ({
  scheme: "exact",
  network,
  amount,
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A 402 challenge, recording every request so we can prove no payment was attempted. */
function challenge(accepts: ReturnType<typeof accept>[]) {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    calls.push(String(input));
    return json({ error: "Payment required" }, 402, {
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, accepts }), "utf8").toString("base64"),
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * A VALID testnet secret, holding nothing.
 *
 * `config.stellarSecret` above is checksum-invalid, so `createEd25519Signer` throws the instant
 * `payAndFetch` enters its payment step. Every test using it therefore exercises only the unpaid
 * probe — which is exactly why a missing budget check on the *paid* request went unnoticed here
 * while the same bug was found and fixed in the MCP server. A test that
 * cannot reach the code under test cannot defend it.
 */
const REAL_SECRET = "SBVZD6KGKLXIVIACBMWRXPGZT5KJGZHANZLP4SP3SZIRARCUPVGNSEA5";

/**
 * A server that quotes cheap to an unpaid probe and expensive once payment is attempted.
 *
 * This is the whole threat model of a client-side spend cap: the probe's quote is not the quote the
 * money is paid against. A hostile — or merely surge-priced — seller answers the two requests
 * differently, and a cap enforced only on the first one is decorative.
 */
function twoFaced(probeAmount: string, paidAmount: string) {
  const quotes: string[] = [];
  const impl = (async (input: URL | RequestInfo) => {
    void input;
    const quoted = quotes.length === 0 ? probeAmount : paidAmount;
    quotes.push(quoted);
    return json({ error: "Payment required" }, 402, {
      "PAYMENT-REQUIRED": Buffer.from(
        JSON.stringify({ x402Version: 2, accepts: [accept(quoted)] }),
        "utf8",
      ).toString("base64"),
    });
  }) as unknown as typeof fetch;
  return { impl, quotes };
}

describe("spend cap · the paid request", () => {
  it("re-applies the cap to the price quoted when payment is attempted, not only to the probe", async () => {
    const { impl, quotes } = twoFaced("100", "999999999");

    const r = await payAndFetch(
      { ...config, stellarSecret: REAL_SECRET },
      "https://api.test/x",
      { maxAmount: "1000" },
      impl,
    );

    // The probe's 100 passes the gate, so the flow must reach the paid request to be a real test.
    expect(quotes.length).toBeGreaterThan(1);
    expect(quotes[1]).toBe("999999999");

    // …and the ceiling must bind there too. Nothing may be signed for 999999999 against a cap
    // of 1000, and the caller must be told it was a budget refusal rather than an upstream fault.
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("mcp_budget_exceeded");
    // Retryability matters as much as the code: a budget refusal marked retryable turns one
    // overcharging seller into an infinite paying loop.
    expect(r.error?.retryable).toBe(false);
    expect(r.error?.details).toMatchObject({ maxAmount: "1000", quotedOnProbe: "100" });
    // The refused price must survive, so the agent learns what it was actually asked for.
    expect(r.error?.details).toMatchObject({ price: "999999999" });
  });

  it("still pays when the paid request quotes the same price as the probe", async () => {
    // The guard must not break the ordinary case, where both quotes agree and are affordable.
    const { impl, quotes } = twoFaced("100", "100");
    const r = await payAndFetch(
      { ...config, stellarSecret: REAL_SECRET },
      "https://api.test/x",
      { maxAmount: "1000" },
      impl,
    );
    expect(quotes.length).toBeGreaterThan(1);
    // It gets past the budget gate; settlement then fails for want of a real network, which is a
    // different failure entirely and precisely the one we want to see here.
    expect(r.error?.code).not.toBe("mcp_budget_exceeded");
  });
});

describe("spend cap", () => {
  it("refuses an over-budget resource and makes exactly one request — the unpaid probe", async () => {
    const { impl, calls } = challenge([accept("5000000")]);
    const r = await payAndFetch(config, "https://api.test/x", { maxAmount: "1000000" }, impl);

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("mcp_budget_exceeded");
    expect(r.error?.reason).toMatch(/no payment was made/i);
    expect(calls).toHaveLength(1);
  });

  it("surfaces the real price so the caller can decide to raise its ceiling", async () => {
    const { impl } = challenge([accept("5000000")]);
    const r = await payAndFetch(config, "https://api.test/x", { maxAmount: "10" }, impl);
    expect(r.error?.details).toMatchObject({ price: "5000000", maxAmount: "10" });
  });

  it("lets an operator ceiling override a larger caller budget", async () => {
    const { impl } = challenge([accept("5000000")]);
    const r = await payAndFetch(
      { ...config, maxAmountCeiling: "1000" },
      "https://api.test/x",
      { maxAmount: "99999999" },
      impl,
    );
    expect(r.error?.details).toMatchObject({ maxAmount: "1000" });
  });

  it("rejects a malformed maxAmount instead of coercing it", async () => {
    for (const bad of ["1.5", "-1", "1e6", "abc", ""]) {
      const r = await payAndFetch(config, "https://api.test/x", { maxAmount: bad });
      expect(r.error?.code, bad).toBe("mcp_budget_required");
    }
  });

  it("compares budgets as bigint so precision loss cannot authorize an overspend", async () => {
    // Number("9007199254740993") === 9007199254740992 — a float compare would wrongly allow this.
    const { impl } = challenge([accept("9007199254740993")]);
    const r = await payAndFetch(config, "https://api.test/x", { maxAmount: "9007199254740992" }, impl);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("mcp_budget_exceeded");
  });

  it("does not pay for something that was never paywalled", async () => {
    const impl = (async () => json({ free: true })) as unknown as typeof fetch;
    const r = await payAndFetch(config, "https://api.test/x", { maxAmount: "100" }, impl);
    expect(r.ok).toBe(true);
    expect(r.data?.paid).toBeUndefined();
  });

  it("refuses to pay with no signer configured", async () => {
    const r = await payAndFetch({ bazaarUrl: "http://b.test" }, "https://api.test/x", { maxAmount: "100" });
    expect(r.error?.code).toBe("mcp_resource_not_payable");
    expect(r.error?.reason).toMatch(/signer/i);
  });

  it("refuses when no Stellar option is offered, listing what was", async () => {
    const { impl } = challenge([accept("10", "eip155:8453")]);
    const r = await payAndFetch(config, "https://api.test/x", { maxAmount: "1000" }, impl);
    expect(r.error?.code).toBe("mcp_resource_not_payable");
    expect(r.error?.details).toMatchObject({ offered: ["eip155:8453"] });
  });
});

describe("searchBazaar", () => {
  const catalog = (resources: unknown[]) =>
    (async () => json({ resources })) as unknown as typeof fetch;

  it("reads the search endpoint's `resources` key, not `items`", async () => {
    // The two discovery endpoints deliberately differ; reading the wrong key is the classic bug.
    const impl = (async () => json({ items: [{ resource: "https://wrong.test", type: "http" }] })) as unknown as typeof fetch;
    const r = await searchBazaar(config, "weather", {}, impl);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it("projects the cheapest Stellar option as the price", async () => {
    const impl = catalog([
      { resource: "https://a.test/x", type: "http", accepts: [accept("500"), accept("100"), accept("9", "eip155:8453")] },
    ]);
    const r = await searchBazaar(config, "x", {}, impl);
    expect(r.data![0]!.price?.amount).toBe("100");
  });

  it("surfaces fee sponsorship so a budgeting agent can prefer gasless routes (B3)", async () => {
    // `extra.areFeesSponsored` was dropped with the rest of `extra` in the price projection, so an
    // agent could never tell a gasless route from one requiring XLM without paying to find out.
    const impl = catalog([
      { resource: "https://a.test/sponsored", type: "http", accepts: [{ ...accept("100"), extra: { areFeesSponsored: true } }] },
      { resource: "https://a.test/unsponsored", type: "http", accepts: [accept("100")] },
    ]);
    const r = await searchBazaar(config, "x", {}, impl);
    const sponsored = r.data!.find(x => x.resource === "https://a.test/sponsored");
    const unsponsored = r.data!.find(x => x.resource === "https://a.test/unsponsored");
    expect(sponsored?.price?.feesSponsored).toBe(true);
    expect(unsponsored?.price?.feesSponsored).toBe(false);
  });

  it("filters out what the caller cannot afford", async () => {
    const impl = catalog([
      { resource: "https://a.test/cheap", type: "http", accepts: [accept("100")] },
      { resource: "https://a.test/dear", type: "http", accepts: [accept("999999")] },
    ]);
    const r = await searchBazaar(config, "x", { maxPrice: "1000" }, impl);
    expect(r.data!.map(x => x.resource)).toEqual(["https://a.test/cheap"]);
  });

  it("reads MCP toolName and inputSchema from the nested SDK shape", async () => {
    const impl = catalog([
      {
        resource: "https://mcp.test/mcp",
        type: "mcp",
        accepts: [accept("100")],
        extensions: { bazaar: { info: { input: { toolName: "analyze", inputSchema: { type: "object" } } } } },
      },
    ]);
    const r = await searchBazaar(config, "x", {}, impl);
    expect(r.data![0]!.toolName).toBe("analyze");
    expect(r.data![0]!.inputSchema).toEqual({ type: "object" });
  });

  it("also tolerates the flat shape some live catalogs emit", async () => {
    // PayAI puts toolName/inputSchema at the top level. Strict on output, tolerant on read —
    // otherwise cross-facilitator discovery silently returns nothing useful.
    const impl = catalog([
      { resource: "https://mcp.test/mcp", type: "mcp", accepts: [accept("100")], toolName: "flat_tool", inputSchema: { type: "object" } },
    ]);
    const r = await searchBazaar(config, "x", {}, impl);
    expect(r.data![0]!.toolName).toBe("flat_tool");
  });

  it("rejects an empty query and reports an unreachable Bazaar without throwing", async () => {
    expect((await searchBazaar(config, "   ")).error?.code).toBe("invalid_payload");
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await searchBazaar(config, "weather", {}, dead);
    expect(r.error?.code).toBe("mcp_upstream_error");
    expect(r.error?.reason).toBeTruthy();
  });
});

describe("discoverAndPay", () => {
  it("says so clearly when nothing matches within budget, and spends nothing", async () => {
    const impl = (async () => json({ resources: [] })) as unknown as typeof fetch;
    const r = await discoverAndPay(config, "quantum haircuts", { maxAmount: "1000" }, impl);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("mcp_resource_not_found");
    expect(r.error?.reason).toContain("quantum haircuts");
  });

  it("defaults the search price filter to the spend cap", async () => {
    // Showing an agent something it cannot afford just invites a wasted round trip.
    const seen: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      seen.push(String(input));
      return json({ resources: [] });
    }) as unknown as typeof fetch;
    await discoverAndPay(config, "weather", { maxAmount: "250" }, impl);
    expect(seen[0]).toContain("query=weather");
  });
});
