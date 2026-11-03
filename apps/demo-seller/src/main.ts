import { HTTPFacilitatorClient } from "@x402/core/server";
import { sellerConfig, type DemoSellerConfig } from "./config.ts";
import { DEFAULT_FACILITATOR_URL, createSeller } from "./seller.ts";

let config: DemoSellerConfig;
try {
  config = sellerConfig(process.env);
} catch (error) {
  process.stderr.write(`demo-seller: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(78); // EX_CONFIG
}

const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR_URL;
createSeller({
  payTo: config.payTo,
  network: config.network,
  trustProxy: config.trustProxy,
  metered: config.metered,
  paidLimits: config.paidLimits,
  facilitator: new HTTPFacilitatorClient({ url: facilitatorUrl }),
  facilitatorUrl,
  ...(config.asset === undefined ? {} : { asset: config.asset }),
  ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
}).listen(config.port, () => {
  process.stdout.write(
    `demo-seller listening on ${String(config.port)} (${config.network}), paying ${config.payTo} through ${facilitatorUrl}\n`,
  );
});
