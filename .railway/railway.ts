/**
 * Railway infrastructure for a Rail402 testnet facilitator: Postgres and the service built from the
 * Dockerfile. `deploy/railway.sh` applies it to a new project; `railway config plan` and
 * `railway config apply` compare and apply it to an existing one.
 *
 * Variables the service reads but this file cannot know are declared with `preserve()`, which keeps
 * the value already set in the environment. `railway config apply` deletes any variable not declared
 * here, so every variable the service uses is listed.
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
    },
  });
  return project(ctx.projectName ?? "rail402", { resources: [db, rail402] });
});
