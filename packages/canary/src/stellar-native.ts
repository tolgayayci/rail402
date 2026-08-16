import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { X402Error } from "@rail402.dev/errors";
import { CanaryRun, type CanaryReport } from "./report.js";
import { callFacilitator, decodeExtensionResponses, reasonOf, stockBuyer } from "./payment.js";
import { requireBazaarFacilitator } from "./supported.js";
import { startSyntheticSeller, type SyntheticSeller } from "./seller.js";
import { findRepoRoot } from "./facilitator.js";
import { readProvisioned } from "./provision.js";
import { HORIZON_URL, NETWORK, friendbotFund, sleep } from "./testnet.js";

/**
 * The Stellar-native enrichment canary.
 *
 * Everything else in this repository could be built on any chain. This check covers the part that
 * could not, and re-proves it against a live network with **real testnet USDC**:
 *
 *  1. **Provable asset identity.** A Stellar Asset Contract address is a hash of
 *     (code, issuer, network passphrase), so the facilitator can *derive* that a given `C…` is
 *     canonical USDC rather than take a seller's word for it. An EVM or SVM catalog can only consult
 *     a token list somebody maintains by hand.
 *  2. **Trustline pre-flight.** On Stellar a payee that has not established a trustline cannot
 *     receive the asset, and the payment fails on-ledger. Answering that at *discovery* time is the
 *     difference between an agent choosing another seller and an agent signing a payment that cannot
 *     land. No other chain has this failure mode, so no other catalog answers it.
 *  3. **That both survive the whole path to the agent.** Derivation is worthless if the projection
 *     drops it, and dropping `extra` wholesale is not hypothetical — it is exactly how fee
 *     sponsorship went missing from the agent's view once already. So the last step is a real MCP
 *     client, over stdio, calling the real tool, reading the real `structuredContent`.
 *
 * Why real USDC rather than the run-scoped asset the other canaries mint: the derivation only means
 * something for an asset the facilitator can independently vouch for, and a self-issued asset is by
 * definition not one. This check therefore needs the provisioned accounts in `.env.testnet` (from
 * `pnpm canary provision-usdc`), because testnet USDC comes from a faucet with a captcha and cannot
 * be conjured.
 */

/** 0.01 USDC at 7 decimals. Atomic units, never a float. Small enough to run this for years. */
const AMOUNT = "100000";
const AMOUNT_DECIMAL = "0.0100000";
const CATALOG_DEADLINE_MS = 30_000;
const POLL_MS = 250;

export interface StellarNativeOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  readonly log?: (line: string) => void;
}

interface DiscoveryResource {
  resource: string;
  accepts?: {
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    extra?: Record<string, unknown>;
  }[];
}

interface AssetIdentity {
  code?: string;
  issuer?: string | null;
  decimals?: number;
  identity?: string;
}
interface TrustlinePreflight {
  state?: string;
  checkedAt?: string;
  reason?: string;
}

