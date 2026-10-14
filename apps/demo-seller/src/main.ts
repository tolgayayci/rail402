import { StrKey } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createSeller } from "./seller.ts";

const payTo = process.env["PAY_TO"] ?? "";
if (!StrKey.isValidEd25519PublicKey(payTo) && !StrKey.isValidContract(payTo)) {
  process.stderr.write("demo-seller: PAY_TO must be a Stellar G… account or C… contract\n");
  process.exit(78); // EX_CONFIG
}
const facilitatorUrl = process.env["FACILITATOR_URL"] ?? "https://testnet.rail402.dev";
// The public origin the MCP tools are declared at; each request's scheme and host otherwise.
const publicUrl = process.env["PUBLIC_URL"]?.trim() || undefined;
if (publicUrl !== undefined && !/^https?:\/\/[^/?#]+\/?$/.test(publicUrl)) {
  process.stderr.write("demo-seller: PUBLIC_URL must be an origin such as https://demo.rail402.dev\n");
  process.exit(78); // EX_CONFIG
}
// The metered upto route and tool need a facilitator that serves upto; METERED=false leaves them out.
const meteredSetting = (process.env["METERED"] ?? "true").trim().toLowerCase();
if (meteredSetting !== "true" && meteredSetting !== "false") {
  process.stderr.write("demo-seller: METERED must be true or false\n");
  process.exit(78); // EX_CONFIG
}
const port = Number(process.env["PORT"] ?? "8080");
const trustProxy = Number(process.env["TRUST_PROXY_HOPS"] ?? "0");

createSeller({
  payTo,
  trustProxy,
  metered: meteredSetting === "true",
  facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl }),
  ...(publicUrl === undefined ? {} : { publicUrl }),
}).listen(port, () => {
  process.stdout.write(
    `demo-seller listening on ${String(port)}, paying ${payTo} through ${facilitatorUrl}\n`,
  );
});
