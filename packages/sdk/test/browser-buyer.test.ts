/**
 * The browser buyer: the same buyer over a transport the page supplies, with createBuyer's pubnet
 * rules, and a URL check that needs no Node.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetch, resolvePolicy, type SafeFetch } from "@rail402.dev/safe-fetch";
import { PUBNET, TESTNET } from "@rail402.dev/stellar";
import { KeyHolder, checkUrlSyntax, createBrowserBuyer, type BuyerTransport } from "@rail402.dev/sdk/browser";
import * as browser from "@rail402.dev/sdk/browser";
import * as root from "@rail402.dev/sdk";
import { paidRoute, startSeller, type FakeSeller } from "./flow-harness.ts";

/** A seller fetch that records its calls and whether it was closed. */
function recording(inner: SafeFetch): SafeFetch & { readonly urls: string[]; closed: boolean } {
  const urls: string[] = [];
  const wrapped = Object.assign(
    (input: string | URL, init?: Parameters<SafeFetch>[1]) => {
      urls.push(String(input));
      return inner(input, init);
    },
    {
      policy: inner.policy,
      urls,
      closed: false,
      close() {
        wrapped.closed = true;
        inner.close();
      },
    },
  );
  return wrapped;
}

const refusingOperator: typeof fetch = () => Promise.reject(new Error("no operator call expected"));

describe("@rail402.dev/sdk/browser", () => {
  let seller: FakeSeller;

  beforeAll(async () => {
    seller = await startSeller({ "/paid": paidRoute() });
  });

  afterAll(async () => {
    await seller.close();
  });

  it("offers the buyer without the Node wiring", () => {
    expect(browser).toHaveProperty("createBrowserBuyer");
    expect(browser).toHaveProperty("StorageSpendLedger");
    expect(browser).toHaveProperty("KeyHolder");
    expect(browser).toHaveProperty("addTrustline");
    expect(browser).not.toHaveProperty("createBuyer");
    expect(browser).not.toHaveProperty("resolveAgentConfig");
    expect(root.createBrowserBuyer).toBe(browser.createBrowserBuyer);
    expect(root.KeyHolder).toBe(browser.KeyHolder);
  });

  it("reaches sellers only through the transport, which stays open when the buyer closes", async () => {
    const transport = recording(
      createSafeFetch({ schemes: ["http:"], ports: [seller.port], allowPrivateNetwork: "loopback" }),
    );
    const buyer = await createBrowserBuyer({
      network: TESTNET,
      signer: KeyHolder.random(),
      rpcUrl: "http://127.0.0.1:1",
      transport: { seller: transport, operator: refusingOperator },
    });
    const quote = await buyer.quote({ kind: "http", url: `${seller.url}/paid` });
    expect(quote).toMatchObject({ paymentRequired: true, status: 402 });
    expect(quote.chosen).not.toBeNull();
    expect(transport.urls).toEqual([`${seller.url}/paid`]);
    await buyer.close();
    expect(transport.closed).toBe(false);
    transport.close();
  });

  it("applies createBuyer's pubnet rules to the transport and the RPC", async () => {
    const signer = KeyHolder.random();
    const transport = (policy: Parameters<typeof resolvePolicy>[0]): BuyerTransport => ({
      seller: Object.assign(() => Promise.reject(new Error("unused")), {
        policy: resolvePolicy(policy),
        close: () => undefined,
      }),
      operator: refusingOperator,
    });
    for (const [policy, rpcUrl] of [
      [{ schemes: ["https:", "http:"] }, "https://rpc.example"],
      [{ allowPrivateNetwork: "loopback" }, "https://rpc.example"],
      [{ ports: [443, 8443] }, "https://rpc.example"],
      [{}, "http://rpc.example"],
    ] as const) {
      await expect(
        createBrowserBuyer({ network: PUBNET, signer, rpcUrl, transport: transport(policy) }),
      ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    }
    await expect(
      createBrowserBuyer({ network: TESTNET, signer, rpcUrl: "not a url", transport: transport({}) }),
    ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    await expect(
      createBrowserBuyer({
        network: TESTNET,
        signer,
        rpcUrl: "https://rpc.example",
        transport: { seller: transport({}).seller } as BuyerTransport,
      }),
    ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    await expect(
      createBrowserBuyer({
        network: "stellar:futurenet" as typeof TESTNET,
        signer,
        rpcUrl: "https://rpc.example",
        transport: transport({}),
      }),
    ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    await expect(
      createBrowserBuyer({
        network: TESTNET,
        signer: { address: signer.address } as KeyHolder,
        rpcUrl: "https://rpc.example",
        transport: transport({}),
      }),
    ).rejects.toMatchObject({ code: "payment_signer_unavailable" });
  });

  it("checks a URL's form, scheme and port without resolving its host", () => {
    const https = resolvePolicy();
    expect(checkUrlSyntax("https://api.example/x", https).hostname).toBe("api.example");
    // The host is not classified here: the transport refuses private destinations.
    expect(checkUrlSyntax("https://127.0.0.1/", https).hostname).toBe("127.0.0.1");
    const refused: [string, string][] = [
      ["", "egress_url_invalid"],
      ["/relative", "egress_url_invalid"],
      ["https://user:pass@api.example/", "egress_url_invalid"],
      ["https://api.example/\nx", "egress_url_invalid"],
      [`https://api.example/${"a".repeat(2_048)}`, "egress_url_invalid"],
      ["http://api.example/", "egress_scheme_not_allowed"],
      ["https://api.example:8443/", "egress_port_not_allowed"],
    ];
    for (const [url, code] of refused) {
      expect(() => checkUrlSyntax(url, https), url).toThrow(expect.objectContaining({ code, stage: "url" }));
    }
    const local = resolvePolicy({ schemes: ["http:"], ports: [8080] });
    expect(checkUrlSyntax("http://localhost:8080/", local).port).toBe("8080");
  });
});