export async function runStellarNative(options: StellarNativeOptions): Promise<CanaryReport> {
  const run = new CanaryRun(
    "stellar-native",
    NETWORK,
    options.facilitatorUrl,
    options.log ?? (line => console.error(line)),
  );
  let seller: SyntheticSeller | undefined;

  try {
    await run.step("facilitator-reachable", async () => {
      const extensions = await requireBazaarFacilitator(options.facilitatorUrl);
      return { detail: `/supported advertises ${extensions.join(", ")}` };
    });

    // ── Provisioned USDC accounts ───────────────────────────────────────────
    const accounts = await run.step("usdc-accounts", async () => {
      const provisioned = readProvisioned(findRepoRoot());
      if (!provisioned.payer || !provisioned.seller) {
        throw new X402Error("canary_setup_failed", {
          reason:
            "This check pays in REAL testnet USDC, which friendbot cannot mint, so it needs the accounts from `pnpm canary provision-usdc` in .env.testnet. A self-issued asset would defeat the point: the facilitator can only derive an identity for an asset it independently knows.",
        });
      }
      const payer = Keypair.fromSecret(provisioned.payer);
      const sellerKp = Keypair.fromSecret(provisioned.seller);

      const payerUsdc = await usdcBalance(payer.publicKey());
      if (payerUsdc === undefined || Number(payerUsdc) < 1e-5) {
        throw new X402Error("canary_setup_failed", {
          reason: `The provisioned payer ${payer.publicKey()} holds ${payerUsdc ?? "no"} USDC, so it cannot make the payment this check is built on. Top it up from the Circle testnet faucet.`,
          details: { payer: payer.publicKey(), usdc: payerUsdc ?? null },
        });
      }
      // The SELLER's trustline is the subject of step `trustline-preflight`, so it must be present
      // here or that step would be asserting the wrong thing for the wrong reason.
      const sellerUsdc = await usdcBalance(sellerKp.publicKey());
      if (sellerUsdc === undefined) {
        throw new X402Error("canary_setup_failed", {
          reason: `The provisioned seller ${sellerKp.publicKey()} has no USDC trustline, so a payment to it could not settle and the pre-flight would correctly report a problem the fixture created.`,
          details: { seller: sellerKp.publicKey() },
        });
      }
      return {
        detail: `payer ${short(payer.publicKey())} holds ${payerUsdc} USDC · seller trustline present`,
        payer,
        sellerAddress: sellerKp.publicKey(),
      };
    });

    seller = (
      await run.step("seller-online", async () => {
        const s = await startSyntheticSeller({
          facilitatorUrl: options.facilitatorUrl,
          network: NETWORK,
          payTo: accounts.sellerAddress,
          // The canonical testnet USDC contract, as published by @x402/stellar. This is the value
          // the facilitator's registry re-derives from (code, issuer) on every build.
          asset: USDC_TESTNET_ADDRESS,
          amount: AMOUNT,
          runId: options.runId,
        });
        return { detail: `${s.catalogKey} priced at ${AMOUNT} (${AMOUNT_DECIMAL} USDC)`, s };
      })
    ).s;

    // ── A real payment, in real USDC ────────────────────────────────────────
    const buyer = stockBuyer(accounts.payer.secret());
    const payment = await run.step("payload-built", async () => {
      const built = await buyer.pay(seller!.resourceUrl);
      return { detail: "stock client, discovery extension present", ...built };
    });

    await run.step("verify", async () => {
      const { body } = await callFacilitator(
        options.facilitatorUrl,
        "/verify",
        payment.payload,
        payment.accepted,
      );
      if (body["isValid"] !== true) {
        throw new X402Error("canary_settlement_failed", {
          reason: `Verification rejected the canary's own USDC payment: ${reasonOf(body)}`,
          details: { response: body },
        });
      }
      return { detail: "isValid: true" };
    });

    const settled = await run.step("settle", async () => {
      const { body, headers } = await callFacilitator(
        options.facilitatorUrl,
        "/settle",
        payment.payload,
        payment.accepted,
      );
      if (body["success"] !== true) {
        throw new X402Error("canary_settlement_failed", {
          reason: `Settlement of the USDC payment failed: ${reasonOf(body)}`,
          details: { response: body },
        });
      }
      const transaction = typeof body["transaction"] === "string" ? body["transaction"] : "";
      const verdict = decodeExtensionResponses(headers.get("extension-responses"));
      if (verdict?.status !== "success") {
        throw new X402Error("canary_extension_response_missing", {
          reason: verdict
            ? `The facilitator reported cataloging as "${verdict.status}"${verdict.rejectedReason ? `: ${verdict.rejectedReason}` : ""}.`
            : "The settle response carried no readable EXTENSION-RESPONSES header.",
        });
      }
      run.observe("transaction", transaction);
      run.observe("amount", AMOUNT);
      run.observe("asset", USDC_TESTNET_ADDRESS);
      run.observe("assetCode", "USDC");
      return { detail: `tx ${short(transaction)} · cataloged`, transaction };
    });

    // ── 1. Provable asset identity ──────────────────────────────────────────
    const identity = await run.step("asset-identity", async () => {
      const accepts = await pollAccepts(options.facilitatorUrl, seller!.catalogKey, accounts.sellerAddress);
      const stellar = (accepts.extra?.["stellar"] ?? {}) as Record<string, unknown>;
      const asset = stellar["asset"] as AssetIdentity | undefined;
      if (!asset || asset.identity !== "derived") {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: `The cataloged USDC listing carries no facilitator-derived asset identity (extra.stellar.asset), so an agent reading this catalog cannot tell canonical USDC from a look-alike issuer using the same code. Got: ${JSON.stringify(stellar)}`,
          details: { resource: seller!.catalogKey, stellar },
        });
      }
      if (asset.code !== "USDC" || asset.decimals !== 7 || typeof asset.issuer !== "string") {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: `The derived identity for ${USDC_TESTNET_ADDRESS} is not canonical testnet USDC: ${JSON.stringify(asset)}. A wrong derivation is worse than none — it vouches for the wrong token.`,
          details: { asset },
        });
      }
      run.observe("assetIdentity", asset);
      return { detail: `${asset.code} issued by ${short(asset.issuer)} · ${asset.decimals} decimals · derived` };
    });
    void identity;

    // ── 2. Trustline pre-flight, on the seller's real account ───────────────
    await run.step("trustline-preflight", async () => {
      // The check is fire-and-forget behind the settlement, so it resolves shortly AFTER the entry
      // is written — which is the property being demonstrated, not a race to paper over.
      const deadline = Date.now() + CATALOG_DEADLINE_MS;
      for (;;) {
        const accepts = await pollAccepts(options.facilitatorUrl, seller!.catalogKey, accounts.sellerAddress);
        const stellar = (accepts.extra?.["stellar"] ?? {}) as Record<string, unknown>;
        const preflight = stellar["payToTrustline"] as TrustlinePreflight | undefined;
        if (preflight?.state) {
          if (preflight.state !== "ok") {
            throw new X402Error("canary_stellar_metadata_missing", {
              reason: `The trustline pre-flight reports "${preflight.state}" for a seller that provably holds a USDC trustline (the payment above settled to it). ${preflight.reason ?? ""}`,
              details: { preflight, payTo: accounts.sellerAddress },
            });
          }
          run.observe("payToTrustline", preflight);
          return { detail: `state "ok" for ${short(accounts.sellerAddress)} (checked ${preflight.checkedAt})` };
        }
        if (Date.now() >= deadline) {
          throw new X402Error("canary_stellar_metadata_missing", {
            reason: `The listing never gained a trustline pre-flight (extra.stellar.payToTrustline) within ${CATALOG_DEADLINE_MS}ms, so an agent cannot tell whether this payee can receive USDC before paying.`,
            details: { resource: seller!.catalogKey, stellar },
          });
        }
        await sleep(POLL_MS);
      }
    });

    // The negative state, on a real account rather than a mock: a freshly funded account has XLM and
    // no USDC trustline, so a payment in USDC to it would fail. If the checker cannot see that, the
    // `ok` above proves nothing — it could be a function that returns "ok" unconditionally.
    await run.step("trustline-missing-detected", async () => {
      const fresh = Keypair.random();
      await friendbotFund(fresh);
      const { TrustlineChecker } = await import("@rail402.dev/bazaar");
      const verdict = await new TrustlineChecker().check(
        NETWORK,
        USDC_TESTNET_ADDRESS,
        fresh.publicKey(),
      );
      if (verdict?.state !== "missing") {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: `A freshly funded account with no USDC trustline was reported as "${verdict?.state ?? "no verdict"}" rather than "missing". A pre-flight that cannot see the problem it exists to detect is worse than none.`,
          details: { account: fresh.publicKey(), verdict: verdict ?? null },
        });
      }
      if (!verdict.reason) {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: "The `missing` verdict carried no reason, so a seller is told there is a problem without being told what to fix.",
        });
      }
      run.observe("trustlineMissingProbe", { account: fresh.publicKey(), reason: verdict.reason });
      return { detail: `fresh account ${short(fresh.publicKey())} -> "missing", with a reason` };
    });

    // ── 3. All of it reaches an agent, through the real MCP tool ────────────
    await run.step("agent-sees-it", async () => {
      const hit = await searchThroughMcp(options.facilitatorUrl, seller!.catalogKey);
      const price = hit.price;
      if (!price?.assetIdentity || price.assetIdentity.identity !== "derived") {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: `search_stellar_resources returned the listing without price.assetIdentity, so the derivation stops at the catalog and never reaches the agent. Got: ${JSON.stringify(price)}`,
          details: { price },
        });
      }
      if (price.amountDecimal !== AMOUNT_DECIMAL) {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: `The agent was shown amountDecimal ${JSON.stringify(price.amountDecimal)} for ${AMOUNT} atomic units of a 7-decimal token; expected ${AMOUNT_DECIMAL}. An agent budgeting off a wrong decimal rendering is off by orders of magnitude.`,
          details: { price },
        });
      }
      if (price.payToTrustline?.state !== "ok") {
        throw new X402Error("canary_stellar_metadata_missing", {
          reason: `search_stellar_resources returned the listing without an "ok" trustline pre-flight (got ${JSON.stringify(price.payToTrustline)}), so an agent cannot prefer a payee that can actually receive the asset.`,
          details: { price },
        });
      }
      run.observe("agentPrice", price);
      return {
        detail: `MCP tool reports ${price.amountDecimal} ${price.assetIdentity.code} (derived) · trustline ok`,
      };
    });

    run.observe("resource", seller.catalogKey);
    run.observe("settledTransaction", settled.transaction);
    return run.finish();
  } catch (error) {
    run.observe("resource", seller?.catalogKey ?? null);
    return run.finish(error);
  } finally {
    await seller?.close();
  }
}

