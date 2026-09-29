import { StrKey } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createSeller } from "./seller.ts";

const payTo = process.env["PAY_TO"] ?? "";
if (
  !StrKey.isValidEd25519PublicKey(payTo) &&
  !StrKey.isValidContract(payTo) &&
  !StrKey.isValidMed25519PublicKey(payTo)
) {
  process.stderr.write("demo-seller: PAY_TO must be a Stellar G…, C… or M… address\n");
  process.exit(78); // EX_CONFIG
}
const facilitatorUrl = process.env["FACILITATOR_URL"] ?? "https://testnet.rail402.dev";
const port = Number(process.env["PORT"] ?? "8080");
const trustProxy = Number(process.env["TRUST_PROXY_HOPS"] ?? "0");

createSeller({ payTo, trustProxy, facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl }) }).listen(
  port,
  () => {
    process.stdout.write(
      `demo-seller listening on ${String(port)}, paying ${payTo} through ${facilitatorUrl}\n`,
    );
  },
);
