import { httpCodes, mergeCodes, type CodeSet } from "@rail402.dev/errors";
import { exactStellarCodes, uptoStellarCodes } from "@rail402.dev/stellar";
import { bazaarCodes } from "@rail402.dev/bazaar";
import { searchCodes } from "@rail402.dev/search";

/**
 * Every code the Rail402 service can return, from every surface, in one set. Merging refuses a code
 * defined twice, so importing this module fails at startup if two surfaces ever claim the same code.
 */
export const allCodes = mergeCodes(httpCodes, exactStellarCodes, uptoStellarCodes, bazaarCodes, searchCodes);

export type Rail402Code = keyof typeof allCodes;

export function isRail402Code(value: unknown): value is Rail402Code {
  return typeof value === "string" && Object.hasOwn(allCodes, value);
}

/** One documented group of codes: where they appear and what they mean there. */
export interface CodeGroup {
  /** Anchor on the error-code reference page. */
  readonly id: string;
  readonly title: string;
  /** The exported code set the group's codes come from. */
  readonly set: string;
  readonly package: string;
  /** Where these codes appear on the wire, in one or two sentences. */
  readonly where: string;
  readonly codes: CodeSet;
}

function pick(set: CodeSet, keep: (code: string) => boolean): CodeSet {
  return Object.fromEntries(Object.entries(set).filter(([code]) => keep(code)));
}

const isDiscovery = (code: string) => code.startsWith("discovery_");

/** The code sets of every surface, grouped as the error-code reference documents them. */
export const codeGroups: readonly CodeGroup[] = [
  {
    id: "http",
    title: "HTTP transport",
    set: "httpCodes",
    package: "@rail402.dev/errors",
    where:
      "Returned with the listed HTTP status in `error.code` on every endpoint. On `/verify` and `/settle` the body also keeps the x402 response shape, with the code in `invalidReason` or `errorReason`.",
    codes: httpCodes,
  },
  {
    id: "exact-stellar",
    title: "Verification and settlement (`exact` on Stellar)",
    set: "exactStellarCodes",
    package: "@rail402.dev/stellar",
    where:
      "Returned by `/verify` in `invalidReason` (with `isValid: false`) and by `/settle` in `errorReason` (with `success: false`), always with HTTP 200 as the x402 specification requires. The status applies only when a code is carried by a transport-level error.",
    codes: exactStellarCodes,
  },
  {
    id: "upto-stellar",
    title: "Verification and settlement (`upto` on Stellar)",
    set: "uptoStellarCodes",
    package: "@rail402.dev/stellar",
    where:
      "Returned by `/verify` in `invalidReason` and by `/settle` in `errorReason` for `upto` payments, with HTTP 200 like every verification and settlement outcome. An `upto` payment also returns the x402 standard codes listed under `exact`, such as `insufficient_funds` and `settlement_pending`.",
    codes: uptoStellarCodes,
  },
  {
    id: "bazaar",
    title: "Bazaar cataloging",
    set: "bazaarCodes",
    package: "@rail402.dev/bazaar",
    where:
      "Reported to the seller in the `EXTENSION-RESPONSES` header of `/verify` and `/settle` under the `bazaar` key, with `status: rejected` and the reason in `rejectedReason`. A cataloging rejection never affects the payment.",
    codes: pick(bazaarCodes, (code) => !isDiscovery(code)),
  },
  {
    id: "discovery",
    title: "Discovery API",
    set: "bazaarCodes",
    package: "@rail402.dev/bazaar",
    where:
      "Returned with the listed HTTP status in `error.code` by `GET /discovery/resources` and its detail routes, and for a malformed parameter of `GET /discovery/search`.",
    codes: pick(bazaarCodes, isDiscovery),
  },
  {
    id: "search",
    title: "Search API",
    set: "searchCodes",
    package: "@rail402.dev/search",
    where: "Returned with the listed HTTP status in `error.code` by `GET /discovery/search`.",
    codes: searchCodes,
  },
];
