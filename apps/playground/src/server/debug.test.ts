import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createApp } from "./app.js";
import { analyzeChallenge, reshapeExplorerTx, type ExplorerPaymentDetail } from "./debug.js";

/**
 * Debug-my-payment. The tx fixtures are CAPTURED from the live explorer API (2026-08-15,
 * explorer-explorer.up.railway.app, `raw` trimmed) — the coordinated /tx/:hash contract in
 * apps/explorer/openapi.yaml — so a drift between that contract and this re-shaper fails here.
 */

/** Captured: the discovery-loop canary settlement, confidence rail402, classic G buyer. */
const EXACT_DETAIL: ExplorerPaymentDetail = {
  network: "stellar:testnet",
  epoch: "2026-08-14T12:13:46.978Z",
  ledger: 4091847,
  txHash: "feb9bedb674f3b39bd52e8802fe150a4e296edb762bf80e7898d7ce16fea25b1",
  scheme: "exact",
  buyer: "GCVKPS5XPNDBYYJGAZULZSXGESLWNZXBZWCXV4FNBWEQ35QODGTYQGCR",
  seller: "GDMKMIQMXQCGYI3M5WS36ULX3OTWGNAZEEXQPSHQCJ26VBHISSQRKWY2",
  amount: "2500000",
  amountDecimal: "0.25",
  assetContract: "CCLNIKT3EFMP4TPJLNJFVQDQW6WW3XCUYVFUWEMW6PQJK2BYNIYEHR2D",
  txSource: "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7",
  feeChargedStroops: "23086",
  facilitator: { id: "rail402", displayName: "Rail402" },
  confidence: "rail402",
  sigExpirationLedger: 4091857,
  closedAt: "2026-08-11T20:32:10.000Z",
  resource: "http://127.0.0.1:64672/canary/20260811203111/tides",
  payments: [],
};

/** Captured: an upto settlement from the Agents scene — smart-account (C…) buyer, USDC. */
const UPTO_DETAIL: ExplorerPaymentDetail = {
  network: "stellar:testnet",
  epoch: "2026-08-14T12:13:46.978Z",
  ledger: 4154257,
  txHash: "cae3959f09a6705a12921cfc6e5a71eb974d8934e1e8a0358a7df5d5be50faf3",
  scheme: "upto",
  buyer: "CAPXZD2VKAPPU67375HHKYA3L47IJO26MW3LMFHDTHJYMWFG3VMJNTLK",
  seller: "GDGD7PG25A45FXKJPPYBICT7BOOA2PETF6JDCUTNR77KGMXFPJ7ZUR5Q",
  amount: "200000",
  amountDecimal: "0.02",
  ceiling: "800000",
  ceilingDecimal: "0.08",
  assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  assetCode: "USDC",
  txSource: "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7",
  feeChargedStroops: "215831",
  facilitator: { id: "rail402", displayName: "Rail402" },
  confidence: "rail402",
  sigExpirationLedger: 4154267,
  closedAt: "2026-08-15T11:21:16.000Z",
  resource: "http://playground-api-production-5062.up.railway.app/demo/convert",
  payments: [],
};

const EXPLORER_PAGE = "https://explorer.example";

