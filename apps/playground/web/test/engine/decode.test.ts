import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { ListingVersion, SearchHit, TransactionReport } from "@rail402.dev/sdk/browser";
import { exactSettlement, uptoSettlement } from "../../../../../packages/sdk/test/chain-fixtures.ts";
import { uptoSettledOf } from "../../src/engine/chain.ts";
import {
  authorizationView,
  listingVerdict,
  listingView,
  pathExampleOf,
  mcpRequestOf,
  mcpResponseView,
  requiredFromHeader,
  requiredView,
  settleFromHeader,
  settleView,
  txView,
  versionView,
  type DecodeContext,
} from "../../src/engine/decode.ts";
import { policyFor } from "./fakes.ts";
import { PAY_TO, UPTO_CONTRACT, USDC_CONTRACT, exactRequired, header, testConfig } from "./helpers.ts";

const context: DecodeContext = {
  assetFacts: (contract) => (contract === USDC_CONTRACT ? { symbol: "USDC", decimals: 7 } : undefined),
};

describe("payment request views", () => {
  it("decodes options with decimals, the seller's error and the bazaar declaration", () => {
    const view = requiredView(
      exactRequired({ error: "invalid_exact_stellar_payload_nonce_already_used", bazaar: true }),
      {
        ...context,
        judge: () => [{ acceptable: true, code: null, reason: null }],
      },
    );
    expect(view?.error).toBe("invalid_exact_stellar_payload_nonce_already_used");
    expect(view?.resource.url).toContain("/weather");
    expect(view?.options).toEqual([
      {
        index: 0,
        scheme: "exact",
        network: "stellar:testnet",
        asset: USDC_CONTRACT,
        symbol: "USDC",
        decimals: 7,
        amount: "10000",
        decimal: "0.001",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        feesSponsored: true,
        facilitatorAddress: null,
        facilitatorAddressAdvertised: null,
        verdict: { acceptable: true, code: null, reason: null },
      },
    ]);
    expect(view?.bazaar.declared).toBe(true);
  });

  it("checks an upto settlement authority against the facilitator and keeps unknown assets raw", () => {
    const authority = Keypair.random().publicKey();
    const required = exactRequired();
    const option = {
      ...required.accepts[0],
      scheme: "upto",
      asset: UPTO_CONTRACT,
      extra: { facilitatorAddress: authority, areFeesSponsored: true },
    };
    const view = requiredView(
      { ...required, accepts: [option] },
      { ...context, advertised: (a) => a === authority },
    );
    expect(view?.options[0]).toMatchObject({
      facilitatorAddress: authority,
      facilitatorAddressAdvertised: true,
      symbol: null,
      decimal: null,
      verdict: null,
    });
  });

  it("refuses what is not a payment request, and cleans seller text", () => {
    expect(requiredView({ accepts: [] }, context)).toBeUndefined();
    expect(requiredFromHeader("%%%", context)).toBeUndefined();
    expect(requiredFromHeader(null, context)).toBeUndefined();
    const view = requiredView({ ...exactRequired(), error: "bad\u0000‮word" }, context);
    expect(view?.error).toBe("badword");
  });

  it("decodes settlement responses", () => {
    const hash = "A".repeat(64);
    expect(
      settleFromHeader(
        header({ success: true, transaction: hash, network: "stellar:testnet", amount: "21000" }),
      ),
    ).toEqual({
      from: "payment-response",
      success: true,
      transaction: hash.toLowerCase(),
      network: "stellar:testnet",
      payer: null,
      amount: "21000",
      errorReason: null,
      errorMessage: null,
    });
    expect(
      settleView({ success: false, errorReason: "invalid_upto", transaction: "nope" }, "mcp-meta"),
    ).toMatchObject({
      success: false,
      transaction: null,
      errorReason: "invalid_upto",
    });
    expect(settleView({ transaction: "x" }, "payment-response")).toBeUndefined();
  });
});

