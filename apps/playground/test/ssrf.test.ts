import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkSellerOrigin, type OriginReport } from "@rail402.dev/sdk/seller";
import { SELLER_CHECK_PATH } from "../src/seller-check.ts";
import { RELAY_PATH, encodeRelayRequest } from "../src/shared/relay-protocol.ts";
import { testApp, testConfig, type TestApp } from "./support.ts";

/** Limits high enough for a matrix of requests from one client. */
const ROOMY = {
  SELLER_CHECK_PER_MINUTE: "1000",
  SELLER_CHECK_GLOBAL_PER_MINUTE: "1000",
  RELAY_UNPAID_PER_MINUTE: "1000",
  RELAY_UNPAID_BURST: "1000",
} as const;

type Resolver = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

/** Endpoints that refuse connections, so the seller check's other reads stay off the network. */
const CLOSED = "http://127.0.0.1:9";

/**
 * Where a hosted Playground must never send a request, through the relay or the seller check, and
 * the egress code each one is refused with before any DNS lookup or connection.
 */
const LITERAL_REFUSALS: readonly (readonly [string, string])[] = [
  ["http://seller.example/", "egress_scheme_not_allowed"],
  ["ftp://seller.example/", "egress_scheme_not_allowed"],
  ["https://seller.example:8443/", "egress_port_not_allowed"],
  ["https://seller.example:80/", "egress_port_not_allowed"],
  ["https://user:pass@seller.example/", "egress_url_invalid"],
  // Loopback, also in the spellings the URL parser normalizes to 127.0.0.1.
  ["https://127.0.0.1/", "egress_destination_not_allowed"],
  ["https://127.1/", "egress_destination_not_allowed"],
  ["https://2130706433/", "egress_destination_not_allowed"],
  ["https://0x7f000001/", "egress_destination_not_allowed"],
  ["https://0177.0.0.1/", "egress_destination_not_allowed"],
  ["https://[::1]/", "egress_destination_not_allowed"],
  ["https://localhost/", "egress_destination_not_allowed"],
  ["https://localhost./", "egress_destination_not_allowed"],
  ["https://api.localhost/", "egress_destination_not_allowed"],
  // Unspecified, private, carrier-grade NAT, link-local and metadata, benchmarking, multicast, broadcast.
  ["https://0.0.0.0/", "egress_destination_not_allowed"],
  ["https://[::]/", "egress_destination_not_allowed"],
  ["https://10.1.2.3/", "egress_destination_not_allowed"],
  ["https://172.16.0.1/", "egress_destination_not_allowed"],
  ["https://192.168.1.1/", "egress_destination_not_allowed"],
  ["https://100.100.100.200/", "egress_destination_not_allowed"],
  ["https://169.254.169.254/latest/meta-data/", "egress_destination_not_allowed"],
  ["https://198.18.0.1/", "egress_destination_not_allowed"],
  ["https://224.0.0.1/", "egress_destination_not_allowed"],
  ["https://255.255.255.255/", "egress_destination_not_allowed"],
  // IPv6 forms that reach private IPv4 or local networks.
  ["https://[::ffff:169.254.169.254]/", "egress_destination_not_allowed"],
  ["https://[::ffff:7f00:1]/", "egress_destination_not_allowed"],
  ["https://[64:ff9b::a9fe:a9fe]/", "egress_destination_not_allowed"],
  ["https://[2002:a9fe:a9fe::]/", "egress_destination_not_allowed"],
  ["https://[fd00:ec2::254]/", "egress_destination_not_allowed"],
  ["https://[fe80::1]/", "egress_destination_not_allowed"],
  ["https://[ff02::1]/", "egress_destination_not_allowed"],
  // Names that only resolve on private networks.
  ["https://metadata.google.internal/", "egress_destination_not_allowed"],
  ["https://printer.local/", "egress_destination_not_allowed"],
  ["https://router.home.arpa/", "egress_destination_not_allowed"],
  ["https://intranet/", "egress_destination_not_allowed"],
];

/** Public names whose DNS answers point somewhere private: refused when the answer arrives. */
const DNS_ANSWERS: Readonly<Record<string, readonly { address: string; family: 4 | 6 }[]>> = {
  "private.example": [{ address: "10.0.0.1", family: 4 }],
  "metadata.example": [{ address: "169.254.169.254", family: 4 }],
  "mixed.example": [
    { address: "93.184.215.14", family: 4 },
    { address: "192.168.0.10", family: 4 },
  ],
  "mapped.example": [{ address: "::ffff:127.0.0.1", family: 6 }],
  "nat64.example": [{ address: "64:ff9b::a9fe:a9fe", family: 6 }],
  "loopback6.example": [{ address: "::1", family: 6 }],
};

