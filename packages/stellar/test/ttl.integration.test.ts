/**
 * Contract TTLs read from the private Stellar network (docker compose --profile stellar up -d): a real
 * Stellar Asset Contract, and a WASM contract whose instance TTL is extended by a real transaction.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { BASE_FEE, Keypair, Operation, SorobanDataBuilder, TransactionBuilder } from "@stellar/stellar-sdk";
import { contractInstanceKey, readContractTtl } from "@rail402.dev/stellar";
import { LocalNetwork, deploySimpleAccount, randomContractId, type IssuedAsset } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("readContractTtl", () => {
  let usdc: IssuedAsset;
  let deployer: Keypair;
  let account: string;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    deployer = Keypair.random();
    await net.fund(deployer);
    account = await deploySimpleAccount(net, deployer, Keypair.random());
  });

  it("reads a Stellar Asset Contract's instance, which has no code entry", async () => {
    const reading = await readContractTtl(net.server, [usdc.sac]);
    const ttl = reading.contracts.get(usdc.sac);
    expect(ttl).toMatchObject({ contract: usdc.sac, kind: "stellar_asset" });
    expect(ttl?.codeLiveUntil).toBeUndefined();
    expect(ttl?.wasmHash).toBeUndefined();
    expect(ttl?.instanceLiveUntil).toBeGreaterThan(reading.latestLedger);
  });

  it("reads a WASM contract's instance and code, and sees an extension land", async () => {
    const before = await readContractTtl(net.server, [account, usdc.sac, account]);
    const ttl = before.contracts.get(account);
    expect(before.contracts.size).toBe(2);
    expect(ttl?.kind).toBe("wasm");
    expect(ttl?.wasmHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ttl?.codeLiveUntil).toBeGreaterThan(before.latestLedger);

    // Extend the instance well past its current TTL; the reader must report exactly the new bound.
    const extendTo = (ttl?.instanceLiveUntil ?? 0) - before.latestLedger + 5_000;
    const source = await net.server.getAccount(deployer.publicKey());
    const transaction = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(Operation.extendFootprintTtl({ extendTo }))
      .setSorobanData(new SorobanDataBuilder().setReadOnly([contractInstanceKey(account)]).build())
      .setTimeout(30)
      .build();
    const prepared = await net.server.prepareTransaction(transaction);
    prepared.sign(deployer);
    const included = await net.submit(prepared);

    const after = await readContractTtl(net.server, [account]);
    expect(after.contracts.get(account)?.instanceLiveUntil).toBe(included.ledger + extendTo);
    expect(after.contracts.get(account)?.codeLiveUntil).toBe(ttl?.codeLiveUntil);
  });

  it("maps a contract that does not exist to undefined", async () => {
    const missing = randomContractId();
    const reading = await readContractTtl(net.server, [missing, usdc.sac]);
    expect(reading.contracts.get(missing)).toBeUndefined();
    expect(reading.contracts.has(missing)).toBe(true);
    expect(reading.contracts.get(usdc.sac)?.kind).toBe("stellar_asset");
  });
});
