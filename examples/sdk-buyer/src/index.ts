/**
 * Pays one x402 resource by URL, then searches the Bazaar and pays the best match, on the Stellar
 * testnet under the default spending caps (0.10 USDC per call, 1.00 USDC per day). Configure it like
 * the rail402 CLI, through RAIL402_* variables; RAIL402_SECRET_KEY_FILE names the payer's key file.
 *
 *   node src/index.ts [url] [query]
 */
import { createBuyer, egressFromConfig, parseMoney, resolveAgentConfig } from "@rail402.dev/sdk";

const url = process.argv[2] ?? "https://demo.rail402.dev/weather?city=Ankara";
const query = process.argv[3] ?? "current weather for a city";
const maxAmount = parseMoney(process.env["MAX_AMOUNT"] ?? "0.01 USDC");
if (maxAmount === undefined) throw new Error('MAX_AMOUNT is an amount and an asset, e.g. "0.01 USDC"');

const config = resolveAgentConfig(process.env);
const buyer = await createBuyer({
  network: config.network,
  rpcUrl: config.rpcUrl,
  bazaarUrl: config.bazaarUrl,
  facilitatorUrl: config.bazaarUrl,
  policy: config.policy,
  egress: egressFromConfig(config),
  ...(config.key === undefined ? {} : { signer: config.key }),
});

try {
  // 1. A resource you already know: pay it by URL, never more than maxAmount.
  const direct = await buyer.pay({ kind: "http", url }, { maxAmount });
  console.log(
    JSON.stringify({ step: "pay", paid: direct.paid, payment: direct.payment, response: direct.response }),
  );

  // 2. A resource you describe: search the Bazaar and pay the first callable, in-policy result
  //    through its listing, which binds the payment to the listing's owner.
  const found = await buyer.searchAndPay(query, { maxAmount, call: { query: { city: "Istanbul" } } });
  console.log(
    JSON.stringify({
      step: "searchAndPay",
      listingId: found.chosen.listingId,
      resource: found.chosen.resource,
      payment: found.payment,
      response: found.response,
    }),
  );
  console.log(JSON.stringify({ step: "budget", budget: await buyer.budget() }));
} finally {
  await buyer.close();
}
