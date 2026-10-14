/**
 * Railway infrastructure for a Rail402 testnet facilitator: Postgres and the service built from the
 * Dockerfile. `deploy/railway.sh` applies it to a new project; `railway config plan` and
 * `railway config apply` compare and apply it to an existing one.
 *
 * Variables the service reads but this file cannot know are declared with `preserve()`, which keeps
 * the value already set in the environment. `railway config apply` deletes any variable not declared
 * here, so every variable the service reads is listed, apart from the few a test names with a reason.
 */
import { defineRailway, postgres, preserve, service } from "railway/iac";

// Stellar's public testnet RPC and Horizon run in AWS us-east-1, and every verification calls them
// several times: the service and its database belong next to them.
const REGION = "us-east4-eqdc4a";

export default defineRailway((ctx, project) => {
  const db = postgres("Postgres", { region: REGION });
  const rail402 = service("rail402", {
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      // A deployment receives traffic once the database, RPC, sponsor, channels and search index are ready.
      healthcheckPath: "/ready",
      healthcheckTimeout: 300,
      // Railway's default restart policy applies: restart on failure, up to 10 times.
      overlapSeconds: 30,
      // Longer than the service's own 30-second grace for in-flight settlements.
      drainingSeconds: 40,
      multiRegionConfig: { [REGION]: { numReplicas: 1 } },
    },
    variables: {
      DATABASE_URL: db.env.DATABASE_URL,
      NETWORKS: "stellar:testnet",
      TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
      // Railway's edge proxy sets X-Forwarded-For.
      TRUSTED_PROXY_HOPS: "1",
      TESTNET_SPONSOR_SECRET: preserve(),
      SEARCH_CURSOR_SECRET: preserve(),
      TESTNET_CHANNEL_COUNT: preserve(),
      RAIL402_VERSION: preserve(),
      // Circle's testnet USDC and the 6-decimal TEST6 token (contracts/testing/deployments), so the
      // hosted service is tested with two assets of different decimals.
      TESTNET_ASSETS:
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA:USDC:7,CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK:TEST6:6",
      // The hosted testnet is keyless, so the sponsor's hourly spend is bounded: settlements are refused
      // (settle_*_sponsor_unavailable) once 100 XLM of fees was committed in the last hour.
      TESTNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "100",
      // Kept when an operator set them: the exact fee ceiling and the /metrics bearer token's digest.
      TESTNET_MAX_TX_FEE_STROOPS: preserve(),
      METRICS_TOKEN_SHA256: preserve(),
      // upto on testnet: the canonical settlement contract, zero settlements on chain, and the keeper
      // keeping the contract live. The service creates the settlement authority at startup.
      TESTNET_UPTO_ENABLED: "true",
      TESTNET_UPTO_ZERO_SETTLEMENT: "onchain",
      TESTNET_UPTO_TTL_KEEPER: "true",
      // Unset means the canonical contract and the documented defaults; kept when an operator set them.
      TESTNET_UPTO_CONTRACT: preserve(),
      TESTNET_UPTO_WASM_HASH: preserve(),
      TESTNET_UPTO_MAX_TX_FEE_STROOPS: preserve(),
      TESTNET_UPTO_TTL_EXTEND_BELOW_LEDGERS: preserve(),
      TESTNET_UPTO_TTL_EXTEND_TO_LEDGERS: preserve(),
      TESTNET_UPTO_TTL_AUTO_RESTORE: preserve(),
      TESTNET_UPTO_TTL_MAX_FEE_STROOPS: preserve(),
      TESTNET_UPTO_LEDGER_SECONDS: preserve(),
      // Every other setting the service reads keeps the value an operator set, and unset means its
      // documented default. The few it does not manage are listed in apps/rail402/test/railway-file.test.ts.
      LOG_LEVEL: preserve(),
      BODY_LIMIT_BYTES: preserve(),
      RATE_LIMIT_PER_MINUTE: preserve(),
      API_KEY_SHA256: preserve(),
      SHUTDOWN_GRACE_MS: preserve(),
      RECONCILE_INTERVAL_MS: preserve(),
      SETTLE_CHANNEL_WAIT_MS: preserve(),
      SETTLE_CONFIRM_TIMEOUT_MS: preserve(),
      SETTLE_RECONCILE_IDLE_MS: preserve(),
      RECONCILE_THIRD_PARTY_SETTLEMENTS: preserve(),
      CONTRACT_TTL_POLL_MS: preserve(),
      CONTRACT_TTL_WARN_LEDGERS: preserve(),
      CONTRACT_TTL_CRITICAL_LEDGERS: preserve(),
      SERVICE_FEE_PER_SETTLEMENT_USD: preserve(),
      BAZAAR_ENABLED: preserve(),
      BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: preserve(),
      BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: preserve(),
      BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: preserve(),
      ORIGIN_CHECK_INTERVAL_MS: preserve(),
      SEARCH_EMBEDDINGS: preserve(),
      SEARCH_SIMILARITY_FLOOR: preserve(),
      TESTNET_INCLUSION_FEE_STROOPS: preserve(),
      TESTNET_INCLUSION_FEE_CAP_STROOPS: preserve(),
      TESTNET_INCLUSION_FEE_PERCENTILE: preserve(),
      TESTNET_EXPIRATION_MARGIN_LEDGERS: preserve(),
      TESTNET_TIMEOUT_MIN_SECONDS: preserve(),
      TESTNET_TIMEOUT_MAX_SECONDS: preserve(),
      TESTNET_MIN_SPONSOR_BALANCE_XLM: preserve(),
      TESTNET_SPONSOR_RESERVE_XLM: preserve(),
      TESTNET_REQUIRE_API_KEY: preserve(),
      TESTNET_AUTO_PROVISION_CHANNELS: preserve(),
      TESTNET_TTL_CONTRACTS: preserve(),
    },
  });
  return project(ctx.projectName ?? "rail402", { resources: [db, rail402] });
});