describe("reshapeExplorerTx", () => {
  it("re-shapes a rail402 exact settlement into the glass timeline", () => {
    const view = reshapeExplorerTx(EXACT_DETAIL, { explorerUrl: EXPLORER_PAGE });
    expect(view.isX402).toBe(true);
    expect(view.scheme).toBe("exact");
    expect(view.confidence).toBe("rail402");
    expect(view.from).toBe(EXACT_DETAIL.buyer);
    expect(view.to).toBe(EXACT_DETAIL.seller);
    expect(view.amountStroops).toBe("2500000");
    // Fee sponsorship read off the ledger: the buyer is not the transaction source.
    expect(view.feeSponsored).toBe(true);
    expect(view.sellerUrl).toBe(EXACT_DETAIL.resource);
    expect(view.explorerUrl).toBe(`${EXPLORER_PAGE}/tx/${EXACT_DETAIL.txHash}`);
    expect(view.stellarExpertUrl).toContain("stellar.expert");
    expect(view.steps.map(s => s.phase)).toEqual(["challenged", "authorized", "settling", "settled"]);
    const settled = view.steps[3]!;
    expect(settled.settlement?.transaction).toBe(EXACT_DETAIL.txHash);
    expect(view.steps[2]!.message).toContain("fee");
    expect(view.steps[2]!.message).toContain("no XLM");
  });

  it("carries the upto ceiling, computes the unspent remainder, and narrates the refund", () => {
    const view = reshapeExplorerTx(UPTO_DETAIL, { explorerUrl: EXPLORER_PAGE });
    expect(view.scheme).toBe("upto");
    expect(view.ceilingStroops).toBe("800000");
    expect(view.unspentStroops).toBe("600000");
    const settled = view.steps[3]!;
    expect(settled.message).toContain("ACTUAL");
    expect(settled.message).toContain("0.06");
    // The buyer is a smart account; the view must not mangle C… addresses.
    expect(view.from).toMatch(/^C/);
  });

  it("keeps the confidence tier qualified, never flattened to fact", () => {
    const shaped: ExplorerPaymentDetail = { ...EXACT_DETAIL, confidence: "x402-shaped", facilitator: null };
    const view = reshapeExplorerTx(shaped, { explorerUrl: EXPLORER_PAGE });
    expect(view.confidence).toBe("x402-shaped");
    expect(view.facilitator).toBeNull();
    expect(view.steps[2]!.message).toContain("inferred, not confirmed");
  });

  it("narrates a zero-amount upto settlement as a nonce burn", () => {
    const burn: ExplorerPaymentDetail = { ...UPTO_DETAIL, amount: "0", amountDecimal: "0" };
    const view = reshapeExplorerTx(burn, { explorerUrl: EXPLORER_PAGE });
    expect(view.steps[3]!.message).toContain("WITHOUT a transfer");
    expect(view.unspentStroops).toBe("800000");
  });

  it("degrades, never crashes, on a malformed amount from the wire", () => {
    const bad: ExplorerPaymentDetail = { ...UPTO_DETAIL, amount: "NaN", ceiling: "1e9" };
    const view = reshapeExplorerTx(bad, { explorerUrl: EXPLORER_PAGE });
    expect(view.unspentStroops).toBeUndefined();
    expect(view.steps).toHaveLength(4);
  });
});

// ── Challenge analysis ──────────────────────────────────────────────────────

const GOOD_OPTION = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "500000",
  payTo: Keypair.random().publicKey(),
  maxTimeoutSeconds: 60,
  asset: USDC_TESTNET_ADDRESS,
  extra: { areFeesSponsored: true },
};
const CFG = { usdcSac: USDC_TESTNET_ADDRESS };

