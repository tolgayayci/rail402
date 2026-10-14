import { describe, expect, it } from "vitest";
import { SETTLEMENT_OVERRIDES_HEADER, type SettlementOverrides } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { isRail402Error } from "@rail402.dev/errors";
import { TESTNET } from "@rail402.dev/stellar";
import {
  UPTO_CHARGE_META_KEY,
  UptoStellarServerScheme,
  chargeUpto,
  meteredToolServer,
  setUptoCharge,
} from "@rail402.dev/sdk/seller";

const requirements = (scheme: string): PaymentRequirements => ({
  scheme,
  network: TESTNET,
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  amount: "1000000",
  payTo: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  maxTimeoutSeconds: 60,
  extra: {},
});

/** A resource server stand-in that records the overrides each settlement receives. */
class RecordingServer {
  readonly overrides: (SettlementOverrides | undefined)[] = [];
  readonly label = "recording";

  settlePayment(
    _payload: PaymentPayload,
    _requirements: PaymentRequirements,
    _extensions?: Record<string, unknown>,
    _context?: unknown,
    overrides?: SettlementOverrides,
  ): Promise<SettleResponse> {
    this.overrides.push(overrides);
    return Promise.resolve({ success: true, transaction: "", network: TESTNET, payer: "" });
  }

  describe(): string {
    return this.label;
  }
}

const code = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return isRail402Error(error) ? error.code : "other";
  }
  return undefined;
};

describe("upto seller helpers", () => {
  it("sets the settlement override header an HTTP route charges", () => {
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    };
    setUptoCharge(response, 2_500n);
    expect(headers[SETTLEMENT_OVERRIDES_HEADER]).toBe('{"amount":"2500"}');
    setUptoCharge(response, "25%");
    expect(headers[SETTLEMENT_OVERRIDES_HEADER]).toBe('{"amount":"25%"}');
    setUptoCharge(response, 0);
    expect(headers[SETTLEMENT_OVERRIDES_HEADER]).toBe('{"amount":"0"}');
    for (const bad of [-1, 1.5, "150%", "0.5", "ten"]) {
      expect(
        code(() => {
          setUptoCharge(response, bad);
        }),
      ).toBe("seller_declaration_invalid");
    }
  });

  it("settles a metered MCP tool for what its handler charged, and hides the charge", async () => {
    const server = new RecordingServer();
    const metered = meteredToolServer(server);
    expect(metered.describe()).toBe("recording");

    const result = chargeUpto({ content: [{ type: "text", text: "ok" }] }, 1_234n);
    expect(result._meta).toEqual({ [UPTO_CHARGE_META_KEY]: "1234" });
    const context = { toolName: "forecast", result };
    const payload = {} as PaymentPayload;
    await metered.settlePayment(payload, requirements("upto"), {}, context);
    expect(server.overrides.at(-1)).toEqual({ amount: "1234" });
    expect(result._meta).toEqual({});

    // Without a charge, and for exact tools, nothing is overridden (the stock behaviour).
    await metered.settlePayment(payload, requirements("upto"), {}, { toolName: "forecast", result: {} });
    expect(server.overrides.at(-1)).toBeUndefined();
    const exact = { toolName: "forecast", result: chargeUpto({}, 5) };
    await metered.settlePayment(payload, requirements("exact"), {}, exact);
    expect(server.overrides.at(-1)).toBeUndefined();
    // An explicit override wins.
    await metered.settlePayment(payload, requirements("upto"), {}, context, { amount: "7" });
    expect(server.overrides.at(-1)).toEqual({ amount: "7" });

    expect(code(() => meteredToolServer({}))).toBe("seller_declaration_invalid");
  });

  it("exports the upto server scheme for the resource server", () => {
    expect(new UptoStellarServerScheme().scheme).toBe("upto");
  });
});
