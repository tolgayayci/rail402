/**
 * Funding a fresh testnet wallet, step by step, each a real transaction: Friendbot creates the account
 * with XLM, the account adds a trustline for the policy asset, then buys a little of it with XLM on the
 * testnet exchange (keeping XLM for reserves and fees). Steps already done are skipped, so funding can
 * resume after a failure; a top-up buys again even when the account already holds some. The key signs only the onboarding envelopes the SDK's `account` module builds.
 */
import { Asset, type rpc } from "@stellar/stellar-sdk";
import { AssetDirectory } from "@rail402.dev/stellar";
import {
  accountState,
  addTrustline,
  buyAsset,
  fundWithFriendbot,
  keySetupSigner,
  paymentError,
  toAtomic,
  type AccountChain,
  type KeyHolder,
} from "@rail402.dev/sdk/browser";

export type OnboardingStep = "friendbot" | "trustline" | "bought";

export interface OnboardingOptions {
  readonly server: rpc.Server;
  readonly passphrase: string;
  readonly friendbotUrl: string;
  readonly fetch?: typeof fetch;
  /** The policy asset: its contract and the classic asset behind it. */
  readonly asset: { readonly contract: string; readonly code: string; readonly issuer: string };
  /** How much of the asset to buy, decimal. */
  readonly buyAmount: string;
  /** XLM kept back for reserves and fees, decimal. */
  readonly keepXlm: string;
  /** Buy the asset even when the account already holds some. */
  readonly topUp?: boolean;
  readonly signal?: AbortSignal;
  /** Called after each step that ran, with its transaction hash when it has one. */
  readonly onStep: (step: OnboardingStep, transaction?: string) => void;
  /** Waits between account reads after Friendbot; tests pass a no-op. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** How far an account's setup got. */
export interface SetupStatus {
  readonly account: boolean;
  readonly trustline: boolean;
  readonly funded: boolean;
}

const ACCOUNT_POLLS = 10;
const ACCOUNT_POLL_MS = 1_000;

/** Reads how far `address` got: account, trustline, and a non-zero balance of the asset. */
export async function setupStatus(
  chain: AccountChain,
  contract: string,
  address: string,
): Promise<SetupStatus> {
  const state = await accountState(chain, address);
  if (!state.exists) return { account: false, trustline: false, funded: false };
  const funds = await new AssetDirectory(chain.server, chain.passphrase).funds(contract, address);
  return {
    account: true,
    trustline: funds?.trustline === true,
    funded: funds !== undefined && funds.balance > 0n,
  };
}

/** The chain operations onboarding uses; tests replace them. */
export interface OnboardingOperations {
  readonly status: (chain: AccountChain, contract: string, address: string) => Promise<SetupStatus>;
  readonly friendbot: typeof fundWithFriendbot;
  readonly trustline: typeof addTrustline;
  readonly buy: typeof buyAsset;
}

export const CHAIN_OPERATIONS: OnboardingOperations = {
  status: setupStatus,
  friendbot: fundWithFriendbot,
  trustline: addTrustline,
  buy: buyAsset,
};

/** Runs the steps not done yet. Rejects with the step's `account_*` code when one fails. */
export async function fundAccount(
  key: KeyHolder,
  options: OnboardingOptions,
  operations: OnboardingOperations = CHAIN_OPERATIONS,
): Promise<void> {
  const chain: AccountChain = { server: options.server, passphrase: options.passphrase };
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const address = key.address;
  let status = await operations.status(chain, options.asset.contract, address);
  if (!status.account) {
    const funding = await operations.friendbot(
      {
        friendbotUrl: options.friendbotUrl,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      address,
    );
    options.onStep("friendbot", funding);
    for (let attempt = 0; attempt < ACCOUNT_POLLS && !status.account; attempt++) {
      if (attempt > 0) await sleep(ACCOUNT_POLL_MS);
      status = await operations.status(chain, options.asset.contract, address);
    }
    if (!status.account) {
      throw paymentError("account_friendbot_failed", {
        reason: "Friendbot answered, but the account did not appear on the network.",
      });
    }
  }
  const asset = new Asset(options.asset.code, options.asset.issuer);
  const signer = keySetupSigner(key, options.passphrase, { asset, maxBuy: options.buyAmount });
  if (!status.trustline) {
    options.onStep("trustline", await operations.trustline(chain, signer, asset));
  }
  if (!status.funded || options.topUp === true) {
    const keep = toAtomic(options.keepXlm, 7);
    options.onStep(
      "bought",
      await operations.buy(chain, signer, {
        asset,
        amount: options.buyAmount,
        ...(keep === undefined ? {} : { keep }),
      }),
    );
  }
}
