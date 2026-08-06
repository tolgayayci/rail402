import { describe, it, expect } from "vitest";
import {
  PayInputSchema,
  SearchInputSchema,
  selectPayable,
  withinBudget,
  fail,
  succeed,
  toToolCall,
  SearchOutputSchema,
  PayOutputSchema,
} from "./tools.js";
import { payAndCall, searchResources, type McpConfig } from "./server.js";

const config: McpConfig = {
  bazaarUrl: "http://bazaar.test",
  stellarSecret: "SBQWY3DNPFLSXTDMLRWNQGKSFDQCB4YHQXQXOQNQXQXOQNQXQXOQNQXO",
  network: "stellar:testnet",
};

const opt = (amount: string, network = "stellar:testnet") => ({
  scheme: "exact",
  network,
  amount,
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
});

/** A fetch that always answers 402 with the given accepts, and records whether payment was tried. */
function challengeFetch(accepts: ReturnType<typeof opt>[]) {
  const calls: string[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push(String(init?.method ?? "GET"));
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts }), "utf8").toString("base64");
    return new Response(JSON.stringify({ error: "Payment required" }), {
      status: 402,
      headers: { "PAYMENT-REQUIRED": header },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("spending safety", () => {
  it("makes maxAmount required — an agent cannot omit it into an unbounded spend", () => {
    // Never silently pay an unbounded amount. A default here would be a footgun.
    const parsed = PayInputSchema.safeParse({ resource: "https://api.test/x" });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("maxAmount");
  });

  it("rejects a non-integer maxAmount rather than coercing it", () => {
    for (const bad of ["1.5", "-1", "1e6", "abc", ""]) {
      expect(PayInputSchema.safeParse({ resource: "https://a.test/x", maxAmount: bad }).success).toBe(false);
    }
    expect(PayInputSchema.safeParse({ resource: "https://a.test/x", maxAmount: "0" }).success).toBe(true);
  });

  it("refuses to pay when the price exceeds the budget, and makes NO payment attempt", async () => {
    const { impl, calls } = challengeFetch([opt("5000000")]);
    const result = await payAndCall(config, { resource: "https://api.test/x", maxAmount: "1000000" }, impl);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_budget_exceeded");
    expect(result.error?.reason).toContain("5000000");
    expect(result.error?.reason).toMatch(/no payment was made/i);
    // Exactly one request — the unpaid probe. Nothing was signed or settled.
    expect(calls).toEqual(["GET"]);
  });

  // ── The budget must bind to the price actually paid ──
  //
  // `challengeFetch` quotes the same price on every call, so it cannot express the attack that
  // matters: a server that quotes cheap on the unpaid probe and expensive on the paid request.
  // Checking only the probe let the tool clear its own gate on one quote and pay another, while
  // its description promised it never would.
  function twoFacedServer(probePrice: string, paidPrice: string) {
    let calls = 0;
    const quoted: string[] = [];
    const impl = (async () => {
      calls += 1;
      const price = calls === 1 ? probePrice : paidPrice;
      quoted.push(price);
      const header = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: "https://api.test/x" },
          accepts: [{ ...opt(price), maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
        }),
        "utf8",
      ).toString("base64");
      return new Response(JSON.stringify({ error: "Payment required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": header },
      });
    }) as unknown as typeof fetch;
    return { impl, quoted: () => quoted };
  }

  // A *valid* throwaway testnet keypair, generated for this test and funded by nobody. The shared
  // `config` above carries a well-formed-looking but checksum-invalid seed, which makes
  // `createEd25519Signer` throw before the second request is ever issued — so these two tests would
  // silently pass for the wrong reason with it. Payment still cannot complete (no funds, stub
  // server), which is fine: what is under test is whether the budget gate is reached and applied.
  const payingConfig: McpConfig = {
    ...config,
    stellarSecret: "SCPFSWCB5PUBF2XKCAJBSWRTOPSBM4Z3TLDSP2OOFNAUOFHP6XSQAM3O",
  };

  it("refuses when the paid request quotes more than the probe did", async () => {
    const server = twoFacedServer("1000", "1000000000");
    const result = await payAndCall(
      payingConfig,
      { resource: "https://api.test/x", maxAmount: "2000" },
      server.impl,
    );

    // Both quotes were served, so the tool did enter the second request — and still refused.
    expect(server.quoted()).toEqual(["1000", "1000000000"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_budget_exceeded");
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.reason).toMatch(/no payment was made/i);

    // The details payload is the machine-readable half, and asserting only the code hides a
    // rejection that is correct but unusable. Recovering the refusal from the rethrown message
    // published `maxAmount: "the configured maximum"` — a sentence in a numeric field, which
    // `BigInt()` throws on — and dropped the price entirely, so an agent could not learn what it
    // had just been asked to pay. The tool contract requires structured output, not only a code.
    expect(result.error?.details).toMatchObject({
      price: "1000000000",
      maxAmount: "2000",
      quotedOnProbe: "1000",
    });
    expect(result.error?.reason).toContain("1000000000");
  });

  it("still pays when the paid request quotes the same price as the probe", async () => {
    // Guard against over-correcting into a tool that refuses everything.
    const server = twoFacedServer("1000", "1000");
    const result = await payAndCall(
      payingConfig,
      { resource: "https://api.test/x", maxAmount: "2000" },
      server.impl,
    );
    expect(server.quoted()).toEqual(["1000", "1000"]);
    // The stub cannot complete a real Stellar signature, so this fails downstream of the budget
    // gate — the point is that it is NOT refused as over budget.
    expect(result.error?.code).not.toBe("mcp_budget_exceeded");
  });
});

describe("outbound host policy", () => {
  // `pay_and_call` fetches a caller-supplied URL and returns the body, which made it a read
  // primitive aimed at whatever the server could reach.
  const seen: string[] = [];
  const spyFetch = (async (input: URL | RequestInfo) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ secret: "instance-metadata-token" }), { status: 200 });
  }) as unknown as typeof fetch;

  it("refuses cloud metadata and loopback addresses without fetching them", async () => {
    for (const url of [
      // A trailing dot makes an FQDN absolute; `localhost.` resolves to loopback exactly as
      // `localhost` does, and was a one-character bypass of a set-membership check.
      "http://localhost./x",
      // RFC 6761 reserves the whole `.localhost` tree for loopback.
      "http://foo.localhost/x",
      // Consul service discovery — a mainstream internal-resolution suffix.
      "http://web.service.consul/x",
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://127.0.0.1:4022/verify",
      "http://localhost:8080/admin",
      "http://[::1]/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://vault.internal/v1/secret",
      "file:///etc/passwd",
    ]) {
      seen.length = 0;
      const result = await payAndCall(config, { resource: url, maxAmount: "0" }, spyFetch);
      expect(result.ok, `${url} was not refused`).toBe(false);
      expect(result.error?.code).toBe("mcp_resource_host_refused");
      expect(result.error?.retryable).toBe(false);
      // The refusal must happen BEFORE the request, or it is not a defence.
      expect(seen, `${url} was fetched anyway`).toEqual([]);
    }
  });

  it("allows a public host", async () => {
    seen.length = 0;
    const result = await payAndCall(config, { resource: "https://api.test/x", maxAmount: "0" }, spyFetch);
    expect(result.error?.code).not.toBe("mcp_resource_host_refused");
    expect(seen).toHaveLength(1);
  });

  it("allows loopback only when an operator opts in", async () => {
    seen.length = 0;
    const result = await payAndCall(
      { ...config, allowPrivateHosts: true },
      { resource: "http://127.0.0.1:4022/paid", maxAmount: "0" },
      spyFetch,
    );
    expect(result.error?.code).not.toBe("mcp_resource_host_refused");
    expect(seen).toHaveLength(1);
  });

  it("refuses infrastructure hostnames even with the opt-in", async () => {
    // The escape hatch is for a local seller, not for reaching a metadata service.
    seen.length = 0;
    const result = await payAndCall(
      { ...config, allowPrivateHosts: true },
      { resource: "http://metadata.google.internal/computeMetadata/v1/", maxAmount: "0" },
      spyFetch,
    );
    expect(result.error?.code).toBe("mcp_resource_host_refused");
    expect(seen).toEqual([]);
  });

  it("surfaces the actual price so an agent can decide whether to raise its budget", async () => {
    const { impl } = challengeFetch([opt("5000000")]);
    const result = await payAndCall(config, { resource: "https://api.test/x", maxAmount: "10" }, impl);
    expect(result.error?.details).toMatchObject({ price: "5000000", maxAmount: "10" });
  });

  it("lets an operator ceiling override a larger agent budget", async () => {
    const { impl } = challengeFetch([opt("5000000")]);
    const result = await payAndCall(
      { ...config, maxAmountCeiling: "1000000" },
      { resource: "https://api.test/x", maxAmount: "9999999999" },
      impl,
    );
    expect(result.error?.code).toBe("mcp_budget_exceeded");
    expect(result.error?.details).toMatchObject({ maxAmount: "1000000" });
  });

  it("compares budgets as bigint, so precision loss cannot authorize an overspend", () => {
    // Number("9007199254740993") === 9007199254740992 — a float comparison would wrongly pass.
    expect(withinBudget("9007199254740993", "9007199254740992")).toBe(false);
    expect(withinBudget("9007199254740992", "9007199254740993")).toBe(true);
    expect(withinBudget("not-a-number", "100")).toBe(false);
  });

  it("does not pay for a resource that was never paywalled", async () => {
    const impl = (async () => new Response(JSON.stringify({ free: true }), { status: 200 })) as unknown as typeof fetch;
    const result = await payAndCall(config, { resource: "https://api.test/x", maxAmount: "100" }, impl);
    expect(result.ok).toBe(true);
    expect(result.data?.paid).toBeUndefined();
  });
});

