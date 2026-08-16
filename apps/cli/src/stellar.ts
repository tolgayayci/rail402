import { Keypair } from "@stellar/stellar-sdk";

/**
 * Thin Stellar helpers: generate a keypair, friendbot-fund a testnet account, and read balances
 * from Horizon. Deliberately small and dependency-light — the payment path itself lives in
 * @rail402.dev/agent-helpers, not here.
 */

const HORIZON = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
  "stellar:pubnet": "https://horizon.stellar.org",
} as const;

const FRIENDBOT = "https://friendbot.stellar.org";

export function horizonUrl(network: string): string | undefined {
  return (HORIZON as Record<string, string>)[network];
}

export function generateKeypair(): { publicKey: string; secret: string } {
  const kp = Keypair.random();
  return { publicKey: kp.publicKey(), secret: kp.secret() };
}

/** Derive the public address from a secret, throwing a clear error on a malformed seed. */
export function addressFromSecret(secret: string): string {
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    throw new Error("not a valid Stellar secret seed (expected an S… strkey)");
  }
}

export async function friendbotFund(
  publicKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${FRIENDBOT}/?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok && res.status !== 400) {
    // 400 typically means the account already exists — treat as already funded.
    const body = await res.text().catch(() => "");
    throw new Error(`friendbot returned ${res.status}: ${body.slice(0, 200)}`);
  }
}

export interface Balance {
  asset: string;
  balance: string;
}

/** Read balances from Horizon. Returns an empty array for an account that is not yet funded. */
export async function getBalances(
  publicKey: string,
  network: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Balance[]> {
  const base = horizonUrl(network);
  if (!base) throw new Error(`no Horizon endpoint configured for network "${network}"`);
  const res = await fetchImpl(`${base}/accounts/${encodeURIComponent(publicKey)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Horizon returned ${res.status} for account ${publicKey}`);
  const body = (await res.json()) as { balances?: Array<Record<string, string>> };
  return (body.balances ?? []).map(b => ({
    asset:
      b.asset_type === "native"
        ? "XLM"
        : `${b.asset_code ?? "?"}:${b.asset_issuer ?? "?"}`,
    balance: b.balance ?? "0",
  }));
}
