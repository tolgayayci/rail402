// Code-panel snippet: paying a fixed-price HTTP route from the buyer SDK. Shown on the page (as raw
// text, with `{{…}}` filled from the configuration), type-checked here, never run.
import { createBuyer } from "@rail402.dev/sdk"; // @hide

const buyer = await createBuyer({
  network: "stellar:testnet",
  signer: { secretFile: "~/.config/rail402/keys/stellar-testnet.key" }, // @step:sign
});

const paid = await buyer.pay(
  { kind: "http", url: "{{demoSeller}}/weather", query: { city: "Ankara" } }, // @step:request,quote,paid-request
  {
    maxAmount: { amount: "{{cap}}", asset: "{{asset}}" }, // @step:refused,sign
    // A retry with the same key returns the first result: nothing is signed or paid again.
    idempotencyKey: "weather-ankara-1", // @step:charged-once
  },
);
// A copy of the signed payment sent again is refused by the facilitator: its nonce is already
// used, whether or not the buyer uses a key. // @step:resend,replay-refused

const weather = paid.response; // the data, sent once the payment settled // @step:deliver
const receipt = paid.payment?.transaction; // checked on chain before pay() returns // @step:settle,submit
const proof = paid.payment?.explorerUrl; // @step:submit
export { weather, receipt, proof }; // @hide
