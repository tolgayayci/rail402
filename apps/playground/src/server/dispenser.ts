import { Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { Horizon } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402.dev/errors";
import type { PlaygroundConfig } from "./config.js";
import { NETWORK_PASSPHRASE } from "./config.js";
import { decimalToStroops, stroopsToDecimal } from "../shared/amounts.js";

/**
 * The USDC dispenser: the one thing the browser cannot do for itself.
 *
 * Friendbot mints XLM but testnet USDC comes only from Circle's captcha-gated faucet, which would
 * kill the one-click session bootstrap. So the playground operator pre-funds a dispenser wallet
 * and this module drips a fixed amount into fresh session accounts. Demo payments flow back to
 * the dispenser's own account by default (`config.payTo`), which keeps the loop roughly
 * self-sustaining.
 *
 * Refusal order is deliberate: the checks a caller can fix (account missing, trustline missing)
 * come before the ones they cannot (dispenser empty), so the coded error always names the next
 * action the browser should take.
 */

/** The narrow slice of Horizon the dispenser touches, injectable for tests. */
export interface HorizonGateway {
  /** Resolve an account's balances, or null if the account does not exist. */
  getBalances(accountId: string): Promise<readonly BalanceLine[] | null>;
  /** Submit a classic USDC payment signed by the dispenser. Returns the transaction hash. */
  submitPayment(input: {
    readonly from: Keypair;
    readonly to: string;
    readonly asset: { readonly code: string; readonly issuer: string };
    readonly amountStroops: bigint;
  }): Promise<{ readonly hash: string }>;
}

export interface BalanceLine {
  readonly assetCode?: string | undefined;
  readonly assetIssuer?: string | undefined;
  readonly balance: string;
  readonly native: boolean;
}

export function createHorizonGateway(horizonUrl: string): HorizonGateway {
  const horizon = new Horizon.Server(horizonUrl);
  return {
    async getBalances(accountId) {
      try {
        const account = await horizon.loadAccount(accountId);
        return account.balances.map(b => ({
          assetCode: "asset_code" in b ? b.asset_code : undefined,
          assetIssuer: "asset_issuer" in b ? b.asset_issuer : undefined,
          balance: b.balance,
          native: b.asset_type === "native",
        }));
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async submitPayment({ from, to, asset, amountStroops }) {
      const source = await horizon.loadAccount(from.publicKey());
      const tx = new TransactionBuilder(source, {
        fee: "1000000",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.payment({
            destination: to,
            asset: new Asset(asset.code, asset.issuer),
            amount: stroopsToDecimal(amountStroops),
          }),
        )
        .setTimeout(60)
        .build();
      tx.sign(from);
      const result = await horizon.submitTransaction(tx);
      return { hash: result.hash };
    },
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}

export interface DispenserDeps {
  readonly config: PlaygroundConfig;
  readonly horizon: HorizonGateway;
  readonly now?: () => number;
}

export interface DripResult {
  readonly hash: string;
  readonly amountStroops: bigint;
}

export function createDispenser({ config, horizon, now = Date.now }: DispenserDeps) {
  // Per-target-account fixed window, independent of the per-IP limit on the route: rotating IPs
  // must not turn one account into a USDC pump.
  const accountWindows = new Map<string, { count: number; resetAt: number }>();

  // Classic payments from one account must not race each other over the sequence number, so
  // submissions are chained single-file. Failures propagate to their own caller; `.catch` on the
  // chain link keeps one failed drip from poisoning every drip after it.
  let queue: Promise<unknown> = Promise.resolve();

  function checkAccountWindow(account: string): void {
    const bucket = accountWindows.get(account);
    const at = now();
    if (!bucket || at >= bucket.resetAt) {
      accountWindows.set(account, { count: 1, resetAt: at + config.rate.windowSeconds * 1000 });
      return;
    }
    if (bucket.count >= config.rate.maxPerAccount) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - at) / 1000);
      throw new X402Error("playground_dispenser_rate_limited", {
        reason: `This account was funded ${bucket.count} times in the current window. Retry in ${retryAfterSeconds}s.`,
        details: { retryAfterSeconds },
      });
    }
    bucket.count += 1;
  }

  function usdcBalance(balances: readonly BalanceLine[]): bigint {
    const line = balances.find(
      b => b.assetCode === config.usdc.code && b.assetIssuer === config.usdc.issuer,
    );
    return line ? decimalToStroops(line.balance) : -1n;
  }

  async function fund(account: string): Promise<DripResult> {
    try {
      Keypair.fromPublicKey(account);
    } catch {
      throw new X402Error("playground_invalid_request", {
        reason: `"${account}" is not a valid Stellar public key. Expected a G… address.`,
      });
    }

    checkAccountWindow(account);

    const balances = await horizon.getBalances(account);
    if (balances === null) {
      throw new X402Error("playground_dispenser_account_not_found", {
        details: { account },
      });
    }

    const held = usdcBalance(balances);
    if (held < 0n) {
      throw new X402Error("playground_dispenser_trustline_missing", {
        details: { account, asset: { code: config.usdc.code, issuer: config.usdc.issuer } },
      });
    }
    if (held >= config.dripStroops) {
      throw new X402Error("playground_dispenser_already_funded", {
        details: { account, balanceStroops: held.toString() },
      });
    }

    const dispenserBalances = await horizon.getBalances(config.dispenser.publicKey());
    const reserve = dispenserBalances === null ? -1n : usdcBalance(dispenserBalances);
    if (reserve < config.dripStroops) {
      throw new X402Error("playground_dispenser_exhausted", {
        details: { neededStroops: config.dripStroops.toString() },
      });
    }

    const submission = queue.then(() =>
      horizon.submitPayment({
        from: config.dispenser,
        to: account,
        asset: config.usdc,
        amountStroops: config.dripStroops,
      }),
    );
    queue = submission.catch(() => undefined);

    try {
      const { hash } = await submission;
      return { hash, amountStroops: config.dripStroops };
    } catch (err) {
      throw new X402Error("playground_dispenser_failed", {
        details: { cause: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return { fund };
}
