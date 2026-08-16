import { Horizon } from "@stellar/stellar-sdk";
import { createError, type ErrorCode } from "@rail402.dev/errors";
import {
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
} from "@x402/stellar";

/**
 * Seller preflight.
 *
 * The single most common way a Stellar seller's first payment fails is a **missing trustline on the
 * seller's own account**. It is invisible until a real buyer tries to pay, at which point the buyer
 * sees a failure that is not their fault and the seller has no idea why.
 *
 * Onboarding and examples have to account for trustlines. This
 * turns a runtime failure into a startup check: run it when the resource server boots and a
 * misconfigured seller learns immediately, in their own logs, instead of losing a customer.
 *
 * Every finding carries a machine-readable code and a non-null, actionable reason — the same
 * discipline the facilitator applies to rejections.
 */

export interface PreflightConfig {
  /** Where payments are sent — the seller's account. */
  payTo: string;
  /** SEP-41 token contract (`C…`). Classic assets are out of scope for the exact scheme. */
  asset: string;
  /** Only `stellar:testnet` is checked; pubnet checking is intentionally not offered here. */
  network?: string;
  /** Override for a custom Horizon instance. */
  horizonUrl?: string;
}

export interface PreflightFinding {
  code: ErrorCode;
  reason: string;
  severity: "error" | "warning";
}

export interface PreflightResult {
  ok: boolean;
  findings: PreflightFinding[];
}

const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

/**
 * Check a seller's configuration against the live network before accepting payments.
 *
 * Network problems produce a **warning**, never an error: a transient Horizon outage must not stop
 * a seller's server from booting. Only genuine misconfiguration is an error.
 *
 * @returns `ok: false` when at least one error-severity finding is present.
 */
export async function preflight(config: PreflightConfig): Promise<PreflightResult> {
  const findings: PreflightFinding[] = [];
  const add = (code: ErrorCode, reason: string, severity: "error" | "warning" = "error") =>
    findings.push({ code, reason, severity });

  // ── Static checks: wrong before we even ask the network ──────────────────
  if (!validateStellarDestinationAddress(config.payTo)) {
    add(
      "invalid_payment_requirements",
      `payTo "${config.payTo}" is not a valid Stellar address. Expected a G-account, C-account, or muxed M-account.`,
    );
  }
  if (!validateStellarAssetAddress(config.asset)) {
    add(
      "invalid_payment_requirements",
      `asset "${config.asset}" is not a valid Soroban token contract address (C…). The exact scheme ` +
        `covers SEP-41 Soroban tokens only — classic Stellar assets are not supported, and a classic ` +
        `asset code like "USDC:G…" will not work here.`,
    );
  }

  // Anything below needs a well-formed address to be meaningful.
  if (findings.some(f => f.severity === "error")) return { ok: false, findings };

  // ── Live checks ──────────────────────────────────────────────────────────
  const horizon = new Horizon.Server(config.horizonUrl ?? TESTNET_HORIZON);

  let account: Awaited<ReturnType<typeof horizon.loadAccount>>;
  try {
    account = await horizon.loadAccount(config.payTo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      add(
        "invalid_exact_stellar_payload_missing_trustline_recipient",
        `The payTo account ${config.payTo} does not exist on the network. Create and fund it before ` +
          `accepting payments — on testnet, use friendbot.`,
      );
    } else {
      add(
        "unexpected_verify_error",
        `Could not reach Horizon to check the payTo account: ${message}. This is a connectivity ` +
          `problem, not necessarily a misconfiguration — the check was skipped.`,
        "warning",
      );
    }
    return { ok: !findings.some(f => f.severity === "error"), findings };
  }

  // The check that actually matters.
  //
  // A Soroban token contract wraps a classic asset, and the seller needs a trustline to that
  // underlying asset to receive it. Horizon exposes trustlines by (code, issuer), not by contract
  // address, so we cannot map contract -> asset here without a Soroban call. What we CAN say with
  // certainty is that an account holding no non-native trustlines at all cannot receive any SEP-41
  // token — which is exactly the case a first-time seller lands in.
  const nonNative = account.balances.filter(b => b.asset_type !== "native");
  if (nonNative.length === 0) {
    add(
      "invalid_exact_stellar_payload_missing_trustline_recipient",
      `The payTo account ${config.payTo} holds no asset trustlines, so it cannot receive any SEP-41 ` +
        `token — every payment to it will fail. Add a trustline for the asset you are pricing in ` +
        `(Stellar Lab -> Fund Account -> Add Trustline), then re-run this check. This is the single ` +
        `most common cause of a seller's first payment failing, and buyers cannot diagnose it.`,
    );
  } else {
    add(
      "invalid_exact_stellar_payload_missing_trustline_recipient",
      `Confirm the payTo account trusts the asset behind contract ${config.asset}. It currently trusts: ` +
        `${nonNative.map(b => ("asset_code" in b ? b.asset_code : "?")).join(", ")}. Mapping a Soroban ` +
        `contract to its underlying classic asset requires a network call, so this cannot be verified ` +
        `statically — if the asset you are pricing in is not in that list, payments will fail.`,
      "warning",
    );
  }

  return { ok: !findings.some(f => f.severity === "error"), findings };
}

/**
 * Run preflight and print the result. Intended for a resource server's boot sequence.
 *
 * Does **not** throw or exit by default: a seller with an existing working deployment should not
 * have it refuse to start because Horizon was briefly unreachable. Pass `throwOnError` when you
 * would rather fail loudly.
 */
export async function preflightAndReport(
  config: PreflightConfig,
  options: { throwOnError?: boolean } = {},
): Promise<PreflightResult> {
  const result = await preflight(config);

  if (result.findings.length === 0) {
    console.log("[x402 preflight] seller configuration looks good");
    return result;
  }
  for (const f of result.findings) {
    console[f.severity === "error" ? "error" : "warn"](
      `[x402 preflight] ${f.severity.toUpperCase()} ${f.code}\n  ${f.reason}`,
    );
  }
  if (!result.ok && options.throwOnError) {
    throw new Error("x402 seller preflight failed; see the findings above.");
  }
  return result;
}

export { createError };
