import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { decimalToStroops } from "../shared/amounts.js";

/**
 * Browser-side session: a wallet that is generated in this tab, funded, and never leaves the
 * machine. Every step narrates itself through `onStep` so the UI can turn real latency (friendbot,
 * ledger settle) into the loading state — the design's "narrate, never spin" rule.
 *
 * Nothing here is node-specific: `Keypair`, `TransactionBuilder`, and `Horizon.Server` all run in
 * the browser (they use `fetch` and the `buffer` polyfill), and friendbot / Horizon / the dispenser
 * all serve open CORS.
 */

export interface SessionConfig {
  readonly network: string;
  readonly facilitatorUrl: string;
  readonly horizonUrl: string;
  readonly friendbotUrl: string;
  readonly usdc: { readonly code: string; readonly issuer: string; readonly sac: string };
  readonly playgroundUrl: string;
}

export type BootstrapPhase =
  | "generating"
  | "funding"
  | "trustline"
  | "dispensing"
  | "ready";

export interface BootstrapStep {
  readonly phase: BootstrapPhase;
  /** Human-legible narration for this step. The UI may use it verbatim. */
  readonly message: string;
}

export interface Balances {
  /** USDC balance in stroops (7-decimal integer). "-1" means no trustline yet. */
  readonly usdcStroops: string;
  /** XLM balance in stroops. In the playground this stays effectively at the reserve — the point. */
  readonly xlmStroops: string;
}

export interface Session {
  readonly address: string;
  /** The secret, for the "continue in your terminal" export ONLY. Never sent anywhere. */
  readonly secret: string;
}

const STEP_MESSAGES: Record<BootstrapPhase, string> = {
  generating: "Generating a wallet — the key is created here and stays in your browser.",
  funding: "Funding the account with test XLM from friendbot…",
  trustline: "Establishing a USDC trustline so the account can hold it…",
  dispensing: "Requesting test USDC from the playground dispenser…",
  ready: "Ready. This wallet holds no XLM you paid for — network fees are sponsored.",
};

/** Create a fresh session keypair. Pure and instant; funding is a separate, narrated step. */
export function createSession(): Session {
  const kp = Keypair.random();
  return { address: kp.publicKey(), secret: kp.secret() };
}

/**
 * Bring a session to life: fund with friendbot, add the USDC trustline, drip USDC from the
 * dispenser. Idempotent-ish — safe to re-run if a step failed, because each step checks the ledger
 * state it needs before acting.
 */
export async function bootstrapSession(
  session: Session,
  config: SessionConfig,
  onStep: (step: BootstrapStep) => void = () => {},
): Promise<void> {
  const horizon = new Horizon.Server(config.horizonUrl);
  const kp = Keypair.fromSecret(session.secret);

  const emit = (phase: BootstrapPhase) => onStep({ phase, message: STEP_MESSAGES[phase] });

  emit("generating");

  const exists = await accountExists(horizon, session.address);
  if (!exists) {
    emit("funding");
    const res = await fetch(`${config.friendbotUrl}/?addr=${encodeURIComponent(session.address)}`);
    if (!res.ok && res.status !== 400) {
      throw new Error(`Friendbot funding failed (${res.status}). Testnet may be busy — retry.`);
    }
    await waitForAccount(horizon, session.address);
  }

  if (!(await hasTrustline(horizon, session.address, config.usdc))) {
    emit("trustline");
    await establishTrustline(horizon, kp, config);
  }

  emit("dispensing");
  const drip = await fetch(`${config.playgroundUrl}/session/fund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: session.address }),
  });
  if (!drip.ok) {
    const body = (await drip.json().catch(() => ({}))) as { reason?: string };
    // "Already funded" is a success from the user's point of view: they have USDC.
    if (drip.status !== 409) {
      throw new Error(body.reason ?? `Dispenser refused funding (${drip.status}).`);
    }
  }

  emit("ready");
}

/** Poll balances. The UI calls this on an interval to watch USDC tick down as payments happen. */
export async function fetchBalances(session: Session, config: SessionConfig): Promise<Balances> {
  const horizon = new Horizon.Server(config.horizonUrl);
  try {
    const account = await horizon.loadAccount(session.address);
    let usdcStroops = "-1";
    let xlmStroops = "0";
    for (const b of account.balances) {
      if (b.asset_type === "native") xlmStroops = decimalToStroops(b.balance).toString();
      else if (
        "asset_code" in b &&
        b.asset_code === config.usdc.code &&
        b.asset_issuer === config.usdc.issuer
      ) {
        usdcStroops = decimalToStroops(b.balance).toString();
      }
    }
    return { usdcStroops, xlmStroops };
  } catch {
    return { usdcStroops: "-1", xlmStroops: "0" };
  }
}

async function accountExists(horizon: Horizon.Server, address: string): Promise<boolean> {
  try {
    await horizon.loadAccount(address);
    return true;
  } catch {
    return false;
  }
}

async function waitForAccount(horizon: Horizon.Server, address: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await accountExists(horizon, address)) return;
    await sleep(1000);
  }
  throw new Error("Account did not appear on the ledger after funding. Testnet indexing lag — retry.");
}

async function hasTrustline(
  horizon: Horizon.Server,
  address: string,
  usdc: SessionConfig["usdc"],
): Promise<boolean> {
  try {
    const account = await horizon.loadAccount(address);
    return account.balances.some(
      b => "asset_code" in b && b.asset_code === usdc.code && b.asset_issuer === usdc.issuer,
    );
  } catch {
    return false;
  }
}

async function establishTrustline(
  horizon: Horizon.Server,
  kp: Keypair,
  config: SessionConfig,
): Promise<void> {
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphraseFor(config.network),
  })
    .addOperation(
      Operation.changeTrust({ asset: new Asset(config.usdc.code, config.usdc.issuer) }),
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

function passphraseFor(network: string): string {
  if (network === "stellar:testnet") return Networks.TESTNET;
  throw new Error(`The playground is testnet-only; got ${network}.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
