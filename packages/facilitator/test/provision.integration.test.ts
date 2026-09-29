/**
 * Channel account lifecycle against the private Stellar network (docker compose --profile stellar up -d).
 */
import { describe, expect, it } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  deriveChannelKeypairs,
  existingAccounts,
  provisionChannels,
  retireChannels,
} from "@rail402.dev/facilitator";
import { LocalNetwork } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

/** How many reserves the account sponsors, from its ledger entry. */
async function numSponsoring(address: string): Promise<number> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
  const { entries } = await net.server.getLedgerEntries(key);
  const ext = entries[0]?.val.account().ext();
  if (ext?.switch() !== 1) return 0;
  const v1 = ext.v1().ext();
  return v1.switch() === 2 ? v1.v2().numSponsoring() : 0;
}

describe.skipIf(!available)("channel accounts", () => {
  it("provisions channels in batches within the signature limit, then retires them all", async () => {
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const channels = deriveChannelKeypairs(sponsor, "stellar:testnet", 21);
    const addresses = channels.map((keypair) => keypair.publicKey());
    const options = { server: net.server, passphrase: net.passphrase, sponsor, channels };

    expect((await provisionChannels(options)).created).toHaveLength(21);
    expect((await existingAccounts(net.server, addresses)).size).toBe(21);
    // An account entry takes two base reserves.
    expect(await numSponsoring(sponsor.publicKey())).toBe(2 * 21);
    expect((await provisionChannels(options)).created).toEqual([]);

    expect((await retireChannels(options)).retired).toHaveLength(21);
    expect((await existingAccounts(net.server, addresses)).size).toBe(0);
    expect(await retireChannels(options)).toMatchObject({ retired: [], absent: addresses });
    expect(await numSponsoring(sponsor.publicKey())).toBe(0);
  }, 120_000);
});
