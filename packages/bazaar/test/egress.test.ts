import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPaymentRequired, fetchStellarTomlAccounts } from "@rail402.dev/bazaar";

/** Node dials IP literals without calling `lookup`, so the catalog classifies them before connecting. */
describe("catalog fetches to IP literals", () => {
  const hits: string[] = [];
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.writeHead(200).end("ACCOUNTS = []");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a private IP literal for origin checks unless loopback is allowed", async () => {
    for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "2130706433"]) {
      const response = await fetchPaymentRequired(`http://${host}:${String(port)}/paid`, "GET");
      expect(response, host).toMatchObject({ kind: "unreachable" });
      expect(response.kind === "unreachable" ? response.reason : "").toMatch(/^refused to connect to /);
    }
    expect(hits).toEqual([]);
    const allowed = await fetchPaymentRequired(`http://127.0.0.1:${String(port)}/paid`, "GET", {
      allowLoopback: true,
    });
    expect(allowed).toEqual({ kind: "not_payment_required", status: 200 });
    expect(hits).toEqual(["/paid"]);
  });

  it("refuses a private IP literal for stellar.toml", async () => {
    hits.length = 0;
    expect(await fetchStellarTomlAccounts(`10.0.0.1:${String(port)}`)).toMatchObject({ ok: false });
    expect(await fetchStellarTomlAccounts(`127.0.0.1:${String(port)}`)).toMatchObject({ ok: false });
    expect(hits).toEqual([]);
  });
});
