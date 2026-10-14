import { describe, expectTypeOf, it } from "vitest";
import type { PaymentEvent } from "@rail402.dev/sdk";
import type { ToolName as McpToolName } from "@rail402.dev/mcp";
import type { SdkPaymentEvent, ToolName, Trust } from "../web/src/engine/events.ts";

describe("engine event contract", () => {
  it("mirrors the SDK's payment events exactly", () => {
    expectTypeOf<SdkPaymentEvent>().toEqualTypeOf<PaymentEvent>();
  });

  it("names the rail402-mcp tools and the catalog trust levels", () => {
    expectTypeOf<ToolName>().toEqualTypeOf<McpToolName>();
    expectTypeOf<Trust>().toEqualTypeOf<"settled" | "origin_verified" | "domain_verified">();
  });
});
