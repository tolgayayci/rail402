/** Builders for the public views the Bazaar fixtures carry, with fixture defaults. */
import type { ListingField, ListingView, OptionView, RequiredView } from "../../src/engine/events.ts";
import { IDS } from "./ids.ts";

export function option(overrides: Partial<OptionView> = {}): OptionView {
  return {
    index: 0,
    scheme: "exact",
    network: "stellar:testnet",
    asset: IDS.usdc,
    symbol: "USDC",
    decimals: 7,
    amount: "10000",
    decimal: "0.001",
    payTo: IDS.demoPayTo,
    maxTimeoutSeconds: 60,
    feesSponsored: true,
    facilitatorAddress: null,
    facilitatorAddressAdvertised: null,
    verdict: { acceptable: true, code: null, reason: null },
    ...overrides,
  };
}

export function required(
  url: string,
  options: readonly OptionView[],
  overrides: Partial<RequiredView> = {},
): RequiredView {
  return {
    x402Version: 2,
    resource: { url, description: null, mimeType: "application/json" },
    error: null,
    options,
    bazaar: { declared: false, type: null, method: null, toolName: null },
    ...overrides,
  };
}

export function field(overrides: Partial<ListingField> & Pick<ListingField, "name" | "in">): ListingField {
  return {
    kind: "string",
    required: false,
    description: null,
    example: null,
    options: null,
    ...overrides,
  };
}

export function listing(overrides: Partial<ListingView> & Pick<ListingView, "id" | "resource">): ListingView {
  return {
    type: "http",
    method: "GET",
    toolName: null,
    description: null,
    serviceName: "Rail402 demo seller",
    owner: IDS.demoPayTo,
    network: "stellar:testnet",
    trust: "domain_verified",
    state: "published",
    version: 3,
    settlements: 42,
    price: { scheme: "exact", amount: "10000", decimal: "0.001", symbol: "USDC" },
    callable: true,
    rank: null,
    ...overrides,
  };
}
