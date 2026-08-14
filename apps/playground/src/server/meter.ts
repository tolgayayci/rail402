import { createHash, randomUUID } from "node:crypto";
import { createError, isErrorCode, type X402ErrorPayload } from "@rail402/errors";
import type { PaymentPayload, PaymentRequirements, PaymentRequired } from "@x402/core/types";
import { uptoContractFor } from "@rail402/scheme-upto-stellar";
import type { PlaygroundConfig } from "./config.js";
import { NETWORK } from "./config.js";
import { stroopsToDisplay } from "../shared/amounts.js";

/**
 * The metered demo behind the playground's "bar tab" scene — the `upto` scheme end to end.
 *
 * Flow, and where each amount lives (the asymmetry that IS the scheme):
 *  - `open`   — the buyer authorizes a CEILING. The facilitator verifies the payload with
 *               `paymentRequirements.amount` = the signed ceiling.
 *  - `call`   — usage accrues server-side, never touching the ledger.
 *  - `close`  — the seller settles the ACTUAL total: same payload, verbatim, with
 *               `paymentRequirements.amount` = what was actually used. The facilitator swaps the
 *               unsigned `actual_amount` argument and submits; over-ceiling and replay are
 *               refused on-chain.
 *
 * The seller (this module) is the only party holding state between open and close: the
 * facilitator is stateless, so the tab store keeps the buyer's payload alive until settlement.
 * Tabs die with their authorization: `TAB_SECONDS` drives both `maxTimeoutSeconds` in the 402
 * challenge and the wall-clock TTL here.
 */

export const TAB_SECONDS = 600;

/** Close a little before the authorization's ledger bound so settlement has time to land. */
const TAB_TTL_MS = (TAB_SECONDS - 60) * 1000;

interface Tab {
  readonly id: string;
  readonly payload: PaymentPayload;
  readonly ceiling: bigint;
  readonly payer: string | undefined;
  readonly openedAt: number;
  used: bigint;
  calls: number;
  state: "open" | "closed";
}

export interface FacilitatorVerifyBody {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly invalidMessage?: string;
  readonly payer?: string;
}

export interface FacilitatorSettleBody {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly errorMessage?: string;
  readonly transaction?: string;
  readonly payer?: string;
  readonly amount?: string;
}