describe("payment option selection", () => {
  it("chooses the cheapest affordable Stellar option", () => {
    const { chosen } = selectPayable([opt("3000000"), opt("1000000"), opt("2000000")], "5000000");
    expect(chosen?.amount).toBe("1000000");
  });

  it("ignores non-Stellar networks entirely", () => {
    const { chosen } = selectPayable([opt("10", "eip155:8453"), opt("500")], "1000");
    expect(chosen?.network).toBe("stellar:testnet");
  });

  it("honours an explicit network preference", () => {
    const { chosen } = selectPayable(
      [opt("10", "stellar:testnet"), opt("20", "stellar:pubnet")],
      "1000",
      "stellar:pubnet",
    );
    expect(chosen?.network).toBe("stellar:pubnet");
  });

  it("reports the cheapest rejected option when nothing is affordable", () => {
    const { chosen, cheapestRejected } = selectPayable([opt("9000"), opt("8000")], "100");
    expect(chosen).toBeUndefined();
    expect(cheapestRejected?.amount).toBe("8000");
  });

  it("returns nothing payable when only non-Stellar options exist", async () => {
    const { impl } = challengeFetch([opt("10", "eip155:8453")]);
    const result = await payAndCall(config, { resource: "https://api.test/x", maxAmount: "1000" }, impl);
    expect(result.error?.code).toBe("mcp_resource_not_payable");
    expect(result.error?.details).toMatchObject({ offered: ["eip155:8453"] });
  });
});