/** Fetch the catalog entry's payment option for this exact payee, waiting for it to appear. */
async function pollAccepts(
  base: string,
  catalogKey: string,
  payTo: string,
): Promise<NonNullable<DiscoveryResource["accepts"]>[number]> {
  const deadline = Date.now() + CATALOG_DEADLINE_MS;
  for (;;) {
    const url = new URL("/discovery/resources", base);
    url.searchParams.set("payTo", payTo);
    url.searchParams.set("network", NETWORK);
    const body = (await (await fetch(url)).json()) as { items?: DiscoveryResource[] };
    const entry = (body.items ?? []).find(r => r.resource === catalogKey);
    const accepts = entry?.accepts?.find(a => a.asset === USDC_TESTNET_ADDRESS && a.payTo === payTo);
    if (accepts) return accepts;
    if (Date.now() >= deadline) {
      throw new X402Error("canary_resource_not_indexed", {
        reason: `${catalogKey} settled but never appeared in GET /discovery/resources with a USDC payment option within ${CATALOG_DEADLINE_MS}ms.`,
        details: { resource: catalogKey, payTo },
      });
    }
    await sleep(POLL_MS);
  }
}

interface AgentHit {
  resource: string;
  price?: {
    amount: string;
    amountDecimal?: string;
    assetIdentity?: AssetIdentity;
    payToTrustline?: TrustlinePreflight;
  };
}

