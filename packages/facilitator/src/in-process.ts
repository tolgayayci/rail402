import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import type { StellarFacilitator } from "./facilitator.ts";

/**
 * A FacilitatorClient that calls the facilitator in the same process, for self-facilitation inside
 * a resource server: `new x402ResourceServer(inProcessClient(createStellarFacilitator(...)))`.
 * Verification and settlement behave exactly as over HTTP, without the network hop.
 */
export function inProcessClient(facilitator: StellarFacilitator): FacilitatorClient {
  return {
    verify: (payload, requirements) => facilitator.core.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.core.settle(payload, requirements),
    // x402Facilitator types `network` as string; SupportedResponse narrows it to CAIP-2. Same values.
    getSupported: () => Promise.resolve(facilitator.core.getSupported() as SupportedResponse),
  };
}
