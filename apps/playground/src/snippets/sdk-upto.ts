// Code-panel snippet: paying a metered (upto) HTTP route from the buyer SDK. Shown on the page (as raw
// text, with `{{…}}` filled from the configuration), type-checked here, never run.
import { createBuyer } from "@rail402.dev/sdk"; // @hide

const buyer = await createBuyer({
  network: "stellar:testnet",
  signer: { secretFile: "~/.config/rail402/keys/stellar-testnet.key" }, // @step:sign
});

const paid = await buyer.pay(
  { kind: "http", url: "{{demoSeller}}/history", query: { city: "Berlin", days: "7" } }, // @step:request,quote,paid-request
  { maxAmount: { amount: "{{cap}}", asset: "{{asset}}" } }, // @step:sign,overcharge-refused
);

const history = paid.response; // seven days of history // @step:work,deliver
const charged = paid.payment?.settled?.amount; // what the seller settled, at most the cap // @step:settle,submit
export { history, charged }; // @hide
