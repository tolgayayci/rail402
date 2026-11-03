/**
 * The service image, self-hosted with no way to reach Rail402's hosted service: the container runs on
 * an internal Docker network (no route to the internet), every `rail402.dev` host it might name resolves
 * to 0.0.0.0, and its only peers are its own Postgres and a relay to the private Stellar network's RPC.
 *
 * - Preflight (`node dist/check-config.js`) exits 78 with the documented code for each missing required
 *   setting: sponsor seed, RPC, pubnet assets, pubnet fee ceiling, the upto contract.
 * - Configured with access keys, request limits, per-key sponsor budgets, an accepted asset and a
 *   service fee, it settles `exact` and `upto`, refuses a request without a key (401), past a key's
 *   request limit (429), in another token, and past a key's sponsor budget; `/usage` shows the fee.
 *
 * Opt-in: set `RAIL402_IMAGE` to the image to test (e.g. `docker build -t rail402:selfhost .`), with
 * `docker compose --profile stellar up -d` running. `RAIL402_STELLAR_CONTAINER` names the quickstart
 * container (default `rail402-stellar-1`).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { deriveAuthorityKeypair } from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  deployUpto,
  dockerAvailable,
  requirementsFor,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { COLD_SIGNER } from "./secret-fixtures.ts";
import { accountPayer, uptoPayment, uptoRequirements, withAmount } from "./upto-harness.ts";

const run = promisify(execFile);
const IMAGE = process.env["RAIL402_IMAGE"] ?? "";
const STELLAR = process.env["RAIL402_STELLAR_CONTAINER"] ?? "rail402-stellar-1";
const POSTGRES_IMAGE = "postgres:18.6-alpine";
const net = new LocalNetwork();
const enabled = IMAGE !== "" && (await dockerAvailable()) && (await net.available());

/** Every Rail402 host the service could name, answered with an address nothing listens on. */
const BLACKHOLED = [
  "rail402.dev",
  "www.rail402.dev",
  "testnet.rail402.dev",
  "mainnet.rail402.dev",
  "pubnet.rail402.dev",
  "demo.rail402.dev",
  "docs.rail402.dev",
  "playground.rail402.dev",
  "explorer.rail402.dev",
  "status.rail402.dev",
  "mcp.rail402.dev",
];
const ADD_HOSTS = BLACKHOLED.flatMap((host) => ["--add-host", `${host}:0.0.0.0`]);

/** A TCP relay, run with the image's own Node: `[listenPort, host, port]` routes from `ROUTES`. */
const RELAY = `
const net = require("node:net");
for (const [listen, host, port] of JSON.parse(process.env.ROUTES)) {
  net.createServer((client) => {
    const upstream = net.connect(port, host);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  }).listen(listen, "0.0.0.0");
}
`;

