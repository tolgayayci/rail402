import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

export const NETWORK = "stellar:testnet" as const;
/** The upto settlement authority the fake facilitator advertises. */
export const AUTHORITY = "GCQUNBNRBOHSD2BQRX6NUDJEQXUCNLYGJKPYB5TDKTL2QGTZDRS3OJMS";
export const PAYER = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";
export const TRANSACTION = "a".repeat(64);

export interface FakeCall {
  readonly operation: "verify" | "settle";
  readonly requirements: PaymentRequirements;
}

export interface FakeFacilitator extends FacilitatorClient {
  readonly calls: FakeCall[];
  supportedCalls: number;
}

export interface FakeBehaviour {
  /** Serves upto on the testnet (true by default). */
  readonly upto?: boolean;
  readonly supported?: () => Promise<SupportedResponse>;
  readonly verify?: (requirements: PaymentRequirements) => Promise<VerifyResponse>;
  readonly settle?: (requirements: PaymentRequirements) => Promise<SettleResponse>;
}

/**
 * A facilitator for lab seller tests: supports testnet exact (and upto), accepts every payment and
 * settles it, unless a behaviour says otherwise. Records what it was asked, never the payload.
 */
export function fakeFacilitator(behaviour: FakeBehaviour = {}): FakeFacilitator {
  const calls: FakeCall[] = [];
  const fake: FakeFacilitator = {
    calls,
    supportedCalls: 0,
    getSupported: () => {
      fake.supportedCalls += 1;
      if (behaviour.supported !== undefined) return behaviour.supported();
      return Promise.resolve({
        kinds: [
          { x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } },
          ...(behaviour.upto === false
            ? []
            : [
                {
                  x402Version: 2,
                  scheme: "upto",
                  network: NETWORK,
                  extra: { areFeesSponsored: true, facilitatorAddress: AUTHORITY },
                },
              ]),
        ],
        extensions: ["bazaar"],
        signers: {},
      } as SupportedResponse);
    },
    verify: (_payload: PaymentPayload, requirements: PaymentRequirements) => {
      calls.push({ operation: "verify", requirements });
      return behaviour.verify?.(requirements) ?? Promise.resolve({ isValid: true, payer: PAYER });
    },
    settle: (_payload: PaymentPayload, requirements: PaymentRequirements) => {
      calls.push({ operation: "settle", requirements });
      return (
        behaviour.settle?.(requirements) ??
        Promise.resolve({
          success: true,
          transaction: TRANSACTION,
          network: NETWORK,
          payer: PAYER,
          amount: requirements.amount,
        })
      );
    },
  };
  return fake;
}

/** The PAYMENT-REQUIRED of a 402, decoded. */
export function requiredOf(response: Response): PaymentRequired {
  return decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
}

/**
 * A PAYMENT-SIGNATURE for the first option of a 402. Its transaction is opaque text: the fake
 * facilitator never looks at it.
 */
export function paymentFor(required: PaymentRequired, transaction = "AAAAAgAAAAB-payment-canary"): string {
  const [accepted] = required.accepts;
  if (accepted === undefined) throw new Error("the 402 offers nothing");
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { transaction },
  });
}
