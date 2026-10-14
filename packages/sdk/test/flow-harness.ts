import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createSafeFetch, type EgressPolicyInput } from "@rail402.dev/safe-fetch";
import { TESTNET } from "@rail402.dev/stellar";
import { paymentEcho } from "@rail402.dev/testkit";
import {
  KeyHolder,
  MemorySpendLedger,
  windowSpecFor,
  type FlowChain,
  type FlowContext,
  type PaymentEvent,
  type ResolvedPolicy,
  type Sep43AuthSigner,
  type SpendLedger,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";
import { clock, requirements, tamperingAdapter, testPolicy, type Tampering } from "./helpers.ts";

/** A base signer that counts how often it signs. */
export function countingSigner(key = KeyHolder.random()): Sep43AuthSigner & { signatures: number } {
  const signer = {
    address: key.address,
    signatures: 0,
    signAuthEntry: async (entry: string) => {
      signer.signatures++;
      return key.signAuthEntry(entry);
    },
  };
  return signer;
}

export const fundedChain = (overrides: Partial<FlowChain> = {}): FlowChain => ({
  getTransaction: () => Promise.reject(new Error("no RPC in unit tests")),
  funds: () =>
    Promise.resolve({ trustline: true, authorized: true, balance: 10n ** 12n, available: 10n ** 12n }),
  receivable: () => Promise.resolve(true),
  reader: {
    latestLedger: () => Promise.resolve(10_000),
    findTransfers: () => Promise.resolve([]),
    transaction: () => Promise.resolve("missing"),
  },
  ...overrides,
});

export interface ContextOptions {
  readonly signer?: Sep43AuthSigner;
  readonly policy?: ResolvedPolicy;
  readonly ledger?: SpendLedger;
  readonly adapters?: readonly StellarSchemeAdapter[];
  readonly tampering?: Tampering;
  readonly chain?: FlowChain;
  readonly egress?: EgressPolicyInput;
  /** Loopback ports the default egress policy allows. */
  readonly ports?: readonly number[];
  readonly verify?: FlowContext["verify"];
  readonly events?: PaymentEvent[];
}

/** A payment flow context with offline signing, a fake chain and loopback egress. */
export async function flowContext(options: ContextOptions = {}): Promise<FlowContext> {
  const signer = options.signer ?? countingSigner();
  const policy = options.policy ?? (await testPolicy());
  const egress: EgressPolicyInput = options.egress ?? {
    schemes: ["http:"],
    ports: [...(options.ports ?? [])],
    allowPrivateNetwork: "loopback",
  };
  return {
    network: TESTNET,
    policy,
    adapters: options.adapters ?? [tamperingAdapter(options.tampering)],
    signer,
    ledger: options.ledger ?? new MemorySpendLedger(),
    spec: windowSpecFor(policy, signer.address),
    clock: clock(),
    rpcUrl: "http://127.0.0.1:1",
    chain: options.chain ?? fundedChain(),
    explorer: "stellar.expert",
    verify: options.verify ?? "off",
    verifyDelayMs: 1,
    onEvent: options.events === undefined ? undefined : (event) => options.events?.push(event),
    fetch: createSafeFetch(egress),
    openSession: () => createSafeFetch(egress),
  };
}

export interface SellerRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
  readonly payment: PaymentPayload | undefined;
}

export type SellerRoute = (request: SellerRequest, response: ServerResponse, seller: FakeSeller) => void;

/** A local x402 seller whose answers come from a route table. */
export interface FakeSeller {
  readonly url: string;
  readonly port: number;
  readonly payTo: string;
  readonly seen: SellerRequest[];
  /** 402 with PAYMENT-REQUIRED for `options`. */
  paymentRequired(
    response: ServerResponse,
    options?: Partial<PaymentRequirements>,
    extra?: Partial<PaymentRequired>,
  ): void;
  /** 200 JSON with a successful PAYMENT-RESPONSE. */
  settled(response: ServerResponse, body?: unknown, status?: number): void;
  close(): Promise<void>;
}

export const TX_HASH = "ab".repeat(32);

export async function startSeller(routes: Record<string, SellerRoute>): Promise<FakeSeller> {
  const seen: SellerRequest[] = [];
  const payTo = Keypair.random().publicKey();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const header = request.headers["payment-signature"];
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      const entry: SellerRequest = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        payment: typeof header === "string" ? decodePaymentSignatureHeader(header) : undefined,
      };
      seen.push(entry);
      const route = routes[path];
      if (route === undefined) {
        response.writeHead(404).end("not found");
        return;
      }
      route(entry, response, seller);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  const seller: FakeSeller = {
    url,
    port,
    payTo,
    seen,
    paymentRequired(response, options = {}, extra = {}) {
      const required: PaymentRequired = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: `${url}/resource` },
        accepts: [requirements({ payTo, ...options })],
        ...extra,
      };
      response.writeHead(402, { "payment-required": encodePaymentRequiredHeader(required) }).end("{}");
    },
    settled(response, body = { ok: true }, status = 200) {
      response
        .writeHead(status, {
          "content-type": "application/json",
          "payment-response": encodePaymentResponseHeader({
            success: true,
            transaction: TX_HASH,
            network: TESTNET,
            payer: "",
          }),
        })
        .end(JSON.stringify(body));
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  return seller;
}

/** A route that asks for payment and serves `body` once paid. */
export const paidRoute =
  (options: Partial<PaymentRequirements> = {}, body: unknown = { ok: true }): SellerRoute =>
  (request, response, seller) => {
    if (request.payment === undefined) seller.paymentRequired(response, options);
    else seller.settled(response, body);
  };

/** A paid route whose answer echoes the payment it was paid with, in every form (`paymentEcho`). */
export const echoRoute: SellerRoute = (request, response, seller) => {
  const header = request.headers["payment-signature"];
  if (request.payment === undefined || typeof header !== "string") seller.paymentRequired(response);
  else {
    const payment = request.payment as unknown as Record<string, unknown>;
    seller.settled(response, paymentEcho(payment, Networks.TESTNET, header));
  }
};