describe("egress controls of the relay and the seller check", () => {
  let app: TestApp | undefined;
  afterEach(() => {
    app?.close();
    app = undefined;
  });

  function hosted(resolve: Resolver, env: Record<string, string> = {}): TestApp {
    // No request here gets a 402, so the check never reads the RPC or the facilitator.
    app = testApp(testConfig({ ...ROOMY, ...env }), {
      egress: { resolve },
      sellerCheck: checkSellerOrigin,
    });
    return app;
  }

  async function relayed(target: string, extra: Record<string, string> = {}) {
    if (app === undefined) throw new Error("no app");
    const response = await app.request(RELAY_PATH, {
      method: "POST",
      headers: {
        ...encodeRelayRequest({ target, method: "GET", redirect: "same-origin", headers: {} }),
        ...extra,
      },
    });
    expect(response.headers.get("x-relay"), target).toBe("error");
    const body = (await response.json()) as {
      error: { code: string; reason: string; details?: { stage?: string } };
    };
    expect(body.error.reason).not.toBe("");
    return body.error;
  }

  async function checked(url: string): Promise<OriginReport> {
    if (app === undefined) throw new Error("no app");
    const response = await app.request(SELLER_CHECK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    expect(response.status, url).toBe(200);
    return (await response.json()) as OriginReport;
  }

  it("refuses every private, local, reserved or off-policy literal before any lookup", async () => {
    const lookups: string[] = [];
    hosted((host) => {
      lookups.push(host);
      return Promise.reject(new Error("no lookup expected"));
    });
    for (const [target, code] of LITERAL_REFUSALS) {
      expect(await relayed(target), target).toMatchObject({ code, details: { stage: "url" } });
      const report = await checked(target);
      expect(report.ok, target).toBe(false);
      expect(report.findings, target).toEqual([
        expect.objectContaining({ code: "seller_origin_unreachable", details: { cause: code } }),
      ]);
    }
    expect(lookups).toEqual([]);
  });

  it("refuses a public name whose DNS answers include any private address", async () => {
    hosted((host) => Promise.resolve([...(DNS_ANSWERS[host] ?? [])]));
    for (const host of Object.keys(DNS_ANSWERS)) {
      const target = `https://${host}/`;
      expect(await relayed(target), target).toMatchObject({
        code: "egress_destination_not_allowed",
        details: { stage: "dns" },
      });
      const report = await checked(target);
      expect(report.findings, target).toEqual([
        expect.objectContaining({ details: { cause: "egress_destination_not_allowed" } }),
      ]);
    }
  });

  it("refuses targets with control characters or past 2 KiB", async () => {
    hosted(() => Promise.reject(new Error("no lookup expected")));
    expect((await relayed(`https://seller.example/${"a".repeat(2_100)}`)).code).toBe(
      "playground_relay_target_invalid",
    );
    if (app === undefined) throw new Error("no app");
    for (const url of ["https://seller.example/a\tb", "https://seller.\nexample/"]) {
      const response = await app.request(SELLER_CHECK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "playground_request_invalid", reason: "url: must not contain control characters" },
      });
    }
  });

  it("does not let the relay reach the Playground, the facilitator, the Bazaar or a denied host by any spelling", async () => {
    hosted(() => Promise.reject(new Error("no lookup expected")), {
      FACILITATOR_URL: "https://facilitator.example",
      BAZAAR_URL: "https://bazaar.example",
      RELAY_DENY_HOSTS: "Denied.Example",
    });
    const cases: [string, string][] = [
      ["https://playground.example/api/relay", "playground_relay_loop"],
      ["https://PLAYGROUND.example./lab/sell/forecast/x", "playground_relay_loop"],
      ["https://playground.example:443/", "playground_relay_loop"],
      ["https://facilitator.example/settle", "playground_relay_target_denied"],
      ["https://bazaar.example./discovery/resources", "playground_relay_target_denied"],
      ["https://denied.example/", "playground_relay_target_denied"],
    ];
    for (const [target, code] of cases) expect((await relayed(target)).code, target).toBe(code);
  });

  describe("redirects", () => {
    let server: Server;
    let origin: string;

    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/to-metadata") {
          response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        } else if (request.url === "/to-other-port") {
          response.writeHead(307, { location: "http://127.0.0.1:9/" }).end();
        } else {
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("never follows a redirect off the seller's origin, even for unpaid requests that allow redirects", async () => {
      app = testApp(
        testConfig({
          ...ROOMY,
          PLAYGROUND_MODE: "local",
          PUBLIC_URL: "http://127.0.0.1:1",
          RPC_URL: CLOSED,
          FACILITATOR_URL: CLOSED,
        }),
        { sellerCheck: checkSellerOrigin },
      );
      for (const path of ["/to-metadata", "/to-other-port"]) {
        expect((await relayed(`${origin}${path}`)).code, path).toBe("egress_redirect_not_allowed");
        const report = await checked(`${origin}${path}`);
        expect(report.findings[0]?.details, path).toEqual({ cause: "egress_redirect_not_allowed" });
      }
    });
  });
});