describe("MCP views", () => {
  it("reads the JSON-RPC method and whether a payment was attached, never its content", () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hourly_forecast", _meta: { "x402/payment": { payload: "x" } } },
    });
    expect(mcpRequestOf(body)).toEqual({
      id: 1,
      view: { method: "tools/call", toolName: "hourly_forecast", hasPayment: true },
    });
    expect(
      mcpRequestOf(
        new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: "i" })),
      ),
    ).toEqual({
      id: "i",
      view: { method: "initialize", toolName: null, hasPayment: false },
    });
    expect(mcpRequestOf("not json")).toBeUndefined();
    expect(mcpRequestOf(null)).toBeUndefined();
  });

  it("reads payment requirements from an error result and from error data", () => {
    const required = exactRequired();
    const result = mcpResponseView(
      {
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify(required) }] },
      },
      context,
    );
    expect(result?.required?.options[0]?.amount).toBe("10000");
    const nested = mcpResponseView(
      { jsonrpc: "2.0", id: 1, error: { code: 402, message: "pay", data: { x402: required } } },
      context,
    );
    expect(nested).toMatchObject({ isError: true, errorCode: 402, errorMessage: "pay" });
    expect(nested?.required?.options).toHaveLength(1);
    const other = mcpResponseView(
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no", data: required } },
      context,
    );
    expect(other?.required).toBeNull();
    expect(mcpResponseView({ id: 1 }, context)).toBeUndefined();
  });
});

describe("authorization views", () => {
  it("refuses anything that is not an exact transfer or a pinned upto settlement", () => {
    const address = Keypair.random().publicKey();
    expect(
      authorizationView("AAAA", { address, network: "stellar:testnet", uptoContracts: [], latestLedger: 1 }),
    ).toBeUndefined();
  });
});

describe("chain views", () => {
  it("reads the settlement contract's event of an upto settlement", () => {
    const payer = Keypair.random().publicKey();
    const terms = {
      expirationLedger: 100,
      facilitator: Keypair.random().publicKey(),
      maxAmount: 100_000n,
      recipient: PAY_TO,
      token: USDC_CONTRACT,
      validAfterLedger: 0,
    };
    const settled = uptoSettlement({ contract: UPTO_CONTRACT, payer, terms, amount: 21_000n, nonce: 5n });
    expect(uptoSettledOf(settled, UPTO_CONTRACT)).toEqual({ amount: "21000", maxAmount: "100000" });
    expect(uptoSettledOf(settled, USDC_CONTRACT)).toBeNull();
    const exact = exactSettlement({ asset: USDC_CONTRACT, payer, payTo: PAY_TO, amount: 10_000n, nonce: 1n });
    expect(uptoSettledOf(exact, UPTO_CONTRACT)).toBeNull();
  });

  it("turns a transaction report into a view without envelope data", () => {
    const report: TransactionReport = {
      hash: "c".repeat(64),
      network: "stellar:testnet",
      status: "SUCCESS",
      ledger: 12,
      closedAt: "2026-10-03T00:00:00Z",
      feeBump: {
        outerHash: "c".repeat(64),
        innerHash: "d".repeat(64),
        feeSource: PAY_TO,
        feeCharged: "23123",
      },
      source: PAY_TO,
      operations: [
        { type: "invokeHostFunction", contract: USDC_CONTRACT, function: "transfer", args: ["x"] },
      ],
      authorizations: [
        {
          address: PAY_TO,
          credential: "address",
          nonce: "9",
          expirationLedger: 20,
          signed: true,
          subInvocations: 0,
        },
      ],
      transfers: [
        {
          contract: USDC_CONTRACT,
          symbol: "USDC",
          from: PAY_TO,
          to: PAY_TO,
          amount: { atomic: "10000", decimal: "0.001" },
        },
      ],
      x402: { shape: "exact", checks: [] },
      facilitator: { url: "https://f.example", attributed: true },
      explorerUrl: "https://explorer.example/testnet/tx/cc",
    };
    expect(txView(report, null)).toEqual({
      hash: report.hash,
      network: "stellar:testnet",
      status: "SUCCESS",
      ledger: 12,
      closedAt: report.closedAt,
      feeBump: report.feeBump,
      feeSourceAdvertised: true,
      transfers: [
        {
          contract: USDC_CONTRACT,
          symbol: "USDC",
          from: PAY_TO,
          to: PAY_TO,
          amount: "10000",
          decimal: "0.001",
        },
      ],
      x402Shape: "exact",
      nonces: ["9"],
      uptoSettled: null,
      explorerUrl: report.explorerUrl,
    });
  });
});

