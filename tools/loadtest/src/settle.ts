/**
 * The settle probe: real `exact` payments settled through a facilitator's `POST /settle` at a constant
 * rate, on a local private Stellar network, while other load runs. Each payment is signed shortly
 * before it is due, so signing never counts in its latency, and the probe measures how long the
 * facilitator takes to settle from when the request was due (open loop, as the discovery driver).
 *
 * The facilitator must accept the probe's asset: `settleFacilitatorEnv` gives the settings it needs.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { LocalNetwork, requirementsFor, type PaymentRequirementsLike } from "@rail402.dev/testkit";
import type { Sample } from "./driver.ts";

/** What a settle probe pays with: an asset on the local network, its payers and the recipient. */
export interface SettleSetup {
  readonly rpcUrl: string;
  readonly friendbotUrl: string;
  /** The asset's Stellar Asset Contract. */
  readonly asset: string;
  readonly code: string;
  readonly payTo: string;
  /** Base units each payment moves. */
  readonly amount: string;
  /** Secret keys of throwaway payer accounts on the local network, each holding the asset. */
  readonly payers: readonly string[];
}

/** Accepts only a loopback RPC: the probe is for a private network on this machine. */
export function assertLocalRpc(rpcUrl: string): void {
  const host = new URL(rpcUrl).hostname.replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`the settle probe runs on a local private network only, not ${rpcUrl}`);
  }
}

/** Issues an asset on the local network and funds `payers` accounts with it, and a recipient. */
export async function createSettleSetup(
  net: LocalNetwork,
  options: { payers: number; amount?: bigint; code?: string },
): Promise<SettleSetup> {
  assertLocalRpc(net.rpcUrl);
  const code = options.code ?? "USDC";
  const issued = await net.issueAsset(code);
  const [payTo, ...payers] = await net.holders(issued, options.payers + 1, "1000");
  if (payTo === undefined) throw new Error("no recipient was created");
  return {
    rpcUrl: net.rpcUrl,
    friendbotUrl: net.friendbotUrl,
    asset: issued.sac,
    code,
    payTo: payTo.publicKey(),
    amount: String(options.amount ?? 10_000n),
    payers: payers.map((payer) => payer.secret()),
  };
}

/** The facilitator settings that make it accept the probe's payments on the local network. */
export function settleFacilitatorEnv(setup: SettleSetup): Record<string, string> {
  return {
    TESTNET_RPC_URL: setup.rpcUrl,
    TESTNET_ASSETS: `${setup.asset}:${setup.code}:7`,
  };
}

export interface SettleProbeOptions {
  /** The facilitator's base URL, e.g. http://127.0.0.1:8080. */
  readonly facilitator: string;
  readonly setup: SettleSetup;
  /** Settlements per second. */
  readonly rate: number;
  readonly durationMs: number;
  readonly onSample: (sample: Sample) => void;
  /** How long before its due time a payment is signed (default 3 s). */
  readonly leadMs?: number;
  readonly timeoutMs?: number;
  /** Signs a payment; by default as the stock client does, on the setup's network. */
  readonly pay?: (payer: Keypair, requirements: PaymentRequirementsLike) => Promise<unknown>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

/**
 * Settles at `rate` per second for `durationMs`, payers taken in turn, and waits for every settlement.
 * A sample's status is the HTTP status; a settlement the facilitator answered without success carries
 * its `errorReason` as `error`. A payment the probe could not sign is recorded as
 * `client_payment_failed`, unsent, so it never counts as facilitator latency.
 */
export async function runSettleProbe(options: SettleProbeOptions): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? (() => performance.now());
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const net = new LocalNetwork(options.setup.rpcUrl, options.setup.friendbotUrl);
  const pay = options.pay ?? ((payer, requirements) => net.payment(payer, requirements));
  const payers = options.setup.payers.map((secret) => Keypair.fromSecret(secret));
  if (payers.length === 0) throw new Error("the settle setup has no payers");
  const requirements = requirementsFor(options.setup.asset, options.setup.payTo, options.setup.amount);
  const leadMs = options.leadMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const total = Math.floor((options.rate * options.durationMs) / 1_000);
  const interval = 1_000 / options.rate;
  // The schedule starts one lead after now, so the first payment is signed ahead of time too.
  const start = now() + leadMs;
  const url = `${options.facilitator.replace(/\/$/, "")}/settle`;
  let sent = 0;
  let failed = 0;

  const one = async (index: number): Promise<void> => {
    const due = index * interval;
    const common = { dueMs: round(due), label: "settle", path: "/settle" };
    await sleepUntil(start + due - leadMs, now);
    let payload: unknown;
    try {
      payload = await pay(payers[index % payers.length] as Keypair, requirements);
    } catch (error) {
      failed++;
      options.onSample({
        ...common,
        status: 0,
        latencyMs: 0,
        serviceMs: 0,
        error: `client_payment_failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`,
      });
      return;
    }
    await sleepUntil(start + due, now);
    sent++;
    const sentAt = now();
    try {
      const response = await send(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        errorReason?: string;
        transaction?: string;
      };
      const done = now();
      options.onSample({
        ...common,
        status: response.status,
        latencyMs: round(done - (start + due)),
        serviceMs: round(done - sentAt),
        ...(body.success === true ? {} : { error: body.errorReason ?? "settle_failed" }),
        ...(typeof body.transaction === "string" && body.transaction !== ""
          ? { transaction: body.transaction }
          : {}),
      });
    } catch (error) {
      const done = now();
      options.onSample({
        ...common,
        status: 0,
        latencyMs: round(done - (start + due)),
        serviceMs: round(done - sentAt),
        error: error instanceof Error ? error.name : "error",
      });
    }
  };

  await Promise.all(Array.from({ length: total }, (_, index) => one(index)));
  return { sent, failed };
}

async function sleepUntil(at: number, now: () => number): Promise<void> {
  const wait = at - now();
  if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