export interface MeterDeps {
  readonly config: PlaygroundConfig;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** A refusal that carries the registry envelope plus the HTTP status to serve it with. */
export class MeterRefusal extends Error {
  constructor(
    readonly status: 400 | 402 | 404 | 502,
    readonly payload: X402ErrorPayload,
  ) {
    super(payload.reason);
  }
}

export function createMeter({ config, fetchImpl = fetch, now = Date.now }: MeterDeps) {
  const tabs = new Map<string, Tab>();

  function requirements(amountStroops: bigint): PaymentRequirements {
    return {
      scheme: "upto",
      network: NETWORK,
      asset: config.usdc.sac,
      amount: amountStroops.toString(),
      payTo: config.payTo,
      maxTimeoutSeconds: TAB_SECONDS,
      extra: {
        uptoContract: uptoContractFor(NETWORK),
        areFeesSponsored: true,
      },
    };
  }

  /** The 402 challenge for `open`. The advertised amount is the ceiling the seller meters up to. */
  function paymentRequired(resourceUrl: string): PaymentRequired {
    return {
      x402Version: 2,
      error: "Payment required: authorize a spending ceiling to open a metered tab.",
      resource: {
        url: resourceUrl,
        description:
          "Open a metered tab: authorize a ceiling in USDC, make calls that accrue usage, settle only what was used.",
        mimeType: "application/json",
      },
      accepts: [requirements(config.exactPriceStroops * 20n)],
    };
  }

  function pruneExpired(): void {
    const at = now();
    for (const [id, tab] of tabs) {
      if (tab.state === "open" && at - tab.openedAt > TAB_TTL_MS) tabs.delete(id);
    }
  }

  function liveTab(tabId: string): Tab {
    pruneExpired();
    const tab = tabs.get(tabId);
    if (!tab) {
      throw new MeterRefusal(404, createError("playground_meter_tab_not_found", { details: { tabId } }));
    }
    if (tab.state === "closed") {
      throw new MeterRefusal(400, createError("playground_meter_tab_closed", { details: { tabId } }));
    }
    return tab;
  }

  async function callFacilitator(
    path: "/verify" | "/settle",
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${config.facilitatorUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: reqs }),
      });
    } catch (err) {
      throw new MeterRefusal(
        502,
        createError("playground_facilitator_unreachable", {
          reason: `The facilitator at ${config.facilitatorUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}. Nothing was charged.`,
        }),
      );
    }
    return res.json();
  }

  /**
   * Verify the buyer's ceiling authorization and open a tab.
   *
   * The ceiling verified is the one the BUYER signed (`payload.payload.maxAmount`) — the
   * facilitator refuses any requirements amount that disagrees with the signed XDR, and a buyer
   * authorizing less than the advertised ceiling is the scheme working, not an error. The tab
   * simply meters up to what was actually authorized.
   */
  async function open(payload: PaymentPayload): Promise<{
    tabId: string;
    ceiling: string;
    unitCost: string;
    payer: string | undefined;
    expiresInSeconds: number;
  }> {
    const accepted = payload.accepted;
    if (accepted.scheme !== "upto" || accepted.network !== NETWORK) {
      throw new MeterRefusal(
        400,
        createError("playground_invalid_request", {
          reason: `The metered demo takes an upto payment on ${NETWORK}; this payload is ${accepted.scheme} on ${accepted.network}.`,
        }),
      );
    }

    const rawCeiling = (payload.payload as { maxAmount?: unknown }).maxAmount;
    let ceiling: bigint;
    try {
      ceiling = BigInt(String(rawCeiling));
    } catch {
      ceiling = -1n;
    }
    if (ceiling < config.meterUnitStroops) {
      throw new MeterRefusal(
        400,
        createError("playground_invalid_request", {
          reason: `The authorized ceiling must cover at least one metered call (${stroopsToDisplay(config.meterUnitStroops)} USDC); got ${String(rawCeiling)}.`,
        }),
      );
    }

    const verify = (await callFacilitator("/verify", payload, requirements(ceiling))) as FacilitatorVerifyBody;
    if (!verify.isValid) {
      // Surface the facilitator's own coded refusal verbatim — re-wrapping it would hide the code
      // an agent branches on. The facilitator shares this registry, so its codes resolve here.
      throw new MeterRefusal(
        402,
        createError(isErrorCode(verify.invalidReason) ? verify.invalidReason : "unexpected_verify_error", {
          ...(verify.invalidMessage ? { reason: verify.invalidMessage } : {}),
        }),
      );
    }

    pruneExpired();
    const tab: Tab = {
      id: randomUUID(),
      payload,
      ceiling,
      payer: verify.payer,
      openedAt: now(),
      used: 0n,
      calls: 0,
      state: "open",
    };
    tabs.set(tab.id, tab);
    return {
      tabId: tab.id,
      ceiling: tab.ceiling.toString(),
      unitCost: config.meterUnitStroops.toString(),
      payer: tab.payer,
      expiresInSeconds: Math.floor(TAB_TTL_MS / 1000),
    };
  }

  /** One unit of honest, deterministic work: a digest chained over the tab and call number. */
  function call(tabId: string): {
    call: number;
    digest: string;
    unitCost: string;
    used: string;
    remaining: string;
  } {
    const tab = liveTab(tabId);
    const next = tab.used + config.meterUnitStroops;
    if (next > tab.ceiling) {
      throw new MeterRefusal(
        402,
        createError("playground_meter_ceiling_reached", {
          details: {
            ceiling: tab.ceiling.toString(),
            used: tab.used.toString(),
            unitCost: config.meterUnitStroops.toString(),
          },
        }),
      );
    }
    tab.used = next;
    tab.calls += 1;
    const digest = createHash("sha256").update(`${tab.id}:${tab.calls}`).digest("hex").slice(0, 16);
    return {
      call: tab.calls,
      digest,
      unitCost: config.meterUnitStroops.toString(),
      used: tab.used.toString(),
      remaining: (tab.ceiling - tab.used).toString(),
    };
  }

  /** Settle actual usage. Zero is settled too — it consumes the authorization on-ledger (cheaply). */
  async function close(tabId: string): Promise<{
    transaction: string | undefined;
    settled: string;
    ceiling: string;
    unspent: string;
    calls: number;
    payer: string | undefined;
  }> {
    const tab = liveTab(tabId);
    const settle = (await callFacilitator("/settle", tab.payload, requirements(tab.used))) as FacilitatorSettleBody;
    if (!settle.success) {
      throw new MeterRefusal(
        402,
        createError(isErrorCode(settle.errorReason) ? settle.errorReason : "unexpected_settle_error", {
          ...(settle.errorMessage ? { reason: settle.errorMessage } : {}),
          details: { tabId, attemptedAmount: tab.used.toString() },
        }),
      );
    }
    tab.state = "closed";
    return {
      transaction: settle.transaction,
      settled: tab.used.toString(),
      ceiling: tab.ceiling.toString(),
      unspent: (tab.ceiling - tab.used).toString(),
      calls: tab.calls,
      payer: settle.payer ?? tab.payer,
    };
  }

  return { paymentRequired, open, call, close, requirements };
}
