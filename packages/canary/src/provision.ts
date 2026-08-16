import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { X402Error } from "@rail402.dev/errors";
import { HORIZON_URL, NETWORK_PASSPHRASE } from "./testnet.js";

/**
 * Provision the accounts the **upstream** e2e suite needs.
 *
 * The suite pays in USDC, which cannot be conjured: friendbot mints XLM, and testnet USDC comes
 * from Circle's faucet, one captcha at a time. So this command does everything that can be
 * automated — keypairs, XLM funding, trustlines — and then tells a human exactly which address to
 * send USDC to and how to check it arrived.
 *
 * Idempotent on purpose. Run it, send the USDC, run it again to confirm: it never re-funds an
 * existing account and never re-establishes an existing trustline.
 */

const horizon = new Horizon.Server(HORIZON_URL);

/**
 * The USDC issuer, **verified rather than remembered**.
 *
 * `@x402/stellar` publishes only the Stellar Asset Contract address, but a trustline needs the
 * classic `code:issuer` pair, and those two are related by a one-way hash — you cannot read the
 * issuer out of the contract id. The hint below is checked by recomputing the contract id from it;
 * if the check fails we walk Horizon's asset list rather than proceeding on a stale constant.
 * Hard-coding an unverified issuer is how a test suite ends up paying in a lookalike token.
 */
const ISSUER_HINT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const sacFor = (issuer: string): string =>
  new Asset("USDC", issuer).contractId(NETWORK_PASSPHRASE);

export async function resolveUsdcIssuer(log: (line: string) => void): Promise<string> {
  if (sacFor(ISSUER_HINT) === USDC_TESTNET_ADDRESS) {
    log(`usdc issuer  ${ISSUER_HINT} (verified against @x402/stellar's contract address)`);
    return ISSUER_HINT;
  }

  log("usdc issuer hint no longer matches @x402/stellar; scanning Horizon");
  let url: string | undefined = `${HORIZON_URL}/assets?asset_code=USDC&limit=200`;
  let scanned = 0;
  for (let page = 0; url && page < 30; page++) {
    const body = (await (await fetch(url)).json()) as {
      _embedded: { records: { asset_issuer: string }[] };
      _links: { next?: { href: string } };
    };
    const records = body._embedded.records;
    if (records.length === 0) break;
    scanned += records.length;
    for (const record of records) {
      if (sacFor(record.asset_issuer) === USDC_TESTNET_ADDRESS) {
        log(`usdc issuer  ${record.asset_issuer} (found after scanning ${scanned})`);
        return record.asset_issuer;
      }
    }
    url = body._links.next?.href;
  }

  throw new X402Error("canary_setup_failed", {
    reason: `No USDC issuer on testnet produces the contract address ${USDC_TESTNET_ADDRESS} that @x402/stellar expects, after scanning ${scanned} issuers. Do not guess one — the suite would pay in a lookalike token.`,
  });
}

interface AccountState {
  readonly address: string;
  readonly exists: boolean;
  readonly hasTrustline: boolean;
  readonly usdcBalance: string;
}

async function inspect(address: string, issuer: string): Promise<AccountState> {
  try {
    const account = await horizon.loadAccount(address);
    const line = account.balances.find(
      b => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === issuer,
    );
    return {
      address,
      exists: true,
      hasTrustline: line !== undefined,
      usdcBalance: line && "balance" in line ? line.balance : "0",
    };
  } catch {
    return { address, exists: false, hasTrustline: false, usdcBalance: "0" };
  }
}

async function fund(address: string): Promise<void> {
  const response = await fetch(`${HORIZON_URL}/friendbot?addr=${address}`);
  if (!response.ok) {
    throw new X402Error("canary_setup_failed", {
      reason: `Friendbot refused to fund ${address} (HTTP ${response.status}).`,
    });
  }
}

async function trust(kp: Keypair, asset: Asset): Promise<void> {
  const account = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
}

/**
 * Where provisioned secrets are written.
 *
 * Gitignored, and it has to exist. Previously these were printed to a terminal and nowhere else,
 * so the moment that scrollback was gone the funded account was unusable — nobody could sign with
 * it, CI could not reach it, and its public key was not recorded anywhere either. A human then
 * spent real faucet effort on an account that became unrecoverable within the hour
 * Testnet secrets are worth nothing; losing the account they control
 * still costs a captcha and a wait.
 */
const ENV_FILE = ".env.testnet";

/** Read back a previously provisioned payer/seller, so a re-run reuses the funded account. */
export function readProvisioned(root: string): { payer?: string; seller?: string } {
  const path = resolve(root, ENV_FILE);
  if (!existsSync(path)) return {};
  const out: { payer?: string; seller?: string } = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [key, value] = line.split("=");
    if (!key || !value) continue;
    if (key.trim() === "CLIENT_STELLAR_PRIVATE_KEY") out.payer = value.trim();
    if (key.trim() === "SERVER_STELLAR_SECRET") out.seller = value.trim();
  }
  return out;
}

