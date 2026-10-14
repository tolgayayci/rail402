import { describe, expect, it } from "vitest";
import { checkEvidence, type Evidence, type EvidenceCase } from "../src/evidence.ts";
import {
  AGENT_SURFACES,
  SURFACE_REFUSALS,
  checkStellarExpert,
  liveAgentProblems,
  registryInstallProblems,
  registryPackages,
  type RegistryLock,
} from "../src/live-agent-checks.ts";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
/** The earlier settlement that cataloged a listing a hosted run pays. */
const CATALOGED = "c".repeat(64);
const PAYER = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";

const transaction = (hash: string) => ({
  hash,
  ledger: 10,
  scheme: "exact",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  decimals: 7,
  amount: "10000",
  payerType: "G" as const,
  feeChargedStroops: "100",
  feeSource: "GDZREJ6UXJDL7IMLRMHP4F6RM37TF3WUGRB7GPE5G4IUIXKS6ISZPVEQ",
  innerSource: "GDZREJ6UXJDL7IMLRMHP4F6RM37TF3WUGRB7GPE5G4IUIXKS6ISZPVEQ",
  innerSequence: "1",
  transfers: [{ from: PAYER, to: PAYER, amount: "10000" }],
  explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
});

const cataloging = (catalogedBy: string) => ({
  listingId: "4b1c3a1e-0000-4000-8000-000000000000",
  firstCataloged: "2026-09-29T10:00:00.000Z",
  catalogedBy,
  catalogedByThisRun: false,
  settlements: 4,
  lastSettled: "2026-09-30T10:01:00.000Z",
  versions: [
    { version: 1, createdAt: "2026-09-29T10:00:00.000Z", cause: "settlement", transaction: catalogedBy },
  ],
});

const paying = (
  id: string,
  surface: string,
  hash: string,
  resourceType: string,
  catalogedBy?: string,
): EvidenceCase => ({
  id,
  title: id,
  checks: ["agent-payments"],
  status: "passed",
  elapsedMs: 1,
  transactions: [transaction(hash)],
  observations: {
    surface,
    resourceType,
    listingId: "4b1c3a1e-0000-4000-8000-000000000000",
    ...(catalogedBy === undefined ? {} : { cataloging: cataloging(catalogedBy) }),
  },
});

function document(cases: EvidenceCase[]): Evidence {
  return {
    schemaVersion: 2,
    kind: "live-agent",
    runId: "run",
    startedAt: "2026-09-30T10:00:00.000Z",
    finishedAt: "2026-09-30T10:05:00.000Z",
    network: "stellar:testnet",
    target: { mode: "local", facilitatorUrl: "http://127.0.0.1:8080", healthVersion: "0.3.0", supported: {} },
    harness: { commit: "c".repeat(40), dirty: false },
    packages: { "@rail402.dev/sdk": "0.3.0" },
    command: "node tools/conformance/src/live-agent.ts",
    config: {},
    accounts: { payer: PAYER },
    summary: {
      total: cases.length,
      passed: cases.filter((entry) => entry.status === "passed").length,
      failed: cases.filter((entry) => entry.status === "failed").length,
      skipped: 0,
    },
    cases,
  };
}

/** Every surface's refusals, each with its events: the refusal and no signature. */
const signing = () =>
  AGENT_SURFACES.flatMap((surface) =>
    SURFACE_REFUSALS.map((code) => ({
      surface,
      operation: `pay (${code})`,
      code,
      signedEvents: 0,
      refusedEvents: [code],
    })),
  );

const complete = (): EvidenceCase[] => [
  paying("sdk-http", "sdk", HASH, "http", CATALOGED),
  paying("mcp-tool", "mcp-server", OTHER, "mcp", CATALOGED),
  paying("cli-api", "cli", HASH, "http"),
  {
    id: "cap-below-price",
    title: "refused",
    checks: ["rejection-codes"],
    status: "passed",
    elapsedMs: 1,
    rejections: [
      { surface: "http", operation: "sdk: pay", code: "payment_per_call_cap_exceeded", reason: "too much" },
    ],
    observations: { balancesUnchanged: true, signing: signing() },
  },
  {
    id: "explorer",
    title: "explorer",
    checks: ["agent-payments"],
    status: "passed",
    elapsedMs: 1,
    observations: {
      transactions: [
        { hash: HASH, apiStatus: 200 },
        { hash: OTHER, apiStatus: 200 },
        { hash: CATALOGED, apiStatus: 200 },
      ],
    },
  },
  {
    id: "secret-scan",
    title: "scan",
    checks: ["agent-payments"],
    status: "passed",
    elapsedMs: 1,
    observations: { secretScan: { channels: 40, needles: 100, hits: 0 } },
  },
];