describe("analyzeChallenge", () => {
  it("explains a payable v2 challenge, from object, JSON string, and header forms", () => {
    const challenge = { x402Version: 2, accepts: [GOOD_OPTION], extensions: { bazaar: {} } };
    for (const [input, from] of [
      [challenge, "json"],
      [JSON.stringify(challenge), "json"],
      [encodePaymentRequiredHeader(challenge as unknown as PaymentRequired), "payment-required-header"],
    ] as const) {
      const analysis = analyzeChallenge(input, CFG);
      expect(analysis.ok).toBe(true);
      expect(analysis.decodedFrom).toBe(from);
      expect(analysis.payableOptions).toBe(1);
      expect(analysis.accepts[0]!.amountDecimal).toBe("0.05");
      expect(analysis.accepts[0]!.assetCode).toBe("USDC");
      expect(analysis.accepts[0]!.feesSponsored).toBe(true);
      expect(analysis.hasDiscovery).toBe(true);
      expect(analysis.reason).toContain("Payable");
    }
  });

  it("flags a missing areFeesSponsored as unpayable for no-XLM buyers", () => {
    const analysis = analyzeChallenge(
      { x402Version: 2, accepts: [{ ...GOOD_OPTION, extra: {} }] },
      CFG,
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.accepts[0]!.issues.join(" ")).toContain("areFeesSponsored");
    expect(analysis.accepts[0]!.issues.join(" ")).toContain("stock");
  });

  it("flags a missing maxTimeoutSeconds (required on v2 PaymentRequirements)", () => {
    const rest: Record<string, unknown> = { ...GOOD_OPTION };
    delete rest["maxTimeoutSeconds"];
    const analysis = analyzeChallenge({ x402Version: 2, accepts: [rest] }, CFG);
    expect(analysis.ok).toBe(false);
    expect(analysis.accepts[0]!.issues.join(" ")).toContain("maxTimeoutSeconds");
  });

  it("rejects a checksum-invalid payTo — addresses cannot be hand-edited", () => {
    const analysis = analyzeChallenge(
      { x402Version: 2, accepts: [{ ...GOOD_OPTION, payTo: "GBADCHECKSUMBADCHECKSUMBADCHECKSUMBADCHECKSUMBADCHECKSUM" }] },
      CFG,
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.accepts[0]!.issues.join(" ")).toContain("checksum");
  });

  it("requires the upto settlement contract on upto options", () => {
    const analysis = analyzeChallenge(
      { x402Version: 2, accepts: [{ ...GOOD_OPTION, scheme: "upto" }] },
      CFG,
    );
    expect(analysis.ok).toBe(false);
    expect(analysis.accepts[0]!.issues.join(" ")).toContain("uptoContract");
  });

  it("reports a challenge with no Stellar option as unsettleable, without inventing issues on the EVM option", () => {
    const evm = { scheme: "exact", network: "eip155:8453", amount: "10000", payTo: "0xabc" };
    const analysis = analyzeChallenge({ x402Version: 2, accepts: [evm] }, CFG);
    expect(analysis.ok).toBe(false);
    expect(analysis.stellarOptions).toBe(0);
    expect(analysis.accepts[0]!.issues).toHaveLength(0);
    expect(analysis.issues.join(" ")).toContain("No Stellar payment option");
  });

  it("flags the wrong protocol generation", () => {
    const analysis = analyzeChallenge({ x402Version: 1, accepts: [GOOD_OPTION] }, CFG);
    expect(analysis.ok).toBe(false);
    expect(analysis.issues.join(" ")).toContain("version 2");
  });

  it("treats undecodable input as an analysis result, not a crash", () => {
    for (const garbage of ["not base64 not json", "{broken json", 42]) {
      const analysis = analyzeChallenge(garbage, CFG);
      expect(analysis.ok).toBe(false);
      expect(analysis.reason.length).toBeGreaterThan(0);
    }
  });
});

// ── Wire ────────────────────────────────────────────────────────────────────

const SECRET = Keypair.random().secret();
const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
  ],
  extensions: ["bazaar"],
};

let stub: ServerType;
let stubUrl: string;

