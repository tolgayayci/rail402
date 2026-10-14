import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Address, Networks, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import {
  UPTO_DEPLOYMENTS,
  UPTO_DEPLOYMENT_SALT_HEX,
  UPTO_TESTNET_DEPLOYMENT,
  resolveUptoContract,
} from "@rail402.dev/upto";
import { TEST6_TESTNET } from "@rail402.dev/testkit";

interface DeploymentRecord {
  contract: string;
  network: string;
  caip2: string;
  network_passphrase: string;
  contract_id: string;
  wasm_sha256: string;
  source_sha256: string;
  deployer: string;
  salt: string;
  salt_preimage: string;
  commit: string;
  transactions: Record<string, { tx: string; ledger: number } | null>;
  live_until_ledger: { instance: number; code: number };
}

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const RECORD = read("../../../contracts/stellar/deployments/testnet.json") as DeploymentRecord;
const TEST6_RECORD = read("../../../contracts/testing/deployments/test6-testnet.json") as DeploymentRecord & {
  constructor: { symbol: string; decimals: number };
};
const PROVENANCE = read("../../testkit/fixtures/x402_upto_stellar.provenance.json") as {
  wasm_sha256: string;
  source_sha256: string;
};

/** The address `deployer` creates with `salt` on the network: the host's `ContractIdPreimage::FromAddress`. */
function contractAddress(passphrase: string, deployer: string, saltHex: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(passphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt: Buffer.from(saltHex, "hex"),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

describe("testnet deployment", () => {
  it("matches its deployment record", () => {
    expect(RECORD).toMatchObject({ contract: "upto", network: "testnet", caip2: "stellar:testnet" });
    expect(RECORD.network_passphrase).toBe(Networks.TESTNET);
    expect(UPTO_TESTNET_DEPLOYMENT).toEqual({ address: RECORD.contract_id, wasmHash: RECORD.wasm_sha256 });
    expect(UPTO_DEPLOYMENTS["stellar:testnet"]).toBe(UPTO_TESTNET_DEPLOYMENT);
    expect(resolveUptoContract("stellar:testnet")).toBe(RECORD.contract_id);
  });

  it("runs the committed wasm", () => {
    expect(RECORD.wasm_sha256).toBe(PROVENANCE.wasm_sha256);
    expect(RECORD.source_sha256).toBe(PROVENANCE.source_sha256);
    expect(RECORD.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("sits at the address derived from the deployer and the canonical salt", () => {
    expect(RECORD.salt).toBe(UPTO_DEPLOYMENT_SALT_HEX);
    expect(hash(Buffer.from(RECORD.salt_preimage)).toString("hex")).toBe(RECORD.salt);
    expect(contractAddress(RECORD.network_passphrase, RECORD.deployer, RECORD.salt)).toBe(RECORD.contract_id);
    // A different deployer or network gives a different address.
    const other = contractAddress(Networks.PUBLIC, RECORD.deployer, RECORD.salt);
    expect(other).not.toBe(RECORD.contract_id);
  });

  it("records every deployment transaction and the extended TTL", () => {
    for (const step of ["upload", "deploy", "extend_instance", "extend_code"]) {
      expect(RECORD.transactions[step]?.tx, step).toMatch(/^[0-9a-f]{64}$/);
    }
    const deployed = RECORD.transactions["deploy"]?.ledger ?? Infinity;
    expect(RECORD.live_until_ledger.instance).toBeGreaterThan(deployed + 3_000_000);
    expect(RECORD.live_until_ledger.code).toBeGreaterThan(deployed + 3_000_000);
  });
});

describe("TEST6 testnet deployment", () => {
  it("matches its deployment record and the committed test token wasm", () => {
    const provenance = read("../../testkit/fixtures/test_token.provenance.json") as { wasm_sha256: string };
    expect(TEST6_RECORD).toMatchObject({ contract: "test-token", caip2: TEST6_TESTNET.network });
    expect(TEST6_RECORD.constructor).toMatchObject({
      symbol: TEST6_TESTNET.symbol,
      decimals: TEST6_TESTNET.decimals,
    });
    expect(TEST6_TESTNET.address).toBe(TEST6_RECORD.contract_id);
    expect(TEST6_TESTNET.wasmHash).toBe(TEST6_RECORD.wasm_sha256);
    expect(TEST6_RECORD.wasm_sha256).toBe(provenance.wasm_sha256);
    expect(hash(Buffer.from(TEST6_RECORD.salt_preimage)).toString("hex")).toBe(TEST6_RECORD.salt);
    expect(contractAddress(TEST6_RECORD.network_passphrase, TEST6_RECORD.deployer, TEST6_RECORD.salt)).toBe(
      TEST6_RECORD.contract_id,
    );
  });
});