describe("live-agent evidence", () => {
  it("accepts a complete run, which is also valid schemaVersion 2 evidence", () => {
    const evidence = document(complete());
    expect(checkEvidence(evidence).problems).toEqual([]);
    expect(liveAgentProblems(evidence)).toEqual([]);
  });

  it("needs a stellar.expert 200 and a matching explorer link for every transaction", () => {
    const cases = complete().map((entry) =>
      entry.id === "explorer"
        ? { ...entry, observations: { transactions: [{ hash: HASH, apiStatus: 404 }] } }
        : entry.id === "cli-api"
          ? {
              ...entry,
              transactions: [{ ...transaction(HASH), explorer: "https://stellar.expert/explorer/testnet" }],
            }
          : entry,
    );
    expect(liveAgentProblems(document(cases))).toEqual([
      `sdk-http: stellar.expert answered 404 for ${HASH}`,
      `sdk-http: the cataloging transaction ${CATALOGED} was not found in stellar.expert`,
      `mcp-tool: stellar.expert answered nothing for ${OTHER}`,
      `mcp-tool: the cataloging transaction ${CATALOGED} was not found in stellar.expert`,
      `cli-api: ${HASH} has no matching explorer link`,
      `cli-api: stellar.expert answered 404 for ${HASH}`,
      "no http listing records how it was cataloged",
      "no mcp listing records how it was cataloged",
    ]);
  });

  it("needs a payment through every surface, and an HTTP API and an MCP tool paid through listings", () => {
    const cases = complete().filter((entry) => entry.id !== "mcp-tool");
    expect(liveAgentProblems(document(cases))).toEqual([
      "no passed payment through the mcp-server",
      "no mcp resource was cataloged and paid through its listing",
      "no mcp listing records how it was cataloged",
    ]);
  });

  it("needs each listing's cataloging: its first cataloging and version 1's settlement transaction", () => {
    const cases = complete().map((entry) =>
      entry.id === "sdk-http"
        ? {
            ...entry,
            observations: {
              ...entry.observations,
              cataloging: {
                ...cataloging(CATALOGED),
                versions: [{ version: 1, cause: "origin_verification" }],
              },
            },
          }
        : entry,
    );
    expect(liveAgentProblems(document(cases))).toEqual([
      "sdk-http: the cataloging record does not name the settlement of version 1",
      "no http listing records how it was cataloged",
    ]);
  });

  it("needs refusals to prove the balances unchanged, and a clean secret scan", () => {
    const cases = complete().map((entry) =>
      entry.id === "cap-below-price"
        ? { ...entry, observations: { signing: signing() } }
        : entry.id === "secret-scan"
          ? { ...entry, observations: { secretScan: { channels: 40, needles: 100, hits: 1 } } }
          : entry,
    );
    expect(liveAgentProblems(document(cases))).toEqual([
      "cap-below-price: refusal payment_per_call_cap_exceeded does not prove the balances unchanged",
      'the secret scan is not clean: {"channels":40,"needles":100,"hits":1}',
    ]);
  });
});

describe("live-agent refusals before signing", () => {
  const withSigning = (records: Record<string, unknown>[]) =>
    complete().map((entry) =>
      entry.id === "cap-below-price"
        ? { ...entry, observations: { ...entry.observations, signing: records } }
        : entry,
    );

  it("needs every surface to give every refusal", () => {
    const records = signing().filter(
      (record) => !(record.surface === "cli" && record.code === "payment_amount_not_permitted"),
    );
    expect(liveAgentProblems(document(withSigning(records)))).toEqual([
      "the cli has no refusal shown before signing for payment_amount_not_permitted",
    ]);
  });

  it("refuses a signature during a refusal, and a refusal its events do not show", () => {
    const records = signing().map((record) =>
      record.surface === "sdk" && record.code === "payment_asset_not_permitted"
        ? { ...record, signedEvents: 1 }
        : record.surface === "mcp-server" && record.code === "payment_network_not_permitted"
          ? { ...record, refusedEvents: [] }
          : record,
    );
    expect(liveAgentProblems(document(withSigning(records)))).toEqual([
      "cap-below-price: sdk signed during the refusal payment_asset_not_permitted",
      "cap-below-price: mcp-server emitted no refused event for payment_network_not_permitted",
      "the sdk has no refusal shown before signing for payment_asset_not_permitted",
      "the mcp-server has no refusal shown before signing for payment_network_not_permitted",
    ]);
  });
});

