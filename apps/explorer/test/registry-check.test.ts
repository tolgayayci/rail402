import { describe, expect, it } from "vitest";
import type { contractWasmHash } from "@rail402.dev/ledger-source";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { checkHostedAccounts, checkUptoContracts } from "../src/registry-check.ts";

const live = process.env["RAIL402_LIVE_LEDGERS"] === "1";

describe("the upto registry check", () => {
  it("flags an entry whose on-chain WASM differs or cannot be read", async () => {
    const registry = REGISTRIES["stellar:testnet"];
    const [first, second] = registry.document.uptoContracts;
    const read: typeof contractWasmHash = (_rpc, contract) => {
      if (contract === first?.contract)
        return Promise.resolve({ contract, wasmSha256: first.wasmSha256, latestLedger: 1 });
      if (contract === second?.contract)
        return Promise.resolve({ contract, wasmSha256: "0".repeat(64), latestLedger: 1 });
      return Promise.reject(new Error("no contract instance"));
    };
    const results = await checkUptoContracts(registry, "https://rpc.example", read);
    expect(results.slice(0, 2).map((result) => result.ok)).toEqual([true, false]);
    const failing = await checkUptoContracts(registry, "https://rpc.example", () =>
      Promise.reject(new Error("down")),
    );
    expect(failing.every((result) => !result.ok && result.error === "down")).toBe(true);
  });

  it.skipIf(!live)("matches the chain for every testnet upto contract", { timeout: 60_000 }, async () => {
    const results = await checkUptoContracts(
      REGISTRIES["stellar:testnet"],
      "https://soroban-testnet.stellar.org",
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
  });
});

describe("the hosted accounts check", () => {
  const registry = REGISTRIES["stellar:testnet"];
  const open = (registry.facilitator("rail402")?.accounts ?? []).filter(
    (account) => account.validToLedger === null,
  );
  const sponsor = open.find((account) => account.role === "sponsor")?.address ?? "";
  const authority = open.find((account) => account.role === "upto-authority")?.address ?? "";
  const closed =
    registry.facilitator("rail402")?.accounts.find((account) => account.validToLedger !== null)?.address ??
    "";

  it("passes when every advertised signer and the upto authority have open rail402 entries", () => {
    const result = checkHostedAccounts(registry, {
      kinds: [{ network: "stellar:testnet", extra: { facilitatorAddress: authority } }],
      signers: {
        "stellar:*": open.filter((account) => account.role !== "upto-authority").map((a) => a.address),
      },
    });
    expect(result.advertised).toContain(sponsor);
    expect(result.advertised).toContain(authority);
    expect(result.missing).toEqual([]);
  });

  it("names an advertised account the registry does not list, or lists only in a closed range", () => {
    const stranger = "GCFORVFZ6QDFPFU6LNODLPC63ZZFA5TJD7XK3ZDMUI6NHDOYPLB5UFHY";
    const result = checkHostedAccounts(registry, {
      kinds: [
        { network: "stellar:testnet", extra: { facilitatorAddress: authority } },
        { network: "stellar:pubnet", extra: { facilitatorAddress: "GIGNORED" } },
      ],
      signers: { "stellar:testnet": [sponsor, stranger, closed], "stellar:pubnet": ["GIGNORED"] },
    });
    expect(result.missing).toEqual([stranger, closed].sort());
    expect(result.advertised).not.toContain("GIGNORED");
  });
});
