import { randomBytes } from "node:crypto";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { SettledPayment } from "./extract.ts";

/** Circle testnet USDC, used as the default asset of fixtures. */
export const FIXTURE_ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

export interface PaymentFixture {
  readonly url?: string;
  readonly kind?: "http" | "mcp";
  readonly method?: string;
  readonly toolName?: string;
  readonly payTo?: string;
  readonly payer?: string;
  readonly amount?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly routeTemplate?: string;
  /** The concrete path parameters the bazaar server extension adds for a route template. */
  readonly pathParams?: Record<string, string>;
  readonly description?: string;
  readonly serviceName?: string;
  readonly tags?: unknown;
  readonly iconUrl?: string;
  /** Replaces the whole bazaar extension. */
  readonly extension?: unknown;
  /** Other extensions, declared by the seller and echoed by the buyer next to `bazaar`. */
  readonly extensions?: Record<string, unknown>;
  readonly transaction?: string;
}

export function randomAddress(): string {
  return Keypair.random().publicKey();
}

/** The M… address of `account` with muxed ID `id`. */
export function muxedAddress(account: string, id: bigint): string {
  return new MuxedAccount(new Account(account, "0"), id.toString()).accountId();
}

/** A settled payment whose bazaar extension is built with the upstream seller helper. */
export function settledPayment(fixture: PaymentFixture = {}): SettledPayment {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: (fixture.network ?? "stellar:testnet") as PaymentRequirements["network"],
    asset: fixture.asset ?? FIXTURE_ASSET,
    payTo: fixture.payTo ?? randomAddress(),
    amount: fixture.amount ?? "10000",
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: {
      url: fixture.url ?? "https://api.example.com/weather",
      ...(fixture.description === undefined
        ? { description: "Weather for a city" }
        : { description: fixture.description }),
      mimeType: "application/json",
      ...(fixture.serviceName === undefined ? {} : { serviceName: fixture.serviceName }),
      ...(fixture.tags === undefined ? {} : { tags: fixture.tags as string[] }),
      ...(fixture.iconUrl === undefined ? {} : { iconUrl: fixture.iconUrl }),
    },
    accepted: requirements,
    payload: { transaction: "AAAA" },
    extensions: { ...fixture.extensions, bazaar: fixture.extension ?? extensionFor(fixture) },
  };
  return {
    payload,
    requirements,
    payer: fixture.payer ?? randomAddress(),
    transaction: fixture.transaction ?? randomBytes(32).toString("hex"),
  };
}

/** The PaymentRequired a seller's server would answer with, for origin-check tests. */
export function paymentRequiredFor(fixture: PaymentFixture = {}): PaymentRequired {
  const payment = settledPayment(fixture);
  return {
    x402Version: 2,
    error: "Payment required",
    resource: payment.payload.resource ?? { url: fixture.url ?? "https://api.example.com/weather" },
    accepts: [payment.requirements],
    ...(payment.payload.extensions === undefined ? {} : { extensions: payment.payload.extensions }),
  };
}

function extensionFor(fixture: PaymentFixture): unknown {
  if (fixture.kind === "mcp") {
    const { bazaar } = declareDiscoveryExtension({
      toolName: fixture.toolName ?? "forecast",
      description: "Forecast tool",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      example: { city: "Istanbul" },
    });
    return bazaar;
  }
  const { bazaar } = declareDiscoveryExtension({
    input: { city: "Istanbul" },
    inputSchema: { properties: { city: { type: "string", description: "City name" } }, required: ["city"] },
    output: { example: { temperature: 21 } },
  });
  // What the bazaar server extension adds at request time.
  const enriched = bazaar as unknown as { info: { input: Record<string, unknown> } } & Record<
    string,
    unknown
  >;
  enriched.info.input["method"] = fixture.method ?? "GET";
  if (fixture.routeTemplate !== undefined) enriched["routeTemplate"] = fixture.routeTemplate;
  if (fixture.pathParams !== undefined) {
    enriched.info.input["pathParams"] = fixture.pathParams;
    // As the bazaar server extension does, the schema then allows the path parameters.
    const schema = enriched["schema"] as {
      properties?: { input?: { properties?: Record<string, unknown> } };
    };
    const input = schema.properties?.input;
    if (input !== undefined) input.properties = { ...input.properties, pathParams: { type: "object" } };
  }
  return enriched;
}
