/**
 * Railway infrastructure for the Rail402 Playground: one stateless service built from
 * apps/playground/Dockerfile, in its own project. `deploy/playground.sh` applies it to a new project;
 * `railway config plan --file .railway/playground.ts` and `railway config apply --file …` compare and
 * apply it to an existing one.
 *
 * The Playground holds no secret and no database. Variables the service reads but this file cannot
 * know (the account lab sellers are paid to, the commit) are declared with `preserve()`, which keeps
 * the value already set in the environment. `railway config apply` deletes any variable not declared
 * here, so every variable the service reads is listed, apart from the few a test names with a reason.
 */
import { defineRailway, preserve, service } from "railway/iac";

// Next to Rail402 and the Stellar testnet RPC and Horizon (AWS us-east-1), which every run calls.
const REGION = "us-east4-eqdc4a";

export default defineRailway((ctx, project) => {
  const playground = service("playground", {
    build: { builder: "DOCKERFILE", dockerfilePath: "apps/playground/Dockerfile" },
    deploy: {
      // Traffic arrives once the page is built and the facilitator answers /supported.
      healthcheckPath: "/ready",
      healthcheckTimeout: 120,
      overlapSeconds: 20,
      // Relayed requests and event streams may run for minutes; the server stops waiting after 10 s.
      drainingSeconds: 15,
      // One replica: the abuse limits are in memory and per process.
      multiRegionConfig: { [REGION]: { numReplicas: 1 } },
    },
    variables: {
      PUBLIC_URL: "https://playground.rail402.dev",
      PLAYGROUND_MODE: "hosted",
      NETWORK: "stellar:testnet",
      // Railway's edge proxy sets X-Forwarded-For.
      TRUSTED_PROXY_HOPS: "1",
      FACILITATOR_URL: "https://testnet.rail402.dev",
      BAZAAR_URL: "https://testnet.rail402.dev",
      DEMO_SELLER_URL: "https://demo.rail402.dev",
      DOCS_URL: "https://docs.rail402.dev",
      // The operator's testnet account lab sellers are paid to (a public G… address; its secret stays
      // with the operator), and the deployed commit.
      PLAYGROUND_PAY_TO: preserve(),
      RAIL402_COMMIT: preserve(),
      RAIL402_VERSION: preserve(),
      // Every other setting keeps the value an operator set, and unset means its documented default:
      // the SDF testnet endpoints, Circle's testnet USDC, the canonical upto contract, the limits.
      RPC_URL: preserve(),
      HORIZON_URL: preserve(),
      FRIENDBOT_URL: preserve(),
      ASSET_CONTRACT: preserve(),
      ASSET_SYMBOL: preserve(),
      ASSET_DECIMALS: preserve(),
      ASSET_CLASSIC: preserve(),
      UPTO_CONTRACT: preserve(),
      EXPLORER_TEMPLATE: preserve(),
      FAUCET_URL: preserve(),
      RELAY_ENABLED: preserve(),
      LAB_ENABLED: preserve(),
      SELLER_CHECK_ENABLED: preserve(),
      RELAY_DENY_HOSTS: preserve(),
      RELAY_TRUSTED_HOSTS: preserve(),
      RELAY_UNPAID_PER_MINUTE: preserve(),
      RELAY_UNPAID_BURST: preserve(),
      RELAY_UNPAID_PER_NETWORK_PER_MINUTE: preserve(),
      RELAY_PAID_PER_MINUTE: preserve(),
      RELAY_PAID_GLOBAL_PER_MINUTE: preserve(),
      RELAY_TRUSTED_PAID_GLOBAL_PER_MINUTE: preserve(),
      RELAY_IN_FLIGHT_PER_IP: preserve(),
      RELAY_IN_FLIGHT_GLOBAL: preserve(),
      RELAY_IN_FLIGHT_PER_HOST: preserve(),
      RELAY_STREAMS_PER_IP: preserve(),
      RELAY_STREAM_MAX_MS: preserve(),
      RELAY_HOST_PER_MINUTE: preserve(),
      RELAY_TRUSTED_HOST_PER_MINUTE: preserve(),
      RELAY_BYTES_PER_IP_PER_DAY: preserve(),
      RELAY_BYTES_PER_NETWORK_PER_DAY: preserve(),
      RELAY_BYTES_GLOBAL_PER_DAY: preserve(),
      SELLER_CHECK_PER_MINUTE: preserve(),
      SELLER_CHECK_GLOBAL_PER_MINUTE: preserve(),
      PROXY_PER_MINUTE: preserve(),
      PROXY_GLOBAL_PER_MINUTE: preserve(),
      LAB_UNPAID_PER_MINUTE: preserve(),
      LAB_PAID_PER_MINUTE: preserve(),
      LAB_PAID_GLOBAL_PER_MINUTE: preserve(),
      LOG_LEVEL: preserve(),
      METRICS_TOKEN_SHA256: preserve(),
    },
  });
  return project(ctx.projectName ?? "rail402-playground", { resources: [playground] });
});
