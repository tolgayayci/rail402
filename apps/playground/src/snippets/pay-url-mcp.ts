// Code-panel snippet: the same payment as an agent's rail402-mcp tool call. Shown on the page (with
// `{{…}}` filled in), type-checked here, never run.
import type { z } from "zod"; // @hide
import type { payInput } from "@rail402.dev/mcp"; // @hide
declare function pay_and_call(input: z.input<typeof payInput>): void; // @hide

pay_and_call({
  resource: "{{url}}",
  spendingCap: { amount: "{{cap}}", asset: "{{asset}}" },
});