describe("stellar.expert check", () => {
  it("polls the API until it answers 200 with the transaction's hash and ledger", async () => {
    const answers = [
      new Response("not found", { status: 404 }),
      Response.json({ hash: OTHER, ledger: 5 }),
      Response.json({ hash: HASH, ledger: 42 }),
    ];
    const urls: string[] = [];
    const fake = ((url: string) => {
      urls.push(url);
      return Promise.resolve(answers.shift() ?? new Response(null, { status: 500 }));
    }) as unknown as typeof fetch;
    const check = await checkStellarExpert(HASH, { fetch: fake, intervalMs: 1, timeoutMs: 5_000 });
    expect(check).toEqual({
      hash: HASH,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${HASH}`,
      apiStatus: 200,
      ledger: 42,
      attempts: 3,
    });
    expect(urls[0]).toBe(`https://api.stellar.expert/explorer/testnet/tx/${HASH}`);
  });

  it("gives up after the timeout with the last status", async () => {
    const fake = (() =>
      Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch;
    const check = await checkStellarExpert(HASH, { fetch: fake, intervalMs: 1, timeoutMs: 20 });
    expect(check.apiStatus).toBe(404);
    expect(check.ledger).toBeUndefined();
    expect(check.attempts).toBeGreaterThanOrEqual(1);
  });
});

describe("an install of the published packages", () => {
  const REGISTRY = "https://registry.npmjs.org/";
  const entry = (name: string, version = "0.4.1", resolved?: string) => ({
    version,
    resolved: resolved ?? `${REGISTRY}${name}/-/${name.split("/")[1] ?? ""}-${version}.tgz`,
    integrity: `sha512-${"A".repeat(86)}==`,
  });
  const lock = (entries: Record<string, ReturnType<typeof entry>>): RegistryLock => ({
    packages: { "": { version: "" }, ...entries },
  });
  const expected = { names: ["@rail402.dev/sdk", "@rail402.dev/cli"], version: "0.4.1", registry: REGISTRY };

  it("accepts every Rail402 package resolved from the registry at the version", () => {
    const installed = lock({
      "node_modules/@rail402.dev/sdk": entry("@rail402.dev/sdk"),
      "node_modules/@rail402.dev/cli": entry("@rail402.dev/cli"),
      "node_modules/@rail402.dev/errors": entry("@rail402.dev/errors"),
      "node_modules/@x402/core": entry("@x402/core", "2.27.0"),
    });
    expect(registryInstallProblems(installed, expected)).toEqual([]);
    expect(
      registryInstallProblems(installed, { ...expected, registry: "https://registry.npmjs.org" }),
    ).toEqual([]);
    expect(registryPackages(installed).map((item) => item.name)).toEqual([
      "@rail402.dev/sdk",
      "@rail402.dev/cli",
      "@rail402.dev/errors",
    ]);
  });

  it("refuses a local tarball, another registry, another version, no integrity or a missing package", () => {
    const problems = registryInstallProblems(
      lock({
        "node_modules/@rail402.dev/sdk": entry(
          "@rail402.dev/sdk",
          "0.4.1",
          "file:../rail402.dev-sdk-0.4.1.tgz",
        ),
        "node_modules/@rail402.dev/upto": entry("@rail402.dev/upto", "0.4.0"),
        "node_modules/@rail402.dev/cli/node_modules/@rail402.dev/errors": {
          ...entry(
            "@rail402.dev/errors",
            "0.4.1",
            "https://registry.example.org/@rail402.dev/errors/-/errors-0.4.1.tgz",
          ),
          integrity: "",
        },
      }),
      expected,
    );
    expect(problems).toEqual([
      "@rail402.dev/sdk resolved from file:../rail402.dev-sdk-0.4.1.tgz, not https://registry.npmjs.org/",
      "@rail402.dev/upto is 0.4.0, not 0.4.1",
      "@rail402.dev/errors resolved from https://registry.example.org/@rail402.dev/errors/-/errors-0.4.1.tgz, not https://registry.npmjs.org/",
      "@rail402.dev/errors has no sha512 integrity",
      "@rail402.dev/cli is not installed",
    ]);
  });

  it("needs an https registry", () => {
    expect(
      registryInstallProblems(lock({}), { names: [], version: "0.4.1", registry: "http://localhost:4873" }),
    ).toEqual(["the registry http://localhost:4873 is not an https URL"]);
  });
});
