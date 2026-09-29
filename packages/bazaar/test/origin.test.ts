import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { fetchPaymentRequired, paymentRequiredFor } from "@rail402.dev/bazaar";

interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A seller on loopback that records every request and answers with the route's handler. */
describe("origin checks", () => {
  const received: Received[] = [];
  const required = paymentRequiredFor({ url: "https://api.example.com/weather" });
  const routes: Record<string, (response: ServerResponse) => void> = {
    "/paid": (response) => {
      response.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }).end("{}");
    },
    "/redirect": (response) => {
      response.writeHead(302, { location: "/paid" }).end();
    },
  };
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "";
        received.push({
          method: request.method ?? "",
          path,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        (routes[path] ?? routes["/paid"])?.(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    received.length = 0;
  });

  it("returns the PaymentRequired of a 402 answer", async () => {
    const response = await fetchPaymentRequired(`${origin}/paid`, "GET", { allowLoopback: true });
    expect(response).toEqual({ kind: "payment_required", paymentRequired: required });
  });

  it("sends the listing's method with the origin-check user agent and no body for GET", async () => {
    await fetchPaymentRequired(`${origin}/paid`, "get", { allowLoopback: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "GET", path: "/paid", body: "" });
    expect(received[0]?.headers["user-agent"]).toBe("rail402-bazaar-origin-check/1 (+https://rail402.dev)");
    expect(received[0]?.headers["content-type"]).toBeUndefined();
  });

  it.each(["POST", "PUT", "PATCH"])("sends %s with the JSON body {}", async (method) => {
    await fetchPaymentRequired(`${origin}/paid`, method, { allowLoopback: true });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method, body: "{}" });
    expect(received[0]?.headers["content-type"]).toBe("application/json");
    expect(received[0]?.headers["user-agent"]).toBe("rail402-bazaar-origin-check/1 (+https://rail402.dev)");
  });

  it("sends DELETE without a body", async () => {
    await fetchPaymentRequired(`${origin}/paid`, "DELETE", { allowLoopback: true });
    expect(received[0]).toMatchObject({ method: "DELETE", body: "" });
  });

  it("does not follow redirects", async () => {
    const response = await fetchPaymentRequired(`${origin}/redirect`, "GET", { allowLoopback: true });
    expect(response).toEqual({ kind: "not_payment_required", status: 302 });
    expect(received.map((request) => request.path)).toEqual(["/redirect"]);
  });

  it("refuses a host whose DNS answers are not public, before connecting", async () => {
    const port = (server.address() as AddressInfo).port;
    const response = await fetchPaymentRequired(`http://localhost:${String(port)}/paid`, "GET");
    expect(response).toMatchObject({ kind: "unreachable" });
    expect(response.kind === "unreachable" ? response.reason : "").toMatch(/^refused to connect to /);
    expect(received).toEqual([]);
  });

  it("speaks only http and https", async () => {
    expect(await fetchPaymentRequired("ftp://api.example.com/x", "GET")).toMatchObject({
      kind: "unreachable",
    });
    expect(received).toEqual([]);
  });
});