describe("structured errors", () => {
  it("gives every failure a code, a non-null reason, and a retryable flag", () => {
    const result = fail("mcp_budget_exceeded");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_budget_exceeded");
    expect(result.error?.reason.length).toBeGreaterThan(20);
    expect(typeof result.error?.retryable).toBe("boolean");
  });

  it("reports an unreachable Bazaar rather than throwing at the agent", async () => {
    const result = await searchResources(
      { ...config, bazaarUrl: "http://127.0.0.1:1" },
      { query: "weather" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_upstream_error");
    expect(result.error?.reason).toBeTruthy();
  });

  it("refuses paid calls when no signer is configured, with a clear reason", async () => {
    const result = await payAndCall(
      { bazaarUrl: "http://bazaar.test", network: "stellar:testnet" },
      { resource: "https://api.test/x", maxAmount: "100" },
    );
    expect(result.error?.code).toBe("mcp_resource_not_payable");
    expect(result.error?.reason).toMatch(/signer/i);
  });
});

describe("search tool contract", () => {
  it("requires a non-empty query and bounds the limit", () => {
    expect(SearchInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(SearchInputSchema.safeParse({ query: "weather", limit: 999 }).success).toBe(false);
    expect(SearchInputSchema.safeParse({ query: "weather" }).data?.limit).toBe(10);
  });

  it("projects price, input schema and usage so an agent can choose without a second call", async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({
          resources: [
            {
              resource: "https://api.test/weather",
              type: "http",
              description: "Weather",
              accepts: [{ ...opt("1000000"), extra: { areFeesSponsored: true } }],
              quality: { totalSettlements: 9, uniquePayers: 4 },
              extensions: { bazaar: { info: { input: { inputSchema: { type: "object" } } } } },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await searchResources(config, { query: "weather" });
      const hit = result.data!.results[0]!;
      expect(hit.price).toMatchObject({ amount: "1000000" });
      // Fee sponsorship must reach the agent (B3): it was dropped with the rest of `extra`, so an
      // agent could not tell a gasless call from one needing XLM without paying to find out.
      expect(hit.price?.feesSponsored).toBe(true);
      expect(hit.usage).toEqual({ settlements: 9, uniquePayers: 4 });
      expect(hit.inputSchema).toEqual({ type: "object" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("surfaces the catalog's DERIVED asset identity and the decimal price, and validates", async () => {
    // The Stellar-native half of the projection. A SAC address is a hash of (code, issuer, network
    // passphrase), so the catalog can PROVE which token a `C…` address is — an assurance an EVM/SVM
    // catalog cannot give, where the best answer is a curated list. It only reaches the agent if the
    // projection carries it, and `extra` was previously dropped wholesale.
    const identity = {
      contract: opt("1").asset,
      kind: "sac",
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      decimals: 7,
      identity: "derived",
    };
    const impl = (async () =>
      new Response(
        JSON.stringify({
          resources: [
            {
              resource: "https://api.test/derived",
              type: "http",
              accepts: [{ ...opt("1000000"), extra: { areFeesSponsored: true, stellar: { asset: identity } } }],
            },
            {
              resource: "https://api.test/unvouched",
              type: "http",
              accepts: [{ ...opt("1000000"), extra: { areFeesSponsored: true } }],
            },
            {
              // A catalog claiming an identity this build cannot interpret must not be presented as
              // proof. Unknown-means-unproven: the agent gets no badge rather than a wrong one.
              resource: "https://api.test/claimed",
              type: "http",
              accepts: [
                {
                  ...opt("1000000"),
                  extra: { areFeesSponsored: true, stellar: { asset: { ...identity, identity: "claimed" } } },
                },
              ],
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await searchResources(config, { query: "usdc" });
      const by = (u: string) => result.data!.results.find(r => r.resource === u)!;

      expect(by("https://api.test/derived").price?.assetIdentity).toEqual({
        code: "USDC",
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        decimals: 7,
        identity: "derived",
      });
      // 1000000 atomic units of a 7-decimal token is a tenth of a dollar, and an agent budgeting in
      // atomic units has no way to know that without the decimals.
      expect(by("https://api.test/derived").price?.amountDecimal).toBe("0.1000000");

      for (const url of ["https://api.test/unvouched", "https://api.test/claimed"]) {
        expect(by(url).price?.assetIdentity).toBeUndefined();
        expect(by(url).price?.amountDecimal).toBeUndefined();
      }

      // The enriched shape must still satisfy the declared output schema — the SDK throws on drift.
      expect(SearchOutputSchema.safeParse(result).success).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("filters out resources the agent cannot afford before showing them", async () => {
    const impl = (async () =>
      new Response(
        JSON.stringify({
          resources: [
            { resource: "https://a.test/cheap", type: "http", accepts: [opt("100")] },
            { resource: "https://a.test/pricey", type: "http", accepts: [opt("9999999")] },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await searchResources(config, { query: "x", maxPrice: "1000" });
      expect(result.data!.results.map(r => r.resource)).toEqual(["https://a.test/cheap"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("MCP transport (§3.3 — calling a discovered TOOL)", () => {
  /** A valid throwaway testnet keypair. `config`'s seed is checksum-invalid on purpose elsewhere. */
  const payingConfigForMcp: McpConfig = {
    ...config,
    stellarSecret: "SCPFSWCB5PUBF2XKCAJBSWRTOPSBM4Z3TLDSP2OOFNAUOFHP6XSQAM3O",
  };

  // The live proof is `pnpm canary mcp-tool-loop`, which stands up a real paid MCP server, settles a
  // real testnet payment through it, and reads the tool's output back. These cover the branch
  // decisions around it, which are the parts a live run cannot isolate.

  it("refuses HTTP-shaped arguments on an MCP call rather than silently dropping them", async () => {
    // Silently ignoring queryParams would give an agent a successful, paid-for call made with the
    // wrong inputs — strictly worse than a refusal, because it costs money and looks like success.
    for (const extra of [{ queryParams: { harbour: "Dover" } }, { body: { harbour: "Dover" } }]) {
      const result = await payAndCall(payingConfigForMcp, {
        resource: "https://api.test/mcp",
        toolName: "harbour_tides",
        maxAmount: "1000000",
        ...extra,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_payload");
      expect(result.error?.reason).toMatch(/toolArguments/);
      expect(result.error?.reason).toMatch(/nothing was paid/i);
    }
  });

  it("applies the SSRF host policy before opening an MCP connection", async () => {
    // Same gate as the HTTP path and for the same reason: pay_and_call connects to a
    // caller-supplied URL and returns what comes back.
    const result = await payAndCall(payingConfigForMcp, {
      resource: "http://169.254.169.254/mcp",
      toolName: "anything",
      maxAmount: "1000000",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_resource_host_refused");
  });

  it("reports an unreachable MCP endpoint as a coded upstream error, naming the tool", async () => {
    const result = await payAndCall(
      { ...payingConfigForMcp, allowPrivateHosts: true },
      { resource: "http://127.0.0.1:1/mcp", toolName: "harbour_tides", maxAmount: "1000000" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_upstream_error");
    expect(result.error?.reason).toContain("harbour_tides");
    expect(result.error?.details?.["toolName"]).toBe("harbour_tides");
  });

  it("declares toolArguments and keeps maxAmount mandatory on the MCP path too", () => {
    expect(
      PayInputSchema.safeParse({
        resource: "https://api.test/mcp",
        toolName: "t",
        toolArguments: { harbour: "Dover" },
      }).success,
    ).toBe(false); // still no maxAmount
    const parsed = PayInputSchema.safeParse({
      resource: "https://api.test/mcp",
      toolName: "t",
      toolArguments: { harbour: "Dover", hours: 24 },
      maxAmount: "1000000",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.toolArguments).toEqual({ harbour: "Dover", hours: 24 });
  });

  it("validates an MCP-shaped success against the declared output schema", () => {
    // `status` is absent on this transport by design — an MCP tool call has no HTTP status, and a
    // synthetic 200 would be a field an agent could branch on wrongly.
    const call = toToolCall(
      succeed({
        transport: "mcp" as const,
        toolName: "harbour_tides",
        body: [{ type: "text", text: '{"harbour":"Dover"}' }],
        isError: false,
        paid: { amount: "2500000", asset: "C…", network: "stellar:testnet", transaction: "abc" },
      }),
    );
    expect(call.isError).toBe(false);
    expect(PayOutputSchema.safeParse(call.structuredContent).success).toBe(true);
  });
});

describe("hostile amounts cannot escape the envelope (§3.3)", () => {
  // "Every rejection carries a non null reason so an agent can reason about failure
  // instead of parsing prose." An unguarded BigInt in a sort comparator broke that with one bad
  // row: `BigInt("NaN")` THROWS, the throw escaped `searchResources`, and the agent received a bare
  // V8 message with no code, no reason and no envelope. Catalog rows are attacker-influenceable —
  // this server is designed to point at arbitrary and federated catalogs.
  const catalogWith = (accepts: unknown[]) =>
    (async () =>
      new Response(JSON.stringify({ resources: [{ resource: "https://a.test/x", type: "http", accepts }] }), {
        status: 200,
      })) as unknown as typeof fetch;

  it("survives an unparseable amount in a catalog entry and still returns the envelope", async () => {
    const realFetch = globalThis.fetch;
    for (const bad of ["NaN", "1e9", "-1", "1.5", "", "0x10"]) {
      globalThis.fetch = catalogWith([{ ...opt("1000"), amount: bad }, opt("2000")]);
      try {
        const result = await searchResources(config, { query: "x" });
        expect(result.ok, `amount ${JSON.stringify(bad)} broke the envelope`).toBe(true);
        // The unpriceable option is soft-dropped; the priceable sibling still reaches the agent.
        expect(result.data!.results[0]!.price?.amount).toBe("2000");
        expect(SearchOutputSchema.safeParse(result).success).toBe(true);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  });

  it("drops an entry whose only option is unpriceable rather than crashing the whole search", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = catalogWith([{ ...opt("1000"), amount: "NaN" }]);
    try {
      const result = await searchResources(config, { query: "x", maxPrice: "5000" });
      expect(result.ok).toBe(true);
      expect(result.data!.results[0]!.price).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a hostile amount in a 402 challenge with a code, not a SyntaxError", async () => {
    const { impl } = challengeFetch([{ ...opt("1000"), amount: "NaN" }]);
    const result = await payAndCall(config, { resource: "https://api.test/x", maxAmount: "5000" }, impl);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBeTruthy();
    expect(result.error?.reason).toBeTruthy();
  });

  it("fails closed and legibly on a malformed operator ceiling", async () => {
    // Read straight from MAX_AMOUNT_CEILING, so a typo is a config mistake — and it used to throw an
    // uncaught SyntaxError on EVERY paid call.
    const result = await payAndCall(
      { ...config, maxAmountCeiling: "abc" },
      { resource: "https://api.test/x", maxAmount: "100" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.reason).toMatch(/atomic units/);
    expect(result.error?.reason).toMatch(/nothing was paid/i);
  });
});

describe("the HTTP request actually carries what the agent asked for", () => {
  it("transmits the body, and sends the SAME request to the probe and the paid call", async () => {
    // `body` was declared on the input schema, documented as HTTP-only in the MCP path's rejection
    // message, and never sent — so an agent POSTing paid for a request that went out empty. The two
    // requests share one init on purpose: a probe that omits the body can be priced differently from
    // the call that is actually paid for, and the agent could not see the divergence.
    const seen: { method?: string; body?: unknown; ct?: string }[] = [];
    const impl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      seen.push({
        method: init?.method,
        body: init?.body,
        ct: (init?.headers as Record<string, string> | undefined)?.["Content-Type"],
      });
      const header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [opt("5000000")] }), "utf8").toString("base64");
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": header } });
    }) as unknown as typeof fetch;

    // Over budget, so it stops after the probe — enough to observe what the probe was given.
    await payAndCall(config, {
      resource: "https://api.test/x",
      method: "POST",
      body: { harbour: "Dover" },
      maxAmount: "1",
    }, impl);

    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBe(JSON.stringify({ harbour: "Dover" }));
    expect(seen[0]!.ct).toBe("application/json");
  });

  it("refuses a body on GET rather than dropping it", async () => {
    const result = await payAndCall(config, {
      resource: "https://api.test/x",
      method: "GET",
      body: { a: 1 },
      maxAmount: "100",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_payload");
    expect(result.error?.reason).toMatch(/cannot carry a body/);
  });
});

describe("structured output (§3.3)", () => {
  it("declares an output schema a real search success validates against", async () => {
    // The SDK validates structuredContent against outputSchema on success and THROWS on a mismatch,
    // so drift between the projection and the schema would surface only when a live client called the
    // tool. Validating a real result here fails the build on drift instead.
    const impl = (async () =>
      new Response(
        JSON.stringify({
          resources: [
            {
              resource: "https://api.test/weather",
              type: "http",
              description: "Weather",
              accepts: [{ ...opt("1000000"), extra: { areFeesSponsored: true } }],
              quality: { totalSettlements: 9, uniquePayers: 4 },
              extensions: { bazaar: { info: { input: { inputSchema: { type: "object" } } } } },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const result = await searchResources(config, { query: "weather" });
      expect(SearchOutputSchema.safeParse(result).success).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("wraps a failure as isError carrying the machine-readable envelope, not a silent success", () => {
    // Before §3.3 structured output a refusal reached the model as a protocol-level SUCCESS with the
    // reason buried in prose. toToolCall must set isError and carry the structured error.
    const call = toToolCall(fail("mcp_budget_exceeded", { reason: "too dear", details: { price: "5" } }));
    expect(call.isError).toBe(true);
    expect(call.structuredContent).toMatchObject({
      ok: false,
      error: { code: "mcp_budget_exceeded", retryable: false },
    });
    // The error envelope still validates against the tool's declared output schema.
    expect(PayOutputSchema.safeParse(call.structuredContent).success).toBe(true);
    // A serialized text block is present too, for backward-compatible clients.
    expect(call.content[0]!.text).toContain("mcp_budget_exceeded");
  });

  it("wraps a success as structuredContent with isError false", () => {
    const call = toToolCall(succeed({ results: [], count: 0 }));
    expect(call.isError).toBe(false);
    expect(call.structuredContent).toMatchObject({ ok: true, data: { count: 0 } });
    expect(SearchOutputSchema.safeParse(call.structuredContent).success).toBe(true);
  });
});
