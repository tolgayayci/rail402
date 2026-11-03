import { describe, expect, it } from "vitest";
import { PUBNET, TESTNET } from "@rail402.dev/stellar";
import {
  DEFAULT_EXPLORER,
  RAIL402_EXPLORER_URL,
  checkExplorerProvider,
  createBuyer,
  explorerAccountUrl,
  explorerTemplate,
  explorerUrl,
  rail402Explorer,
} from "@rail402.dev/sdk";

const HASH = "ab".repeat(32);
const ACCOUNT = `G${"A".repeat(55)}`;
const CONTRACT = `C${"A".repeat(55)}`;

describe("explorer links", () => {
  it("links pubnet and testnet hashes to their own explorer paths", () => {
    expect(explorerUrl(PUBNET, HASH, "rail402")).toBe(`${RAIL402_EXPLORER_URL}/tx/${HASH}`);
    expect(explorerUrl(TESTNET, HASH, "rail402")).toBe(`${RAIL402_EXPLORER_URL}/testnet/tx/${HASH}`);
    // The Rail402 Explorer is the default on both networks.
    expect(DEFAULT_EXPLORER).toBe("rail402");
    expect(explorerUrl(PUBNET, HASH)).toBe(`https://explorer.rail402.dev/tx/${HASH}`);
    expect(explorerUrl(TESTNET, HASH.toUpperCase())).toBe(`https://explorer.rail402.dev/testnet/tx/${HASH}`);
    expect(explorerUrl(PUBNET, HASH, "stellar.expert")).toBe(
      `https://stellar.expert/explorer/public/tx/${HASH}`,
    );
    expect(explorerUrl(TESTNET, HASH.toUpperCase(), "stellar.expert")).toBe(
      `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    );
    const own = rail402Explorer("https://explorer.example/");
    expect(explorerUrl(PUBNET, HASH, own)).toBe(`https://explorer.example/tx/${HASH}`);
    expect(explorerUrl(TESTNET, HASH, own)).toBe(`https://explorer.example/testnet/tx/${HASH}`);
    const template = explorerTemplate("https://x.example{networkPath}/{network}/tx/{hash}");
    expect(explorerUrl(PUBNET, HASH, template)).toBe(`https://x.example/public/tx/${HASH}`);
    expect(explorerUrl(TESTNET, HASH, template)).toBe(`https://x.example/testnet/testnet/tx/${HASH}`);
    expect(() => explorerUrl(TESTNET, "nothex")).toThrow(
      expect.objectContaining({ code: "transaction_hash_invalid" }),
    );
  });

  it("links accounts and contracts on their own network", () => {
    expect(explorerAccountUrl(PUBNET, ACCOUNT, "rail402")).toBe(`${RAIL402_EXPLORER_URL}/account/${ACCOUNT}`);
    expect(explorerAccountUrl(TESTNET, CONTRACT, "rail402")).toBe(
      `${RAIL402_EXPLORER_URL}/testnet/account/${CONTRACT}`,
    );
    expect(explorerAccountUrl(PUBNET, ACCOUNT)).toBe(`https://explorer.rail402.dev/account/${ACCOUNT}`);
    expect(explorerAccountUrl(TESTNET, ACCOUNT)).toBe(
      `https://explorer.rail402.dev/testnet/account/${ACCOUNT}`,
    );
    expect(explorerAccountUrl(PUBNET, ACCOUNT, "stellar.expert")).toBe(
      `https://stellar.expert/explorer/public/account/${ACCOUNT}`,
    );
    expect(explorerAccountUrl(TESTNET, CONTRACT, "stellar.expert")).toBe(
      `https://stellar.expert/explorer/testnet/contract/${CONTRACT}`,
    );
    const withAccounts = explorerTemplate(
      "https://x.example/tx/{hash}",
      "https://x.example{networkPath}/a/{address}",
    );
    expect(explorerAccountUrl(TESTNET, ACCOUNT, withAccounts)).toBe(`https://x.example/testnet/a/${ACCOUNT}`);
    expect(
      explorerAccountUrl(TESTNET, ACCOUNT, explorerTemplate("https://x.example/tx/{hash}")),
    ).toBeUndefined();
    expect(explorerAccountUrl(TESTNET, "not-an-address")).toBeUndefined();
  });

  it("validates templates at load: https, no credentials, the right placeholders", () => {
    for (const bad of ["http://x.example/{hash}", "https://u:p@x.example/{hash}", "https://x.example/tx"]) {
      expect(() => explorerTemplate(bad)).toThrow(
        expect.objectContaining({ code: "payment_policy_invalid" }),
      );
    }
    expect(() => explorerTemplate("https://x.example/{hash}", "https://x.example/account")).toThrow();
    expect(() => rail402Explorer("https://x.example/?q=1")).toThrow();
    expect(checkExplorerProvider("rail402")).toBe("rail402");
    expect(() => checkExplorerProvider({ template: "javascript:alert(1)//{hash}" })).toThrow();
  });

  it("checks a provider passed to createBuyer the same way: https only, no credentials", async () => {
    for (const explorer of [
      { template: "http://evil.example/{hash}" },
      { template: "https://u:p@evil.example/{hash}" },
      { rail402BaseUrl: "javascript:alert(1)//" },
      "etherscan",
    ]) {
      await expect(
        createBuyer({
          network: TESTNET,
          rpcUrl: "http://127.0.0.1:9",
          explorer: explorer as never,
        }),
      ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    }
    const buyer = await createBuyer({
      network: TESTNET,
      rpcUrl: "http://127.0.0.1:9",
      explorer: { template: "https://x.example/{networkPath}/tx/{hash}" },
    });
    await buyer.close();
  });
});
