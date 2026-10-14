import { hkdfSync } from "node:crypto";
import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import { provisionChannels } from "./provision.ts";

const AUTHORITY_SALT = "rail402/upto-authority";

/**
 * The `upto` settlement authority of a network. Every `upto` payment names it in the terms the payer
 * signs (`extra.facilitatorAddress`), and only it can choose the amount settled: the settlement
 * transaction uses it as the operation source, and its `SOURCE_ACCOUNT` authorization covers
 * `settle(payer, terms, amount)`.
 *
 * The key is derived from the sponsor's secret (HKDF-SHA256, salt `rail402/upto-authority`, info the
 * CAIP-2 network), so every replica with the same sponsor shares it and it is never stored. The
 * account holds no funds: it is created with a zero balance and a sponsored reserve, like a channel,
 * and never pays or receives anything. It rotates with the sponsor; the old authority must stay
 * available until every authorization naming it has expired.
 */
export function deriveAuthorityKeypair(sponsor: Keypair, network: string): Keypair {
  if (network === "") throw new RangeError("network must be a CAIP-2 identifier");
  const seed = hkdfSync("sha256", sponsor.rawSecretKey(), AUTHORITY_SALT, network, 32);
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

export interface AuthorityProvisionOptions {
  readonly server: rpc.Server;
  readonly passphrase: string;
  readonly sponsor: Keypair;
  readonly authority: Keypair;
}

/**
 * Creates the authority account if it is missing: zero balance, base reserve sponsored by the
 * sponsor (CAP-33). Idempotent. Returns whether the account was created now.
 */
export async function provisionAuthority(options: AuthorityProvisionOptions): Promise<boolean> {
  const result = await provisionChannels({
    server: options.server,
    passphrase: options.passphrase,
    sponsor: options.sponsor,
    channels: [options.authority],
  });
  return result.created.length > 0;
}

export interface AuthorityStatus {
  readonly address: string;
  readonly exists: boolean;
  /**
   * Native balance in stroops. A provisioned authority holds zero: an account can exist with a zero
   * balance only while another account sponsors its reserve.
   */
  readonly balanceStroops: bigint;
  /**
   * The part of the native balance the account could spend: what it holds beyond the minimum balance
   * its own (unsponsored) reserves and selling liabilities lock. Zero for a provisioned authority.
   */
  readonly spendableStroops: bigint;
}

/**
 * The base reserve of both public networks, in stroops (0.5 XLM). It is a network setting that only a
 * validator vote changes; a higher reserve would make `spendableStroops` understate, never overstate.
 */
const BASE_RESERVE_STROOPS = 5_000_000n;

/**
 * Reads the authority account. An authority that can spend XLM can pay for things the operator never
 * intended, so operators alert on `spendableStroops > 0`.
 */
export async function authorityStatus(server: rpc.Server, address: string): Promise<AuthorityStatus> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  if (entry === undefined) {
    return { address, exists: false, balanceStroops: 0n, spendableStroops: 0n };
  }
  const account = entry.val.account();
  const balanceStroops = account.balance().toBigInt();
  const locked = minimumBalance(account) + sellingLiabilities(account);
  return {
    address,
    exists: true,
    balanceStroops,
    spendableStroops: balanceStroops > locked ? balanceStroops - locked : 0n,
  };
}

/** `(2 + subentries + sponsoring − sponsored) × base reserve`, the protocol's minimum balance. */
function minimumBalance(account: xdr.AccountEntry): bigint {
  let sponsoring = 0n;
  let sponsored = 0n;
  const ext = account.ext();
  if (ext.switch() === 1) {
    const v1 = ext.v1().ext();
    if (v1.switch() === 2) {
      sponsoring = BigInt(v1.v2().numSponsoring());
      sponsored = BigInt(v1.v2().numSponsored());
    }
  }
  const reserves = 2n + BigInt(account.numSubEntries()) + sponsoring - sponsored;
  return reserves > 0n ? reserves * BASE_RESERVE_STROOPS : 0n;
}

function sellingLiabilities(account: xdr.AccountEntry): bigint {
  const ext = account.ext();
  return ext.switch() === 1 ? ext.v1().liabilities().selling().toBigInt() : 0n;
}