beforeAll(async () => {
  const upstream = new Hono();
  upstream.get("/supported", c => c.json(SUPPORTED));
  upstream.get("/tx/:hash", c => {
    const hash = c.req.param("hash");
    if (hash === EXACT_DETAIL.txHash) return c.json(EXACT_DETAIL);
    if (hash === UPTO_DETAIL.txHash) return c.json(UPTO_DETAIL);
    return c.json(
      {
        code: "explorer_tx_not_found",
        reason: "No ingested payment matches this transaction hash.",
        retryable: true,
        details: { hash },
      },
      404,
    );
  });
  await new Promise<void>(resolve => {
    stub = serve({ fetch: upstream.fetch, port: 0 }, info => {
      stubUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => stub.close());

function makeApp(overrides: Record<string, string> = {}) {
  const config: PlaygroundConfig = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: SECRET,
    PLAYGROUND_FACILITATOR_URL: stubUrl,
    PLAYGROUND_EXPLORER_API_URL: stubUrl,
    PLAYGROUND_EXPLORER_URL: EXPLORER_PAGE,
    ...overrides,
  } as NodeJS.ProcessEnv);
  return { config, ...createApp({ config }) };
}

describe("wire: /debug/*", () => {
  it("decodes a settled tx through the explorer contract", async () => {
    const { app } = makeApp();
    const res = await app.request("/debug/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: UPTO_DETAIL.txHash }),
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { scheme: string; unspentStroops: string; explorerUrl: string };
    expect(view.scheme).toBe("upto");
    expect(view.unspentStroops).toBe("600000");
    expect(view.explorerUrl).toBe(`${EXPLORER_PAGE}/tx/${UPTO_DETAIL.txHash}`);
  });

  it("relays the explorer's own coded not-found, retryable, verbatim", async () => {
    const { app } = makeApp();
    const res = await app.request("/debug/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: "0".repeat(64) }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; retryable: boolean };
    expect(body.code).toBe("explorer_tx_not_found");
    expect(body.retryable).toBe(true);
  });

  it("refuses a malformed hash with a coded 400 before any network call", async () => {
    const { app } = makeApp();
    const res = await app.request("/debug/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: "not-a-hash" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("playground_invalid_request");
  });

  it("reports an unreachable explorer with its own coded 502", async () => {
    const { app } = makeApp({ PLAYGROUND_EXPLORER_API_URL: "http://127.0.0.1:1" });
    const res = await app.request("/debug/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: EXACT_DETAIL.txHash }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("playground_explorer_unreachable");
    expect(body.reason).toContain("stellar.expert");
  });

  it("analyzes the app's OWN live 402s: convert's header (the stock middleware sends an empty body) and the meter's body", async () => {
    const { app } = makeApp();

    // The stock @x402/hono middleware carries the v2 challenge ONLY in PAYMENT-REQUIRED.
    const convertRes = await app.request("/demo/convert?amount=0.5");
    expect(convertRes.status).toBe(402);
    const header = convertRes.headers.get("PAYMENT-REQUIRED")!;
    const fromHeader = await app.request("/debug/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: header }),
    });
    const headerAnalysis = (await fromHeader.json()) as {
      ok: boolean;
      decodedFrom: string;
      accepts: { amountDecimal?: string; feesSponsored: boolean }[];
    };
    expect(headerAnalysis.ok).toBe(true);
    expect(headerAnalysis.decodedFrom).toBe("payment-required-header");
    expect(headerAnalysis.accepts[0]!.amountDecimal).toBe("0.05");
    expect(headerAnalysis.accepts[0]!.feesSponsored).toBe(true);

    // The meter serves its upto challenge as the 402 body too — the raw-JSON path, with a REAL
    // uptoContract in extra.
    const meterRes = await app.request("/demo/meter/open", { method: "POST" });
    expect(meterRes.status).toBe(402);
    const fromBody = await app.request("/debug/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: await meterRes.text() }),
    });
    const bodyAnalysis = (await fromBody.json()) as {
      ok: boolean;
      decodedFrom: string;
      accepts: { scheme?: string; uptoContract?: string }[];
    };
    expect(bodyAnalysis.ok).toBe(true);
    expect(bodyAnalysis.decodedFrom).toBe("json");
    expect(bodyAnalysis.accepts[0]!.scheme).toBe("upto");
    expect(bodyAnalysis.accepts[0]!.uptoContract).toMatch(/^C/);
  });

  it("announces the debug endpoints and the explorer URLs in /session/config", async () => {
    const { app } = makeApp();
    const config = (await (await app.request("/session/config")).json()) as {
      demo: { debug: { txPath: string; challengePath: string } };
      explorer: { url: string; apiUrl: string };
    };
    expect(config.demo.debug.txPath).toBe("/debug/tx");
    expect(config.demo.debug.challengePath).toBe("/debug/challenge");
    // P3 cross-linking: the frontend reads these rather than hard-coding explorer hosts.
    expect(config.explorer.url).toBe(EXPLORER_PAGE);
    expect(config.explorer.apiUrl).toBe(stubUrl);
  });
});
