import { describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, USDC } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
import {
  checkOption,
  effectiveCap,
  exactScheme,
  meetsTrust,
  recipientPermitted,
  resolvePolicy,
  selectOption,
  type OptionContext,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";
import { requirements, testPolicy, usdc } from "./helpers.ts";

const token = randomContractId();
const describeToken =
  (decimals: number, symbol = "TEST6") =>
  (contract: string) =>
    Promise.resolve(contract === token ? { symbol, name: `${symbol}:G…`, decimals } : undefined);

describe("resolvePolicy", () => {
  it("fills testnet defaults: USDC, 0.10 per call, 1.00 per window, exact and upto", async () => {
    const policy = await resolvePolicy(TESTNET, {}, { requireCaps: true });
    expect(policy.assets).toEqual([
      { symbol: "USDC", contract: usdc, decimals: 7, perCall: 1_000_000n, sessionTotal: 10_000_000n },
    ]);
    expect(policy).toMatchObject({
      schemes: ["exact", "upto"],
      maxAuthorizationSeconds: 300,
      requireCatalogListing: false,
      minTrust: { http: "settled", mcp: "settled" },
      uptoContracts: [UPTO_TESTNET_DEPLOYMENT.address],
      uptoFacilitators: undefined,
    });
  });

  it("has no pubnet caps: a signer without configured caps cannot start", async () => {
    await expect(resolvePolicy(PUBNET, {}, { requireCaps: true })).rejects.toMatchObject({
      code: "payment_policy_invalid",
    });
    const searchOnly = await resolvePolicy(PUBNET, {}, { requireCaps: false });
    expect(searchOnly.assets[0]).toMatchObject({ contract: USDC[PUBNET].contract, perCall: undefined });
    expect(searchOnly).toMatchObject({
      schemes: ["exact"],
      uptoContracts: [],
      requireCatalogListing: true,
      minTrust: { http: "origin_verified", mcp: "domain_verified" },
    });
    await expect(
      resolvePolicy(PUBNET, { schemes: ["exact", "upto"] }, { requireCaps: false }),
    ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    const configured = await resolvePolicy(
      PUBNET,
      { assets: [{ asset: "USDC", perCall: "0.05", sessionTotal: "0.50" }] },
      { requireCaps: true },
    );
    expect(configured.assets[0]).toMatchObject({ perCall: 500_000n, sessionTotal: 5_000_000n });
  });

  it("verifies a custom token's decimals and symbol on chain", async () => {
    const policy = await resolvePolicy(
      TESTNET,
      { assets: [{ asset: token, decimals: 6, perCall: "1", sessionTotal: "5" }] },
      { requireCaps: true, describe: describeToken(6) },
    );
    expect(policy.assets[0]).toEqual({
      symbol: "TEST6",
      contract: token,
      decimals: 6,
      perCall: 1_000_000n,
      sessionTotal: 5_000_000n,
    });
    const refused = [
      resolvePolicy(
        TESTNET,
        { assets: [{ asset: token, decimals: 7, perCall: "1", sessionTotal: "5" }] },
        {
          requireCaps: true,
          describe: describeToken(6),
        },
      ),
      resolvePolicy(
        TESTNET,
        { assets: [{ asset: token, decimals: 6, perCall: "1", sessionTotal: "5" }] },
        {
          requireCaps: true,
        },
      ),
      resolvePolicy(
        TESTNET,
        { assets: [{ asset: token, perCall: "1", sessionTotal: "5" }] },
        {
          requireCaps: true,
          describe: describeToken(6),
        },
      ),
      resolvePolicy(
        TESTNET,
        { assets: [{ asset: randomContractId(), decimals: 6, perCall: "1", sessionTotal: "5" }] },
        {
          requireCaps: true,
          describe: describeToken(6),
        },
      ),
      resolvePolicy(
        TESTNET,
        { assets: [{ asset: token, symbol: "USDC", decimals: 6, perCall: "1", sessionTotal: "5" }] },
        {
          requireCaps: true,
          describe: describeToken(6),
        },
      ),
      // A custom token gets no default caps.
      resolvePolicy(
        TESTNET,
        { assets: [{ asset: token, decimals: 6 }] },
        { requireCaps: true, describe: describeToken(6) },
      ),
    ];
    for (const attempt of refused)
      await expect(attempt).rejects.toMatchObject({ code: "payment_policy_invalid" });
  });

  it.each([
    ["no assets", { assets: [] }],
    ["a duplicate asset", { assets: [{ asset: "USDC" }, { asset: usdc }] }],
    ["a symbol that is neither USDC nor a contract", { assets: [{ asset: "EURC" }] }],
    ["USDC with other decimals", { assets: [{ asset: "USDC", decimals: 6 }] }],
    ["a per-call ceiling above the total", { assets: [{ asset: "USDC", perCall: "2", sessionTotal: "1" }] }],
    ["too many decimals in a cap", { assets: [{ asset: "USDC", perCall: "0.000000001" }] }],
    ["a zero cap", { assets: [{ asset: "USDC", perCall: "0" }] }],
    ["an unknown scheme", { schemes: ["stream" as "exact"] }],
    ["an empty scheme list", { schemes: [] }],
    ["an authorization window of zero", { maxAuthorizationSeconds: 0 }],
    ["a fractional authorization window", { maxAuthorizationSeconds: 1.5 }],
    ["an invalid recipient", { recipients: { deny: ["GNOPE"] } }],
    ["an unknown trust level", { minTrust: { http: "trusted" as "settled" } }],
    ["an invalid upto contract", { uptoContracts: ["GABC"] }],
    ["upto without a pinned contract", { schemes: ["upto" as const], uptoContracts: [] }],
    ["an invalid upto facilitator", { uptoFacilitators: ["GNOPE"] }],
    ["an empty upto facilitator list", { uptoFacilitators: [] }],
  ])("refuses %s", async (_name, input) => {
    await expect(resolvePolicy(TESTNET, input, { requireCaps: true })).rejects.toMatchObject({
      code: "payment_policy_invalid",
    });
  });
});

describe("effectiveCap", () => {
  it("clamps a cap above the operator ceiling and reports both", async () => {
    const policy = await testPolicy();
    expect(effectiveCap(policy, { amount: "5" })).toMatchObject({
      requested: 50_000_000n,
      ceiling: 1_000_000n,
      cap: 1_000_000n,
    });
    expect(effectiveCap(policy, { amount: "0.05", asset: "USDC" })).toMatchObject({ cap: 500_000n });
    expect(effectiveCap(policy, { amount: "0.05", asset: usdc })).toMatchObject({ cap: 500_000n });
  });

  it("requires a well-formed cap in a policy asset", async () => {
    const policy = await testPolicy();
    expect(() => effectiveCap(policy, undefined)).toThrow(
      expect.objectContaining({ code: "payment_cap_required" }),
    );
    for (const money of [
      { amount: "0.00000001" },
      { amount: "0" },
      { amount: "-1" },
      { amount: "1e3" },
      { amount: " 1" },
      { amount: "0.05", asset: "EURC" },
    ]) {
      expect(() => effectiveCap(policy, money)).toThrow(
        expect.objectContaining({ code: "payment_cap_invalid" }),
      );
    }
  });
});

describe("recipients and trust", () => {
  it("compares muxed recipients by base account and refuses self-payment", async () => {
    const payer = Keypair.random().publicKey();
    const seller = Keypair.random().publicKey();
    const muxedSeller = new MuxedAccount(new Account(seller, "0"), "5").accountId();
    const muxedPayer = new MuxedAccount(new Account(payer, "0"), "9").accountId();
    const denied = await testPolicy({ recipients: { deny: [muxedSeller] } });
    expect(recipientPermitted(denied, seller, payer)).toBe(false);
    const allowed = await testPolicy({ recipients: { allow: [seller] } });
    expect(recipientPermitted(allowed, muxedSeller, payer)).toBe(true);
    expect(recipientPermitted(allowed, Keypair.random().publicKey(), payer)).toBe(false);
    const open = await testPolicy();
    expect(recipientPermitted(open, muxedPayer, payer)).toBe(false);
    expect(recipientPermitted(open, "not-an-address", payer)).toBe(false);
  });

  it("orders trust levels", () => {
    expect(meetsTrust("domain_verified", "origin_verified")).toBe(true);
    expect(meetsTrust("settled", "origin_verified")).toBe(false);
  });
});

describe("option preflight and selection", () => {
  const payer = Keypair.random().publicKey();
  const seller = Keypair.random().publicKey();

  async function ctx(overrides: Partial<OptionContext> = {}): Promise<OptionContext> {
    const policy = await testPolicy();
    return {
      network: TESTNET,
      policy,
      adapters: [exactScheme()],
      payer,
      cap: effectiveCap(policy, { amount: "0.05" }),
      ...overrides,
    };
  }

  it.each([
    ["another network", { network: PUBNET }, "payment_network_not_permitted"],
    ["a scheme that is not enabled", { scheme: "upto" }, "payment_scheme_not_permitted"],
    ["an asset outside the policy", { asset: randomContractId() }, "payment_asset_not_permitted"],
    ["unsponsored fees", { extra: {} }, "payment_fees_not_sponsored"],
    ["the payer as recipient", { payTo: payer }, "payment_recipient_not_permitted"],
    ["an invalid recipient", { payTo: "GBAD" }, "payment_recipient_not_permitted"],
    ["a zero amount", { amount: "0" }, "payment_amount_not_permitted"],
    ["a decimal amount", { amount: "1.5" }, "payment_amount_not_permitted"],
    ["an amount beyond i128", { amount: (1n << 128n).toString() }, "payment_amount_not_permitted"],
    ["a price above the cap", { amount: "500001" }, "payment_per_call_cap_exceeded"],
    ["a long authorization window", { maxTimeoutSeconds: 301 }, "payment_authorization_window_not_permitted"],
    ["no authorization window", { maxTimeoutSeconds: 0 }, "payment_authorization_window_not_permitted"],
  ] as const)("refuses %s", async (_name, overrides, code) => {
    const verdict = checkOption(requirements({ payTo: seller, ...overrides }), 0, await ctx());
    expect(verdict.refused?.code).toBe(code);
  });

  it("reports the price, cap and ceiling when the price is above the cap", async () => {
    const verdict = checkOption(requirements({ amount: "600000" }), 0, await ctx());
    expect(verdict.refused?.details).toEqual({
      price: "0.06",
      cap: "0.05",
      requested: "0.05",
      ceiling: "0.1",
    });
  });

  it("refuses an option priced in a different asset than the cap", async () => {
    const policy = await resolvePolicy(
      TESTNET,
      { assets: [{ asset: "USDC" }, { asset: token, decimals: 6, perCall: "1", sessionTotal: "5" }] },
      { requireCaps: true, describe: describeToken(6) },
    );
    const context = await ctx({ policy, cap: effectiveCap(policy, { amount: "0.5", asset: "TEST6" }) });
    expect(checkOption(requirements({ payTo: seller }), 0, context).refused?.code).toBe(
      "payment_asset_not_permitted",
    );
    expect(
      checkOption(requirements({ payTo: seller, asset: token, amount: "400000" }), 0, context).refused,
    ).toBeUndefined();
  });

  it("binds the recipient of every listing and the price a listing carries", async () => {
    const listed = [{ scheme: "exact", asset: usdc, payTo: seller, amount: "10000" }];
    const http = await ctx({ listing: { type: "http", owner: seller, prices: listed } });
    expect(checkOption(requirements({ payTo: seller }), 0, http).refused).toBeUndefined();
    expect(checkOption(requirements({ payTo: seller, amount: "10001" }), 0, http).refused?.code).toBe(
      "payment_listing_mismatch",
    );
    const impostor = Keypair.random().publicKey();
    expect(checkOption(requirements({ payTo: impostor }), 0, http).refused).toMatchObject({
      code: "payment_listing_mismatch",
      details: { listingOwner: seller, livePayTo: impostor },
    });
    // An HTTP binding that lists no price binds nothing to pay.
    const unpriced = await ctx({ listing: { type: "http", owner: seller } });
    expect(checkOption(requirements({ payTo: seller }), 0, unpriced).refused?.code).toBe(
      "payment_listing_mismatch",
    );
    const mcp = await ctx({ listing: { type: "mcp", owner: seller, prices: listed } });
    expect(checkOption(requirements({ payTo: seller }), 0, mcp).refused).toBeUndefined();
    expect(checkOption(requirements({ payTo: seller, amount: "20000" }), 0, mcp).refused?.code).toBe(
      "payment_listing_mismatch",
    );
    // A tool the catalog cannot confirm at an origin binds its recipient alone.
    const unconfirmed = await ctx({ listing: { type: "mcp", owner: seller } });
    expect(
      checkOption(requirements({ payTo: seller, amount: "20000" }), 0, unconfirmed).refused,
    ).toBeUndefined();
    const muxed = new MuxedAccount(new Account(seller, "0"), "3").accountId();
    // A muxed address on the owner's account matches the listing, but exact cannot pay it.
    expect(checkOption(requirements({ payTo: muxed }), 0, unconfirmed).refused).toMatchObject({
      code: "payment_recipient_not_permitted",
      reason: expect.stringContaining("muxed") as unknown,
    });
  });

  it("refuses an option that does not fit the remaining session budget", async () => {
    const context = await ctx({ remaining: () => 9_999n });
    expect(checkOption(requirements({ payTo: seller }), 0, context).refused?.code).toBe(
      "payment_session_cap_exceeded",
    );
  });

  it("selects the cheapest acceptable option, preferring the requested scheme", async () => {
    const upto: StellarSchemeAdapter = {
      ...exactScheme(),
      scheme: "upto",
      checkRequirements: () => undefined,
    };
    const policy = await testPolicy({ schemes: ["exact", "upto"] });
    const context = await ctx({
      policy,
      adapters: [exactScheme(), upto],
      cap: effectiveCap(policy, { amount: "0.05" }),
    });
    const options = [
      requirements({ payTo: seller, amount: "30000" }),
      requirements({ payTo: seller, amount: "20000", scheme: "upto" }),
      requirements({ payTo: seller, amount: "20000" }),
      requirements({ payTo: seller, amount: "900000" }),
    ];
    expect(selectOption(options, context).chosen.index).toBe(2);
    expect(selectOption(options, { ...context, preferredScheme: "upto" }).chosen.index).toBe(1);
  });

  it("raises a single option's own refusal, or lists every refusal", async () => {
    const context = await ctx();
    expect(() => selectOption([requirements({ payTo: seller, amount: "600000" })], context)).toThrow(
      expect.objectContaining({ code: "payment_per_call_cap_exceeded", paid: "none" }),
    );
    let caught: unknown;
    try {
      selectOption(
        [requirements({ payTo: seller, amount: "600000" }), requirements({ payTo: seller, extra: {} })],
        context,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "payment_no_acceptable_option",
      details: {
        offered: [
          {
            scheme: "exact",
            asset: "USDC",
            amount: "0.06",
            payTo: seller,
            refused: "payment_per_call_cap_exceeded",
          },
          {
            scheme: "exact",
            asset: "USDC",
            amount: "0.001",
            payTo: seller,
            refused: "payment_fees_not_sponsored",
          },
        ],
      },
    });
  });
});
