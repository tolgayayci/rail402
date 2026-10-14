import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { SecretScanner } from "@rail402.dev/testkit";
import { SELLER_CHECK_PATH } from "../src/seller-check.ts";
import { LAB_PATHS, sellPath } from "../src/shared/lab.ts";
import { RELAY_PATH, encodeRelayRequest } from "../src/shared/relay-protocol.ts";
import { TRACE_HEADER, decodeTrace } from "../src/shared/trace.ts";
import { fakeFacilitator, requiredOf } from "./fake-facilitator.ts";
import { PAY_TO, testApp, testConfig, type TestApp } from "./support.ts";

/**
 * The server-side canary scan. A canary key signs a payment; its seed, key bytes, transaction and
 * PAYMENT-SIGNATURE header are the needles. The payment goes through every server path that can carry
 * one (the relay, both lab sellers, a facilitator that echoes what it was sent), and every channel the
 * server writes is captured: response bodies and headers (Rail402-Trace included), trace-level logs,
 * anything printed to the console, /metrics, /api/config and the seller check. Only the seller the
 * relay forwards to and the facilitator may receive the payment; the scan requires every other
 * channel to be clean.
 */
describe("server secret scan", () => {
  const canary = Keypair.random();
  const passphrase = Networks.TESTNET;
  const received: IncomingHttpHeaders[] = [];
  let server: Server;
  let origin: string;
  let app: TestApp | undefined;
  const consoleLines: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      received.push(request.headers);
      request.resume();
      if (request.url === "/paid") {
        response.writeHead(200, {
          "content-type": "application/json",
          "payment-response": "eyJzdWNjZXNzIjp0cnVlfQ",
        });
        response.end('{"ok":true}');
      } else {
        response.writeHead(402, {
          "content-type": "application/json",
          "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0",
        });
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  afterEach(() => {
    app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  /** A payment for `required` whose transaction is signed by the canary key. */
  function canaryPayment(required: PaymentRequired): string {
    const transaction = new TransactionBuilder(new Account(canary.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: passphrase,
    })
      .addOperation(Operation.payment({ destination: PAY_TO, asset: Asset.native(), amount: "1" }))
      .setTimeout(60)
      .build();
    transaction.sign(canary);
    const [accepted] = required.accepts;
    return encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: { transaction: transaction.toXDR() },
    } as PaymentPayload);
  }

  function captureConsole(): void {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
  }

  /**
   * Captures a response. Base64 JSON headers are captured decoded: their raw text shares aligned
   * base64 runs of public fields (network, amount) with the payment header, which windows would
   * report, while a leaked payment inside them still shows in the decoded JSON.
   */
  async function capture(scanner: SecretScanner, channel: string, response: Response): Promise<void> {
    const headers = [...response.headers].map(([name, value]) => {
      if (name === "payment-response") return [name, decodePaymentResponseHeader(value)];
      if (name === TRACE_HEADER) return [name, decodeTrace(value) ?? value];
      return [name, value];
    });
    scanner.capture(`${channel} headers`, JSON.stringify(headers));
    scanner.capture(`${channel} body`, Buffer.from(await response.arrayBuffer()));
  }

  it("keeps the payment and the key out of every channel but the seller and the facilitator", async () => {
    captureConsole();
    const scanner = new SecretScanner(canary.secret());
    const facilitators = {
      settles: fakeFacilitator(),
      echoes: fakeFacilitator({
        verify: () => Promise.reject(new Error(`facilitator echo: ${JSON.stringify(received.at(-1) ?? {})}`)),
      }),
    };

    // The relay, in local mode so it can reach the loopback seller.
    app = testApp(
      testConfig({ PLAYGROUND_MODE: "local", PUBLIC_URL: "http://127.0.0.1:1", LOG_LEVEL: "trace" }),
      { labFacilitator: facilitators.settles },
    );
    const relayPayment = canaryPayment(requiredOf(await app.request(sellPath("Ankara"))));
    scanner.addPaymentHeader(relayPayment, passphrase);
    const relay = (target: string) =>
      app?.request(RELAY_PATH, {
        method: "POST",
        headers: encodeRelayRequest({
          target,
          method: "GET",
          redirect: "error",
          headers: { accept: "application/json", "payment-signature": relayPayment },
        }),
      }) ?? Promise.reject(new Error("no app"));
    await capture(scanner, "relay answer", await relay(`${origin}/paid`));
    await capture(scanner, "relay 402", await relay(`${origin}/required`));
    await capture(scanner, "relay failure", await relay("http://127.0.0.1:9/paid"));
    expect(received.filter((headers) => headers["payment-signature"] === relayPayment)).toHaveLength(2);

    // Both lab sellers, with a facilitator that settles.
    for (const path of [sellPath("Ankara"), `${LAB_PATHS.greedy}?city=Berlin&days=7`]) {
      const payment = canaryPayment(requiredOf(await app.request(path)));
      scanner.addPaymentHeader(payment, passphrase);
      await capture(
        scanner,
        `lab ${path}`,
        await app.request(path, { headers: { "payment-signature": payment } }),
      );
    }
    expect(facilitators.settles.calls.length).toBeGreaterThan(0);

    // The seller check, handed the payment where it does not belong, and the public endpoints.
    await capture(
      scanner,
      "seller check",
      await app.request(SELLER_CHECK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://seller.example/", toolName: relayPayment }),
      }),
    );
    for (const path of ["/api/config", "/metrics", "/health"])
      await capture(scanner, path, await app.request(path));
    scanner.capture("server log (relay, lab, checks)", app.logs.text());
    app.close();

    // A lab seller whose facilitator echoes what it received into its error.
    app = testApp(testConfig({ LOG_LEVEL: "trace" }), { labFacilitator: facilitators.echoes });
    const payment = canaryPayment(requiredOf(await app.request(sellPath("Ankara"))));
    scanner.addPaymentHeader(payment, passphrase);
    received.push({ "payment-signature": payment });
    const echoed = await app.request(sellPath("Ankara"), { headers: { "payment-signature": payment } });
    expect(echoed.status).toBe(503);
    await capture(scanner, "lab with an echoing facilitator", echoed);
    scanner.capture("server log (echoing facilitator)", app.logs.text());
    scanner.capture("console", consoleLines.join("\n"));

    expect(scanner.needles).toBeGreaterThan(8);
    expect(scanner.channels.length).toBeGreaterThan(15);
    scanner.assertClean();
  });

  it("fails when a needle is planted in a channel", () => {
    const scanner = new SecretScanner(canary.secret());
    const payment = canaryPayment({
      x402Version: 2,
      resource: { url: "https://seller.example/" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amount: "1",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    });
    scanner.addPaymentHeader(payment, passphrase);
    scanner.capture("planted log line", JSON.stringify({ msg: "request", leaked: payment.slice(10, 50) }));
    expect(scanner.findings()).not.toEqual([]);
    expect(() => {
      scanner.assertClean();
    }).toThrow(/secret scan/);
  });
});