const docker = async (...args: string[]) =>
  (await run("docker", args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

const env = (values: Record<string, string>) =>
  Object.entries(values).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** An access key in the service's format, `r402_<id>_<secret>`. */
const accessKey = (keyId: string) => `r402_${keyId}_${randomBytes(32).toString("base64url")}`;
const ACCESS_KEY = accessKey("acme-1");
const TIGHT_KEY = accessKey("tight-1");
const BURST_KEY = accessKey("burst-1");
const SERVICE_FEE_USD = "0.01";
const RATE_LIMIT = 60;

describe.skipIf(!enabled)("the service image, self-hosted without Rail402's hosted service", () => {
  const id = randomBytes(4).toString("hex");
  const internal = `rail402-selfhost-${id}`;
  const names = {
    postgres: `rail402-selfhost-pg-${id}`,
    relay: `rail402-selfhost-relay-${id}`,
    service: `rail402-selfhost-svc-${id}`,
  };
  const directory = mkdtempSync(join(tmpdir(), "rail402-selfhost-"));
  let base: string;
  let usdc: IssuedAsset;
  let eurc: IssuedAsset;
  let seller: Keypair;
  let sponsor: Keypair;
  let contract: LocalUptoContract;

  /** Runs the preflight inside the internal network; resolves with its exit code and stderr. */
  const preflight = async (values: Record<string, string>, extra: string[] = []) => {
    try {
      await docker(
        "run",
        "--rm",
        "--network",
        internal,
        ...ADD_HOSTS,
        ...extra,
        ...env(values),
        IMAGE,
        "node",
        "dist/check-config.js",
      );
      return { code: 0, stderr: "" };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string };
      return { code: failed.code ?? -1, stderr: failed.stderr ?? "" };
    }
  };

  const call = async (path: string, init: { key?: string; body?: unknown } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.key === undefined ? {} : { "x-api-key": init.key }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  const exchange = (
    operation: "verify" | "settle",
    key: string | undefined,
    payload: unknown,
    requirements: unknown,
  ) =>
    call(`/${operation}`, {
      ...(key === undefined ? {} : { key }),
      body: { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements },
    });
  const exactPayment = async (payer: Keypair, asset = usdc, payTo = seller.publicKey()) => {
    const requirements = requirementsFor(asset.sac, payTo, 1_000_000n);
    return { payload: await net.payment(payer, requirements), requirements };
  };

  beforeAll(async () => {
    const networks = JSON.parse(
      await docker("inspect", "-f", "{{json .NetworkSettings.Networks}}", STELLAR),
    ) as Record<string, unknown>;
    const stellarNetwork = Object.keys(networks)[0];
    if (stellarNetwork === undefined) throw new Error(`${STELLAR} is on no Docker network`);
    await docker("network", "create", "--internal", internal);
    await docker(
      "run",
      "-d",
      "--name",
      names.postgres,
      "--network",
      internal,
      "--network-alias",
      "postgres",
      "--tmpfs",
      "/var/lib/postgresql",
      ...env({ POSTGRES_USER: "rail402", POSTGRES_PASSWORD: "rail402", POSTGRES_DB: "rail402" }),
      POSTGRES_IMAGE,
    );
    // The relay is the only container with a foot outside: it reaches the Stellar RPC, and it
    // publishes the service's port to this host.
    await docker(
      "run",
      "-d",
      "--name",
      names.relay,
      "--network",
      stellarNetwork,
      "-p",
      "127.0.0.1::8081",
      "--entrypoint",
      "node",
      ...env({
        ROUTES: JSON.stringify([
          [8000, STELLAR, 8000],
          [8081, names.service, 8080],
        ]),
      }),
      IMAGE,
      "-e",
      RELAY,
    );
    await docker("network", "connect", "--alias", "stellar-rpc", internal, names.relay);
    const published = await docker("port", names.relay, "8081/tcp");
    base = `http://127.0.0.1:${published.split("\n")[0]?.split(":").at(-1) ?? ""}`;

    [usdc, eurc, contract] = await Promise.all([
      net.issueAsset("USDC"),
      net.issueAsset("EURC"),
      deployUpto(net),
    ]);
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    sponsor = Keypair.random();
    await net.fund(sponsor);

    const keys = join(directory, "keys.json");
    const createdAt = new Date().toISOString();
    const record = (keyId: string, key: string, limits: Record<string, unknown>) => ({
      id: keyId,
      sha256: sha256(key),
      networks: ["stellar:testnet"],
      createdAt,
      ...limits,
    });
    writeFileSync(
      keys,
      JSON.stringify({
        schemaVersion: 1,
        keys: [
          record("acme-1", ACCESS_KEY, { requestsPerMinute: 100, sponsorBudgetXlmPerHour: "5" }),
          // Less than one settlement's fee reservation (the 0.2 XLM fee ceiling and a bid).
          record("tight-1", TIGHT_KEY, { requestsPerMinute: 100, sponsorBudgetXlmPerHour: "0.1" }),
          record("burst-1", BURST_KEY, { requestsPerMinute: 2 }),
        ],
      }),
    );
    chmodSync(keys, 0o444);

    for (let attempt = 0; ; attempt++) {
      try {
        await docker(
          "exec",
          names.postgres,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "rail402",
          "-d",
          "rail402",
        );
        break;
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    await docker(
      "run",
      "-d",
      "--name",
      names.service,
      "--network",
      internal,
      ...ADD_HOSTS,
      "-v",
      `${keys}:/run/rail402/keys.json:ro`,
      ...env({
        DATABASE_URL: "postgres://rail402:rail402@postgres:5432/rail402",
        NETWORKS: "stellar:testnet",
        BAZAAR_ENABLED: "false",
        SEARCH_EMBEDDINGS: "false",
        RATE_LIMIT_PER_MINUTE: String(RATE_LIMIT),
        API_KEYS_FILE: "/run/rail402/keys.json",
        SERVICE_FEE_PER_SETTLEMENT_USD: SERVICE_FEE_USD,
        TESTNET_RPC_URL: "http://stellar-rpc:8000/rpc",
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "2",
        TESTNET_REQUIRE_API_KEY: "true",
        TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
        TESTNET_MAX_TX_FEE_STROOPS: "2000000",
        TESTNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
        TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
        TESTNET_UPTO_ENABLED: "true",
        TESTNET_UPTO_CONTRACT: contract.address,
        TESTNET_UPTO_WASM_HASH: contract.wasmHash,
        TESTNET_UPTO_TTL_KEEPER: "false",
        TESTNET_UPTO_LEDGER_SECONDS: "5",
      }),
      IMAGE,
    );
    for (let attempt = 0; ; attempt++) {
      const ready = await fetch(`${base}/ready`).then(
        (response) => response.status,
        () => 0,
      );
      if (ready === 200) break;
      const state = await docker("inspect", "-f", "{{.State.Status}}", names.service);
      if (state !== "running" || attempt > 120) {
        const logs = await run("docker", ["logs", "--tail", "50", names.service]).then(
          ({ stdout, stderr }) => stdout + stderr,
          () => "",
        );
        throw new Error(`the service did not become ready (${state}):\n${logs}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }, 600_000);

  afterAll(async () => {
    await Promise.all(
      Object.values(names).map((name) => run("docker", ["rm", "-f", name]).catch(() => undefined)),
    );
    await run("docker", ["network", "rm", internal]).catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  it("has no route to the internet or to any Rail402 host", async () => {
    const probe = async (url: string) =>
      docker(
        "exec",
        names.service,
        "node",
        "-e",
        `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(5000) }).then(() => console.log("reached"), () => console.log("unreachable"))`,
      );
    expect(await probe("https://testnet.rail402.dev/supported")).toBe("unreachable");
    expect(await probe("https://docs.rail402.dev/")).toBe("unreachable");
    expect(await probe("https://example.com/")).toBe("unreachable");
  });

  describe("preflight", () => {
    const testnet = {
      STORE: "memory",
      TESTNET_RPC_URL: "http://stellar-rpc:8000/rpc",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    };
    const pubnetSeed = Keypair.random().secret();
    /** Every pubnet setting without a default; the sponsor key file is mounted for the run's user. */
    const pubnet = (): { values: Record<string, string>; mount: string[] } => {
      const file = join(directory, `pubnet-sponsor-${randomBytes(4).toString("hex")}`);
      writeFileSync(file, `# rail402-key network=stellar:pubnet\n${pubnetSeed}\n`, { mode: 0o400 });
      // One pubnet key, for the settings that need keys (upto on pubnet).
      const keys = join(directory, `pubnet-keys-${randomBytes(4).toString("hex")}.json`);
      const createdAt = new Date();
      writeFileSync(
        keys,
        JSON.stringify({
          schemaVersion: 1,
          keys: [
            {
              id: "pubnet-1",
              sha256: sha256(accessKey("pubnet-1")),
              networks: ["stellar:pubnet"],
              sponsorBudgetXlmPerHour: "1",
              createdAt: createdAt.toISOString(),
              expiresAt: new Date(createdAt.getTime() + 30 * 86_400_000).toISOString(),
            },
          ],
        }),
        { mode: 0o444 },
      );
      const user = `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
      return {
        mount: [
          "--user",
          user,
          "-v",
          `${file}:/run/secrets/pubnet-sponsor:ro`,
          "-v",
          `${keys}:/run/rail402/keys.json:ro`,
        ],
        values: {
          STORE: "memory",
          NETWORKS: "stellar:pubnet",
          METRICS_PRIVATE_TOKEN_SHA256: "c0ffee".repeat(10) + "c0ff",
          PUBNET_RPC_URL: "https://pubnet-rpc.invalid/rpc",
          PUBNET_SPONSOR_SECRET_FILE: "/run/secrets/pubnet-sponsor",
          PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
          PUBNET_REQUIRE_API_KEY: "false",
          PUBNET_RATE_LIMIT_PER_MINUTE: "60",
          PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
          PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
          PUBNET_MAX_TX_FEE_STROOPS: "300000",
          PUBNET_INCLUSION_FEE_STROOPS: "200",
          PUBNET_ASSETS: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75:USDC:7:10000",
        },
      };
    };
    const without = (values: Record<string, string>, name: string) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => key !== name));

    it("accepts a complete testnet and a complete pubnet configuration", async () => {
      expect(await preflight(testnet)).toEqual({ code: 0, stderr: "" });
      const { values, mount } = pubnet();
      expect(await preflight(values, mount)).toEqual({ code: 0, stderr: "" });
    });

    it.each([
      ["TESTNET_SPONSOR_SECRET", "config_sponsor_secret_missing"],
      ["TESTNET_RPC_URL", "config_rpc_missing"],
    ])("exits 78 without %s (%s)", async (name, code) => {
      const result = await preflight(without(testnet, name));
      expect(result.code).toBe(78);
      expect(result.stderr).toMatch(new RegExp(`^rail402: ${code}: .*${name}`));
    });

    it.each([
      ["PUBNET_SPONSOR_SECRET_FILE", {}, "config_sponsor_secret_missing"],
      ["PUBNET_ASSETS", {}, "config_pubnet_assets_missing"],
      ["PUBNET_MAX_TX_FEE_STROOPS", {}, "config_pubnet_fee_ceiling_missing"],
      [
        "PUBNET_UPTO_CONTRACT",
        {
          PUBNET_REQUIRE_API_KEY: "true",
          API_KEYS_FILE: "/run/rail402/keys.json",
          PUBNET_UPTO_ENABLED: "true",
          PUBNET_UPTO_ZERO_SETTLEMENT: "onchain",
          PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000",
          PUBNET_UPTO_TTL_KEEPER: "false",
        },
        "config_upto_contract_missing",
      ],
    ])("exits 78 on pubnet without %s", async (name, extra, code) => {
      const { values, mount } = pubnet();
      const result = await preflight({ ...without(values, name), ...extra }, mount);
      expect(result.code).toBe(78);
      expect(result.stderr).toMatch(new RegExp(`^rail402: ${code}: .*${name}`));
      expect(result.stderr).not.toContain(pubnetSeed);
    });
  });

  describe("configured with keys, limits, budgets, assets and a service fee", () => {
    it("advertises exact and upto with fee sponsorship", async () => {
      const supported = await call("/supported");
      expect(supported.status).toBe(200);
      const kinds = supported.body["kinds"] as {
        scheme: string;
        network: string;
        extra?: Record<string, unknown>;
      }[];
      expect(kinds.map((kind) => kind.scheme).sort()).toEqual(["exact", "upto"]);
      for (const kind of kinds) expect(kind.extra).toMatchObject({ areFeesSponsored: true });
    });

    it("refuses a request without a key, or with an unknown one", async () => {
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const { payload, requirements } = await exactPayment(payer);
      expect((await exchange("verify", undefined, payload, requirements)).status).toBe(401);
      expect((await exchange("settle", accessKey("acme-1"), payload, requirements)).status).toBe(401);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(100_000_000n);
    });

    it("settles exact and upto for a key holder, with the payer's funds going to the seller", async () => {
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const exact = await exactPayment(payer);
      expect((await exchange("verify", ACCESS_KEY, exact.payload, exact.requirements)).body).toMatchObject({
        isValid: true,
      });
      expect((await exchange("settle", ACCESS_KEY, exact.payload, exact.requirements)).body).toMatchObject({
        success: true,
        payer: payer.publicKey(),
      });

      const accepted = uptoRequirements({
        asset: usdc.sac,
        payTo: seller.publicKey(),
        authority: deriveAuthorityKeypair(sponsor, "stellar:testnet").publicKey(),
      });
      const upto = await uptoPayment(net, {
        contract: contract.address,
        payer: accountPayer(payer),
        accepted,
      });
      expect((await exchange("verify", ACCESS_KEY, upto, accepted)).body).toMatchObject({ isValid: true });
      expect((await exchange("settle", ACCESS_KEY, upto, withAmount(accepted, 400_000n))).body).toMatchObject(
        { success: true, amount: "400000" },
      );
      expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(1_400_000n);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(100_000_000n - 1_400_000n);
    });

    it("refuses a token outside TESTNET_ASSETS", async () => {
      const [payer, payTo] = (await net.holders(eurc, 2, "10")) as [Keypair, Keypair];
      const { payload, requirements } = await exactPayment(payer, eurc, payTo.publicKey());
      expect((await exchange("verify", ACCESS_KEY, payload, requirements)).body).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_requirements_asset_not_accepted",
      });
    });

    it("refuses a key's settlement past its hourly sponsor budget", async () => {
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const { payload, requirements } = await exactPayment(payer);
      expect((await exchange("settle", TIGHT_KEY, payload, requirements)).body).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_caller_budget_exhausted",
      });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(100_000_000n);
    });

    it("refuses a key past its request limit with 429", async () => {
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const { payload, requirements } = await exactPayment(payer);
      const statuses: number[] = [];
      for (let index = 0; index < 3; index++) {
        statuses.push((await exchange("verify", BURST_KEY, payload, requirements)).status);
      }
      expect(statuses).toEqual([200, 200, 429]);
    });

    it("reports the service fee of the key's settlements at /usage", async () => {
      expect((await call("/usage")).status).toBe(401);
      const usage = await call("/usage", { key: ACCESS_KEY });
      expect(usage.status).toBe(200);
      const fee = usage.body["serviceFee"] as { perSettlementUsd: string; accruedUsd: string; basis: string };
      expect(Number(fee.perSettlementUsd)).toBe(Number(SERVICE_FEE_USD));
      expect(Number(fee.accruedUsd)).toBe(2 * Number(SERVICE_FEE_USD));
      expect(fee.basis).toBe("per_settlement_recorded_price");
      expect(usage.body["networks"]).toMatchObject({
        "stellar:testnet": {
          settlements: { succeeded: 2 },
          limits: { sponsorBudgetStroopsPerHour: "50000000" },
        },
      });
    });

    it("limits requests per client address with RATE_LIMIT_PER_MINUTE", async () => {
      // Last: past this point the test's address is limited for the rest of the minute.
      const statuses: number[] = [];
      for (let index = 0; index <= RATE_LIMIT; index++) statuses.push((await call("/supported")).status);
      expect(statuses).toContain(429);
      expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(RATE_LIMIT);
    });
  });
});
