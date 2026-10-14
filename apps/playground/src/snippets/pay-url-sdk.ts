// Code-panel snippet: paying any HTTP URL from the buyer SDK, as the Pay page does. Shown on the page
// (as raw text, with `{{…}}` filled in), type-checked here, never run.
import { createBuyer } from "@rail402.dev/sdk"; // @hide

const buyer = await createBuyer({
  network: "stellar:testnet",
  signer: { secretFile: "~/.config/rail402/keys/stellar-testnet.key" },
});

const paid = await buyer.pay(
  { kind: "http", url: "{{url}}" },
  { maxAmount: { amount: "{{cap}}", asset: "{{asset}}" } },
);

const transaction = paid.payment?.transaction; // the settlement, checked on chain
const explorer = paid.payment?.explorerUrl;
export { transaction, explorer }; // @hide