/**
 * Call `search_stellar_resources` the way an agent runtime does: as an MCP client, over stdio,
 * against the built server.
 *
 * Deliberately not by importing the projection function. The property under test is that the
 * enrichment survives every hop to the agent, and an in-process import skips the two hops most
 * likely to drop it — the tool's declared output schema and the JSON-RPC serialisation.
 */
async function searchThroughMcp(bazaarUrl: string, catalogKey: string): Promise<AgentHit> {
  const client = new Client({ name: "stellar-native-canary", version: "0.1.0" });
  const serverEntry = new URL("../../../apps/mcp-discovery/dist/index.js", import.meta.url).pathname;

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, BAZAAR_URL: bazaarUrl } as Record<string, string>,
    }),
  );

  try {
    const result = (await client.callTool({
      name: "search_stellar_resources",
      // The listing's own description, so this exercises retrieval rather than an id lookup.
      arguments: { query: "tide times and sea conditions at a coastal port", limit: 20 },
    })) as { isError?: boolean; structuredContent?: { ok?: boolean; data?: { results?: AgentHit[] } } };

    if (result.isError || !result.structuredContent?.ok) {
      throw new X402Error("canary_stellar_metadata_missing", {
        reason: `The MCP search tool returned an error instead of results: ${JSON.stringify(result.structuredContent)}`,
      });
    }
    const hit = (result.structuredContent.data?.results ?? []).find(r => r.resource === catalogKey);
    if (!hit) {
      throw new X402Error("canary_resource_not_ranked", {
        reason: `The listing settled and is in the catalog, but search_stellar_resources did not return it among ${result.structuredContent.data?.results?.length ?? 0} result(s).`,
        details: { resource: catalogKey },
      });
    }
    return hit;
  } finally {
    await client.close();
  }
}

/** The payee's USDC balance, or undefined when it holds no trustline to it. */
async function usdcBalance(address: string): Promise<string | undefined> {
  const response = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!response.ok) return undefined;
  const body = (await response.json()) as {
    balances?: { asset_code?: string; balance?: string }[];
  };
  return body.balances?.find(b => b.asset_code === "USDC")?.balance;
}

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
