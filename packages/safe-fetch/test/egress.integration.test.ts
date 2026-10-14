/**
 * SSRF defences end to end, against real sockets on this machine: IP-literal URLs, DNS answers that
 * change between requests (rebinding), redirects towards private addresses, and oversized answers.
 * Every refused case proves the target server never saw a request.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSafeFetch, pinnedLookup, type EgressError, type Resolver } from "@rail402.dev/safe-fetch";

describe("egress controls against local servers", () => {
  const hits: string[] = [];
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "";
      hits.push(path);
      switch (path) {
        case "/to-metadata":
          response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
          return;
        case "/to-private-name":
          response.writeHead(307, { location: `http://db.internal:${String(port)}/secret` }).end();
          return;
        case "/to-loopback-literal":
          response.writeHead(302, { location: `http://127.0.0.1:${String(port)}/secret` }).end();
          return;
        case "/bomb":
          response
            .writeHead(200, { "content-encoding": "gzip" })
            .end(gzipSync(Buffer.alloc(16 * 1024 * 1024)));
          return;
        case "/endless":
          response.writeHead(200);
          // Streams far more than the limit; the client must stop reading.
          for (let index = 0; index < 64; index++) response.write(Buffer.alloc(64 * 1024, 120));
          response.end();
          return;
        default:
          response.writeHead(200, { "content-type": "text/plain" }).end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    hits.length = 0;
  });

  const failure = async (promise: Promise<unknown>): Promise<EgressError> => {
    try {
      await promise;
    } catch (error) {
      return error as EgressError;
    }
    throw new Error("expected a rejection");
  };

  it("needs the static check: Node dials an IP literal without calling lookup", async () => {
    let lookups = 0;
    const refuseAll = pinnedLookup(() => {
      lookups++;
      return false;
    });
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest(
        `http://127.0.0.1:${String(port)}/literal`,
        { lookup: refuseAll, agent: false },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      )
        .on("error", reject)
        .end();
    });
    expect(status).toBe(200);
    expect(lookups).toBe(0);
    expect(hits).toEqual(["/literal"]);
  });

  it("refuses IP-literal URLs to this machine in every spelling, before connecting", async () => {
    const fetch = createSafeFetch({ schemes: ["http:"], ports: [port] });
    for (const host of ["127.0.0.1", "2130706433", "0x7f.0.0.1", "127.1", "[::1]", "[::ffff:127.0.0.1]"]) {
      const error = await failure(fetch(`http://${host}:${String(port)}/literal`));
      expect(error.code, host).toBe("egress_destination_not_allowed");
      expect(error.stage, host).toBe("url");
    }
    expect(hits).toEqual([]);
    fetch.close();
  });

  it("refuses a name that resolves to a private address, without naming the address", async () => {
    const resolve: Resolver = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    const fetch = createSafeFetch({ schemes: ["http:"], ports: [port], resolve });
    const error = await failure(fetch(`http://seller.example.com:${String(port)}/named`));
    expect(error).toMatchObject({ code: "egress_destination_not_allowed", stage: "dns" });
    expect(error.reason).not.toContain("127.0.0.1");
    expect(hits).toEqual([]);
    fetch.close();
  });

  it("checks every DNS answer, so a rebinding name cannot reach a private address", async () => {
    const answers: { address: string; family: 4 | 6 }[][] = [
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "169.254.169.254", family: 4 }],
      [
        { address: "127.0.0.1", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
    ];
    let lookups = 0;
    const resolve: Resolver = () => Promise.resolve(answers[Math.min(lookups++, answers.length - 1)] ?? []);
    // Loopback stands in for "a public address" here, so the first answer is allowed.
    const fetch = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      resolve,
    });
    const url = `http://rebind.example.com:${String(port)}/data`;

    expect(await (await fetch(url)).text()).toBe("ok");
    fetch.close(); // no pooled socket: the next request resolves again

    expect((await failure(fetch(url))).code).toBe("egress_destination_not_allowed");
    fetch.close();
    expect((await failure(fetch(url))).code).toBe("egress_destination_not_allowed");
    expect(hits).toEqual(["/data"]);
    expect(lookups).toBe(3);
    fetch.close();
  });

  it("never follows a redirect towards a private or other destination", async () => {
    const resolve: Resolver = (host) =>
      Promise.resolve(host === "seller.example.com" ? [{ address: "127.0.0.1", family: 4 }] : []);
    const fetch = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      resolve,
    });
    const base = `http://seller.example.com:${String(port)}`;
    for (const path of ["/to-metadata", "/to-private-name", "/to-loopback-literal"]) {
      const followed = await failure(fetch(`${base}${path}`, { redirect: "same-origin" }));
      expect(followed.code, path).toBe("egress_redirect_not_allowed");
      const refused = await failure(fetch(`${base}${path}`));
      expect(refused.code, path).toBe("egress_redirect_not_allowed");
    }
    // Only the redirecting requests arrived; no hop was ever made.
    expect(hits.every((path) => path.startsWith("/to-"))).toBe(true);
    expect(hits).toHaveLength(6);
    fetch.close();
  });

  it("stops oversized and compressed-bomb answers at the decoded limit", async () => {
    const fetch = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      limits: { responseBodyBytes: 1_048_576 },
    });
    const bomb = await fetch(`http://127.0.0.1:${String(port)}/bomb`);
    expect((await failure(bomb.arrayBuffer())).code).toBe("egress_response_too_large");
    const endless = await fetch(`http://127.0.0.1:${String(port)}/endless`);
    let received = 0;
    const error = await failure(
      (async () => {
        const body = endless.body as ReadableStream<Uint8Array> | null;
        if (body === null) return;
        for await (const chunk of body) received += chunk.byteLength;
      })(),
    );
    expect(error.code).toBe("egress_response_too_large");
    expect(received).toBeLessThanOrEqual(1_048_576);
    fetch.close();
  });

  it("refuses a server whose certificate it cannot trust, before sending the request", async () => {
    const { key, cert } = selfSignedCertificate();
    const requests: string[] = [];
    const tlsServer = createHttpsServer({ key, cert }, (request, response) => {
      requests.push(request.url ?? "");
      response.end("ok");
    });
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    const tlsPort = (tlsServer.address() as AddressInfo).port;
    const fetch = createSafeFetch({ ports: [tlsPort], allowPrivateNetwork: "loopback" });
    try {
      for (const host of ["localhost", "127.0.0.1"]) {
        const error = await failure(fetch(`https://${host}:${String(tlsPort)}/paid`));
        expect(error, host).toMatchObject({ code: "egress_tls_failed", stage: "tls" });
        expect(error.reason, host).toEqual(expect.any(String));
      }
      expect(requests).toEqual([]);
    } finally {
      fetch.close();
      tlsServer.closeAllConnections();
      await new Promise((resolve) => tlsServer.close(resolve));
    }
  });
});

/** A throwaway self-signed certificate for localhost and 127.0.0.1 (needs the `openssl` command). */
function selfSignedCertificate(): { key: Buffer; cert: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), "rail402-egress-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(directory, "key.pem")), cert: readFileSync(join(directory, "cert.pem")) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