function persist(root: string, payer: Keypair, seller: Keypair, log: (l: string) => void): string {
  const path = resolve(root, ENV_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      "# Provisioned by `pnpm canary provision-usdc`. GITIGNORED — never commit this.",
      "# Testnet only; these hold no real value. Persisted because the accounts behind them cost a",
      "# faucet captcha to fund, and printing a secret to a terminal is not storage.",
      "#",
      "#   export $(grep -v '^#' .env.testnet | xargs)   # then: pnpm conformance dual",
      "",
      `CLIENT_STELLAR_PRIVATE_KEY=${payer.secret()}`,
      `SERVER_STELLAR_ADDRESS=${seller.publicKey()}`,
      `SERVER_STELLAR_SECRET=${seller.secret()}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  log(`wrote ${ENV_FILE} (mode 600) — the payer secret now survives this terminal`);
  return path;
}

export interface ProvisionOptions {
  /** Reuse an existing payer instead of generating one. The suite needs its secret. */
  readonly payerSecret?: string | undefined;
  readonly sellerSecret?: string | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Repository root, where `.env.testnet` is written. */
  readonly root?: string | undefined;
}

export async function provisionUsdcAccounts(options: ProvisionOptions = {}): Promise<number> {
  const log = options.log ?? (line => console.log(line));

  const issuer = await resolveUsdcIssuer(log);
  const asset = new Asset("USDC", issuer);

  // Reuse whatever was provisioned before unless told otherwise. Generating a fresh payer on every
  // run is how a funded account gets abandoned.
  const root = options.root ?? process.cwd();
  const saved = readProvisioned(root);
  const payerSecret = options.payerSecret ?? saved.payer;
  const sellerSecret = options.sellerSecret ?? saved.seller;
  if (!options.payerSecret && saved.payer) {
    log(`reusing the payer from ${ENV_FILE}; pass --payer to override`);
  }

  const payer = payerSecret ? Keypair.fromSecret(payerSecret) : Keypair.random();
  const seller = sellerSecret ? Keypair.fromSecret(sellerSecret) : Keypair.random();
  persist(root, payer, seller, log);
  log("");

  for (const [role, kp] of [
    ["payer ", payer],
    ["seller", seller],
  ] as const) {
    let state = await inspect(kp.publicKey(), issuer);
    if (!state.exists) {
      log(`${role}  ${kp.publicKey()}  funding from friendbot`);
      await fund(kp.publicKey());
      state = await inspect(kp.publicKey(), issuer);
    }
    if (!state.hasTrustline) {
      // The SELLER's trustline is the one people forget. Without it the suite fails at settlement
      // with what looks like a facilitator bug, and is in fact a seller misconfiguration — our
      // facilitator reports it as its own distinct error code for exactly that reason.
      log(`${role}  ${kp.publicKey()}  establishing USDC trustline`);
      await trust(kp, asset);
      state = await inspect(kp.publicKey(), issuer);
    }
    log(
      `${role}  ${kp.publicKey()}  trustline ${state.hasTrustline ? "yes" : "NO"}  usdc ${state.usdcBalance}`,
    );
  }

  const payerState = await inspect(payer.publicKey(), issuer);

  log("");
  log("─".repeat(78));
  if (Number(payerState.usdcBalance) > 0) {
    log("READY. The payer holds USDC; the upstream suite can run.");
    log("");
    log("  export X402_STELLAR_FACILITATOR_URL=<your facilitator>");
    log(`  export $(grep -v '^#' ${ENV_FILE} | xargs)`);
    log("");
    log("  pnpm conformance dual");
  } else {
    log("WAITING ON USDC. Everything else is done.");
    log("");
    log("  Send testnet USDC to the PAYER address:");
    log("");
    log(`      ${payer.publicKey()}`);
    log("");
    log("  Source: https://faucet.circle.com  — pick network 'Stellar' (testnet).");
    log("  10 USDC is far more than enough; the suite pays fractions of a cent per test.");
    log("");
    log("  Then re-run this command with the same payer to confirm it landed:");
    log("");
    log(`      pnpm canary provision-usdc --payer ${payer.secret()} --seller ${seller.secret()}`);
  }
  log("─".repeat(78));
  log("");
  log(`Secrets are in ${ENV_FILE}, which is gitignored. Testnet-only and worth`);
  log("nothing, but the ACCOUNT is worth a faucet captcha, so do not lose it again.");
  log("For CI: store the payer secret as the repository secret CANARY_CLIENT_STELLAR_PRIVATE_KEY");
  log("and the seller address as the variable CANARY_SERVER_STELLAR_ADDRESS — what nightly.yml reads.");

  return Number(payerState.usdcBalance) > 0 ? 0 : 1;
}
