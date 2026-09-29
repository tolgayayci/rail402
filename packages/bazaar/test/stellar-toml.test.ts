import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { accountsOf, fetchStellarTomlAccounts, type StellarTomlResult } from "@rail402.dev/bazaar";

const account = Keypair.random().publicKey();
const reason = (result: StellarTomlResult) => (result.ok ? "" : result.reason);
const contract = StrKey.encodeContract(Keypair.random().rawPublicKey());

describe("stellar.toml ACCOUNTS", () => {
  let server: Server;
  let host: string;
  const bodies = new Map<string, { status: number; body: string }>();

  beforeAll(async () => {
    server = createServer((request, response) => {
      const reply = bodies.get(request.headers.host ?? "") ?? { status: 404, body: "" };
      expect(request.url).toBe("/.well-known/stellar.toml");
      response.writeHead(reply.status, { "content-type": "text/plain" });
      response.end(reply.body);
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("returns the valid Stellar addresses a domain claims", async () => {
    bodies.set(host, {
      status: 200,
      body: `VERSION = "2.7.0"\nACCOUNTS = ["${account}", "not-an-account", "${contract}"]\n`,
    });
    expect(await fetchStellarTomlAccounts(host, { allowLoopback: true })).toEqual({
      ok: true,
      accounts: [account, contract],
    });
  });

  it("reports a missing file, a missing ACCOUNTS list or invalid TOML", async () => {
    bodies.set(host, { status: 404, body: "" });
    expect(await fetchStellarTomlAccounts(host, { allowLoopback: true })).toMatchObject({ ok: false });
    expect(reason(accountsOf('VERSION = "2.7.0"'))).toContain("ACCOUNTS");
    expect(reason(accountsOf("ACCOUNTS = ["))).toContain("TOML");
  });

  it("refuses a file larger than SEP-1 allows", async () => {
    bodies.set(host, { status: 200, body: `ACCOUNTS = ["${account}"]\n# ${"x".repeat(110 * 1024)}\n` });
    expect(reason(await fetchStellarTomlAccounts(host, { allowLoopback: true }))).toContain("100 KB");
  });

  it("never connects to a private address unless loopback is explicitly allowed", async () => {
    bodies.set(host, { status: 200, body: `ACCOUNTS = ["${account}"]\n` });
    expect(await fetchStellarTomlAccounts(host)).toMatchObject({ ok: false });
  });
});