describe("bazaar views", () => {
  it("shows a hit's first price within policy and whether it can be paid now", () => {
    const hit = {
      listingId: "0b3c4c02-73d1-4f4a-9e7b-6f0b8f3f0d11",
      type: "mcp",
      resource: "https://seller.example/mcp",
      method: null,
      toolName: "hourly_forecast",
      owner: PAY_TO,
      trust: "origin_verified",
      settlements: 3,
      callable: true,
      withinPolicy: false,
      prices: [
        {
          scheme: "exact",
          amount: "0.5",
          atomic: "5000000",
          asset: "USDC",
          assetContract: USDC_CONTRACT,
          withinPolicy: false,
        },
      ],
      seller: { description: "Hourly", serviceName: "Weather", tags: [], mimeType: null },
      input: {
        schema: { type: "object", required: ["city", "bad name!"] },
        example: { city: "Izmir", hours: 6 },
        pathParams: [],
      },
    } as unknown as SearchHit;
    expect(listingView(hit, { network: "stellar:testnet", version: 2, state: "published", rank: 1 })).toEqual(
      {
        id: hit.listingId,
        resource: hit.resource,
        type: "mcp",
        method: null,
        toolName: "hourly_forecast",
        description: "Hourly",
        serviceName: "Weather",
        owner: PAY_TO,
        network: "stellar:testnet",
        trust: "origin_verified",
        state: "published",
        version: 2,
        settlements: 3,
        price: { scheme: "exact", amount: "5000000", decimal: "0.5", symbol: "USDC" },
        input: {
          fields: [
            {
              name: "city",
              in: "argument",
              kind: "string",
              required: false,
              description: null,
              example: "Izmir",
              options: null,
            },
            {
              name: "hours",
              in: "argument",
              kind: "number",
              required: false,
              description: null,
              example: "6",
              options: null,
            },
          ],
        },
        callable: false,
        notPayable: null,
        rank: 1,
      },
    );
  });

  it("turns a tool's input schema into call fields, typed, with the seller's words cleaned", () => {
    const hit = {
      listingId: "0b3c4c02-73d1-4f4a-9e7b-6f0b8f3f0d11",
      type: "mcp",
      resource: "https://seller.example/mcp",
      method: null,
      toolName: "hourly_forecast",
      owner: PAY_TO,
      trust: "settled",
      settlements: 1,
      callable: true,
      withinPolicy: true,
      prices: [],
      seller: { description: null, serviceName: null, tags: [], mimeType: null },
      input: {
        schema: {
          type: "object",
          required: ["city", "hours"],
          properties: {
            city: { type: "string", description: "City name" },
            hours: { type: "integer", minimum: 1, maximum: 48 },
            pollutant: { type: "string", enum: ["pm25", "pm10"] },
            "bad name!": { type: "string" },
          },
        },
        example: { city: "Izmir", hours: 6, extra: true },
        pathParams: [],
      },
    } as unknown as SearchHit;
    const view = listingView(hit, { network: "stellar:testnet", version: 1, state: "published", rank: null });
    expect(
      view.input?.fields.map((field) => [field.name, field.kind, field.required, field.example]),
    ).toEqual([
      ["city", "string", true, "Izmir"],
      ["hours", "integer", true, "6"],
      ["pollutant", "string", false, null],
      ["extra", "boolean", false, "true"],
    ]);
    expect(view.input?.fields[0]?.description).toBe("City name");
    expect(view.input?.fields[2]?.options).toEqual(["pm25", "pm10"]);
  });

  it("reads an HTTP listing's path, query and body fields from its Bazaar schema", () => {
    const base = {
      listingId: "0b3c4c02-73d1-4f4a-9e7b-6f0b8f3f0d11",
      type: "http",
      resource: "https://seller.example/users/:id",
      toolName: null,
      owner: PAY_TO,
      trust: "settled",
      settlements: 1,
      callable: true,
      withinPolicy: true,
      prices: [],
      seller: { description: null, serviceName: null, tags: [], mimeType: null },
    };
    const get = {
      ...base,
      method: "GET",
      input: {
        schema: {
          input: {
            properties: {
              queryParams: {
                required: ["lang"],
                properties: { lang: { type: "string", description: "Language" } },
              },
            },
          },
        },
        example: { lang: "en" },
        pathParams: ["id"],
      },
    } as unknown as SearchHit;
    const view = listingView(get, {
      network: "stellar:testnet",
      version: 1,
      state: "published",
      rank: null,
      pathExample: { id: "42" },
    });
    expect(view.input?.fields.map((field) => [field.name, field.in, field.required, field.example])).toEqual([
      ["id", "path", true, "42"],
      ["lang", "query", true, "en"],
    ]);
    const post = {
      ...base,
      resource: "https://seller.example/translate",
      method: "POST",
      input: {
        schema: {
          input: {
            properties: {
              body: { required: ["text"], properties: { text: { type: "string" }, to: { type: "string" } } },
            },
          },
        },
        example: { text: "Hello", to: "tr" },
        pathParams: [],
      },
    } as unknown as SearchHit;
    expect(
      listingView(post, {
        network: "stellar:testnet",
        version: 1,
        state: "published",
        rank: null,
      }).input?.fields.map((field) => [field.name, field.in, field.required]),
    ).toEqual([
      ["text", "body", true],
      ["to", "body", false],
    ]);
    expect(
      pathExampleOf({ extensions: { bazaar: { info: { input: { pathParams: { id: "42" } } } } } }),
    ).toEqual({
      id: "42",
    });
    expect(pathExampleOf({})).toBeUndefined();
  });

  it("says which rule refuses a listing the buyer cannot pay, with its code", async () => {
    const policy = await policyFor(testConfig());
    const judge = { policy, adapters: [{ scheme: "exact" }, { scheme: "upto" }] } as unknown as Parameters<
      typeof listingVerdict
    >[1];
    const price = {
      scheme: "exact",
      amount: "0.001",
      atomic: "10000",
      asset: "USDC",
      assetContract: USDC_CONTRACT,
      feesSponsored: true,
      withinPolicy: true,
    };
    const hitWith = (changes: Record<string, unknown>, priceChanges: Record<string, unknown> = {}) =>
      ({
        callable: true,
        notCallableReason: null,
        withinPolicy: false,
        prices: [{ ...price, withinPolicy: false, ...priceChanges }],
        ...changes,
      }) as unknown as SearchHit;
    expect(listingVerdict(hitWith({ withinPolicy: true }), judge)).toBeNull();
    const cases: [SearchHit, string][] = [
      [hitWith({ callable: false, notCallableReason: "The port is not allowed." }), "listing_not_payable"],
      [hitWith({ prices: [] }), "payment_network_not_permitted"],
      [hitWith({}, { assetContract: UPTO_CONTRACT, asset: "TEST6" }), "payment_asset_not_permitted"],
      [hitWith({}, { scheme: "deferred" }), "payment_scheme_not_permitted"],
      [hitWith({}, { feesSponsored: false }), "payment_fees_not_sponsored"],
      [hitWith({}, { atomic: "0" }), "payment_amount_not_permitted"],
      [hitWith({}, { atomic: "5000000" }), "payment_per_call_cap_exceeded"],
    ];
    for (const [hit, code] of cases) {
      const verdict = listingVerdict(hit, judge);
      expect(verdict?.code).toBe(code);
      expect(verdict?.reason).not.toBe("");
    }
    expect(listingVerdict(cases[0]?.[0] as SearchHit, judge)?.reason).toBe("The port is not allowed.");
  });

  it("shows a version with its cause and a cleaned reason", () => {
    const version = {
      version: 2,
      createdAt: "2026-10-03T00:00:00Z",
      cause: "origin_verification",
      owner: PAY_TO,
      trust: "domain_verified",
      state: "published",
      content: { secretish: true },
      reason: "checked\u0007",
    } as unknown as ListingVersion;
    expect(versionView(version)).toEqual({
      version: 2,
      createdAt: version.createdAt,
      cause: "origin_verification",
      transaction: null,
      owner: PAY_TO,
      trust: "domain_verified",
      state: "published",
      reason: "checked",
    });
  });
});
