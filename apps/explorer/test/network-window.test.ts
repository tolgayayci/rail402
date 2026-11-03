/**
 * The report's network-wide block: a full-scope rebuild of a recent window, run by its own job with
 * time, download and row budgets, off unless configured, and reproducible with the command it prints.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { HorizonAnchors, verifyLedger, type AnchorSource } from "@rail402.dev/ledger-source";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import type { ComputedReport } from "../src/api/report.ts";
import { networkWindowConfig } from "../src/config.ts";
import { detectEpoch } from "../src/epoch.ts";
import { dataLakeDescription, rangeAnchors, rebuild, type Manifest } from "../src/rebuild/rebuild.ts";
import { runNetworkWindow, type NetworkWindowOptions } from "../src/window/window.ts";
import { reportOf } from "./bazaar.ts";
import { FixtureSource, fixtureMeta } from "./sources.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-window-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const registry = REGISTRIES["stellar:testnet"];
const epoch = detectEpoch(registry, { passphrase: "Test SDF Network ; September 2015" });
const HEAD = 5_330_320;
/** The fixture's contiguous run, 5,330,305 to 5,330,320: the data lake as of ledger HEAD. */
const SLICE = Array.from({ length: 16 }, (_, index) => 5_330_305 + index);
const HORIZON = "https://horizon-testnet.stellar.org/";

/** The fixture headers' true hashes, as an independent Horizon would answer. */
const fixtureAnchors: AnchorSource = {
  name: "fixture-anchors",
  ledgerHash: (sequence) =>
    Promise.resolve(
      sequence === 5_330_304
        ? verifyLedger(fixtureMeta(sequence + 1)).previousHash
        : verifyLedger(fixtureMeta(sequence)).hash,
    ),
};

const options = (name: string, change: Partial<NetworkWindowOptions> = {}): NetworkWindowOptions => ({
  network: "stellar:testnet",
  epoch,
  registry,
  source: new FixtureSource(SLICE),
  hours: 1,
  ledgers: 16,
  headHint: 5_330_305,
  anchors: { source: fixtureAnchors, url: HORIZON },
  maxSeconds: 60,
  maxDownloadBytes: 64 * 1024 * 1024,
  maxRows: 1_000,
  maxBytesInFlight: 1024 * 1024,
  concurrency: 4,
  workDir: join(scratch, name),
  now: () => new Date("2026-10-26T12:00:00.000Z"),
  ...change,
});

/** The rebuild the printed command runs: its range and anchors, the data lake's description. */
async function rebuildFromCommand(command: string, outDir: string) {
  const args = command.replace(/^pnpm explorer:rebuild /, "").split(" ");
  const { values } = parseArgs({
    args,
    options: {
      network: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "anchor-horizon": { type: "string" },
    },
    strict: true,
  });
  expect(values.network).toBe("testnet");
  const from = Number(values.from);
  const to = Number(values.to);
  expect(values["anchor-horizon"]).toBe(HORIZON);
  // The command asks this Horizon; here the fixture headers stand in for it.
  expect(() => new HorizonAnchors({ url: values["anchor-horizon"] ?? "" })).not.toThrow();
  return rebuild({
    network: "stellar:testnet",
    epoch,
    registry,
    source: new FixtureSource(SLICE),
    sourceDescription: dataLakeDescription(epoch),
    from,
    to,
    anchors: await rangeAnchors(fixtureAnchors, from, to),
    outDir,
  });
}

describe("the network window", () => {
  it("rebuilds the newest window in full, by tier, and its command reproduces the manifest hash", async () => {
    const window = await runNetworkWindow(options("window"));
    const { document } = window;
    expect(document).toMatchObject({
      label: "network-wide (sampled window)",
      scope: "full",
      network: "stellar:testnet",
      window: { hours: 1, from: 5_330_305, to: HEAD, ledgers: 16 },
      anchorHorizon: HORIZON,
      rebuildCommand: `pnpm explorer:rebuild --network testnet --from 5330305 --to ${String(HEAD)} --anchor-horizon ${HORIZON}`,
    });
    expect(Date.parse(document.window.firstClosedAt)).toBeLessThan(Date.parse(document.window.lastClosedAt));
    // Every settlement of the window is in exactly one tier or apart.
    const counted =
      document.tiers.rail402.payments +
      document.tiers.otherRegistered.payments +
      document.tiers.unattributed.payments +
      document.rail402Beta.payments +
      document.selfPayments.payments;
    const manifest = JSON.parse(window.manifestText) as Manifest;
    expect(counted).toBe(manifest.files["settlements.ndjson"].lines);
    expect(document.tiers.rail402.payments).toBeGreaterThan(0);
    expect(document.run.downloadedBytes).toBeGreaterThan(0);
    // The work files are gone; only the document and manifest remain.
    expect(existsSync(join(scratch, "window"))).toBe(false);

    const rebuilt = await rebuildFromCommand(document.rebuildCommand, join(scratch, "command"));
    expect(rebuilt.manifestSha256).toBe(document.manifestSha256);
    expect(rebuilt.manifest.totalsSha256).toBe(document.totalsSha256);
  });

  it("starts at the epoch's first ledger when the window is longer than the epoch so far", async () => {
    const window = await runNetworkWindow(
      options("clipped", {
        epoch: { ...epoch, fromLedger: 5_330_310 },
        ledgers: 720,
        anchors: undefined,
      }),
    );
    expect(window.document.window).toMatchObject({ from: 5_330_310, to: HEAD, ledgers: 11 });
    expect(window.document.rebuildCommand).toBe(
      `pnpm explorer:rebuild --network testnet --from 5330310 --to ${String(HEAD)}`,
    );
    expect(window.document.anchorHorizon).toBeNull();
  });

  it("stops at its download, row and time budgets and leaves no files", async () => {
    await expect(runNetworkWindow(options("bytes", { maxDownloadBytes: 1_000 }))).rejects.toMatchObject({
      code: "network_window_download_budget",
    });
    await expect(runNetworkWindow(options("rows", { maxRows: 1 }))).rejects.toMatchObject({
      code: "network_window_row_budget",
    });
    const slow = new FixtureSource(SLICE);
    const getLedger = slow.getLedger.bind(slow);
    slow.getLedger = async (sequence) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return getLedger(sequence);
    };
    await expect(
      runNetworkWindow(options("time", { source: slow, maxSeconds: 0.3, concurrency: 1 })),
    ).rejects.toMatchObject({ code: "network_window_time_budget" });
    for (const name of ["bytes", "rows", "time"]) expect(existsSync(join(scratch, name))).toBe(false);
  });
});

describe("the network window's settings", () => {
  const base = { EXPLORER_NETWORK: "testnet", EXPLORER_DATABASE_URL: "postgres://x@localhost/x" };
  const defaults = { workDir: "/tmp/window" };

  it("is off unless a window is configured, and bounded to 7 days", () => {
    expect(networkWindowConfig(base, defaults)).toMatchObject({ hours: 0 });
    expect(networkWindowConfig({ ...base, EXPLORER_NETWORK_WINDOW_HOURS: "24" }, defaults)).toMatchObject({
      hours: 24,
      everyHours: 24,
      maxSeconds: 3600,
      maxDownloadMib: 8192,
      bytesInFlightMib: 32,
      concurrency: 4,
      anchorHorizonUrl: HORIZON,
      workDir: "/tmp/window",
    });
    expect(() => networkWindowConfig({ ...base, EXPLORER_NETWORK_WINDOW_HOURS: "169" }, defaults)).toThrow(
      /at most 168/,
    );
    expect(() =>
      networkWindowConfig(
        { ...base, EXPLORER_NETWORK_WINDOW_HOURS: "1", EXPLORER_NETWORK_WINDOW_CONCURRENCY: "17" },
        defaults,
      ),
    ).toThrow(/at most 16/);
  });

  it("fails closed on pubnet: an explicit download budget, independent anchors and a safe role", () => {
    const pubnet = { ...base, EXPLORER_NETWORK: "pubnet", EXPLORER_NETWORK_WINDOW_HOURS: "1" };
    expect(() =>
      networkWindowConfig(
        { ...pubnet, EXPLORER_ANCHOR_HORIZON_URL: "https://horizon.stellar.org" },
        defaults,
      ),
    ).toThrow(expect.objectContaining({ code: "config_window_budget_missing" }));
    expect(() =>
      networkWindowConfig({ ...pubnet, EXPLORER_NETWORK_WINDOW_MAX_DOWNLOAD_MIB: "2048" }, defaults),
    ).toThrow(expect.objectContaining({ code: "config_anchor_missing" }));
    const ready = {
      ...pubnet,
      EXPLORER_NETWORK_WINDOW_MAX_DOWNLOAD_MIB: "2048",
      EXPLORER_ANCHOR_HORIZON_URL: "https://horizon.stellar.org",
    };
    expect(networkWindowConfig(ready, defaults)).toMatchObject({
      network: "stellar:pubnet",
      maxDownloadMib: 2048,
      anchorHorizonUrl: "https://horizon.stellar.org/",
    });
    expect(() => networkWindowConfig({ ...ready, EXPLORER_ALLOW_UNSAFE_ROLE: "true" }, defaults)).toThrow(
      /refused on pubnet/,
    );
    // Off, pubnet needs nothing.
    expect(networkWindowConfig({ ...base, EXPLORER_NETWORK: "pubnet" }, defaults)).toMatchObject({
      hours: 0,
    });
  });
});

describe("the network window's published anchor", () => {
  const defaults = { workDir: "/tmp/window" };
  const pubnet = {
    EXPLORER_NETWORK: "pubnet",
    EXPLORER_DATABASE_URL: "postgres://x@localhost/x",
    EXPLORER_NETWORK_WINDOW_HOURS: "1",
    EXPLORER_NETWORK_WINDOW_MAX_DOWNLOAD_MIB: "2048",
  };
  const keyed = "https://horizon.provider.example/api/secret-key-0123";

  it("refuses an anchor with a path, which may carry a provider key, unless a public anchor is named", () => {
    expect(() => networkWindowConfig({ ...pubnet, EXPLORER_ANCHOR_HORIZON_URL: keyed }, defaults)).toThrow(
      expect.objectContaining({ code: "config_anchor_not_public" }),
    );
    expect(
      networkWindowConfig(
        {
          ...pubnet,
          EXPLORER_ANCHOR_HORIZON_URL: keyed,
          EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL: "https://horizon.stellar.org",
        },
        defaults,
      ),
    ).toMatchObject({ anchorHorizonUrl: keyed, publicAnchorHorizonUrl: "https://horizon.stellar.org/" });
    // The anchor alone is published when its path is "/".
    expect(
      networkWindowConfig(
        { ...pubnet, EXPLORER_ANCHOR_HORIZON_URL: "https://horizon.stellar.org" },
        defaults,
      ),
    ).toMatchObject({ publicAnchorHorizonUrl: "https://horizon.stellar.org/" });
    // Off, nothing is published and nothing is checked.
    expect(
      networkWindowConfig(
        { ...pubnet, EXPLORER_NETWORK_WINDOW_HOURS: "0", EXPLORER_ANCHOR_HORIZON_URL: keyed },
        defaults,
      ),
    ).toMatchObject({ hours: 0, publicAnchorHorizonUrl: undefined });
  });

  it("refuses a public anchor that is not a bare origin", () => {
    for (const value of [
      "https://horizon.example/key",
      "https://user:pass@horizon.example",
      "https://horizon.example/?key=1",
      "http://horizon.example",
    ]) {
      expect(() =>
        networkWindowConfig(
          { ...pubnet, EXPLORER_ANCHOR_HORIZON_URL: keyed, EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL: value },
          defaults,
        ),
      ).toThrow(expect.objectContaining({ code: "config_invalid" }));
    }
  });

  it("never publishes an anchor URL with a path, even when called directly", async () => {
    await expect(
      runNetworkWindow(options("keyed-anchor", { anchors: { source: fixtureAnchors, url: keyed } })),
    ).rejects.toThrow(/bare origin/);
  });
});

describe("the network window on the report", () => {
  const rows = [rowOf(TRANSACTIONS["rail402-exact"]), rowOf(TRANSACTIONS["x402org-exact-1"])];

  it("is a separate block with its window, tiers and command, and its manifest in the API", async () => {
    const window = await runNetworkWindow(options("served"));
    const report = {
      document: { ...reportOf(rows), networkWide: window.document },
      networkWindowManifest: window.manifestText,
    } as unknown as ComputedReport;
    const app = testApp({ reader: new MemoryReader(rows), report });
    const html = await (await app.request("/testnet/ecosystem")).text();
    expect(html).toContain("Network-wide (sampled window)");
    expect(html).toContain("ledgers 5,330,305 to 5,330,320");
    expect(html).toContain("Other registered facilitators");
    expect(html).toContain("Unregistered or unattributed (x402-shaped)");
    expect(html).toContain(window.document.manifestSha256);
    expect(html).toContain("--anchor-horizon");
    // The registry-scope block keeps its own label next to it.
    expect(html).toContain("Registered facilitators (Rail402 included)");
    expect(html.indexOf("Network-wide (sampled window)")).toBeLessThan(
      html.indexOf("Registered facilitators (Rail402 included)"),
    );

    const api = (await (await app.request("/api/v1/testnet/report")).json()) as {
      networkWide: { manifestSha256: string; window: { from: number } };
    };
    expect(api.networkWide).toMatchObject({
      manifestSha256: window.document.manifestSha256,
      window: { from: 5_330_305 },
    });
    const manifest = await app.request("/api/v1/testnet/network-window/manifest");
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(window.manifestText);
  });

  it("is left out when it was classified under other rules", async () => {
    const window = await runNetworkWindow(options("served"));
    const report = {
      document: { ...reportOf(rows), networkWide: { ...window.document, rulesVersion: "1" } },
      networkWindowManifest: window.manifestText,
    } as unknown as ComputedReport;
    const app = testApp({ reader: new MemoryReader(rows), report });
    const html = await (await app.request("/testnet/ecosystem")).text();
    expect(html).not.toContain("Network-wide");
    expect(html).toContain("Registered facilitators (Rail402 included)");
    const api = (await (await app.request("/api/v1/testnet/report")).json()) as { networkWide: unknown };
    expect(api.networkWide).toBeNull();
    expect((await app.request("/api/v1/testnet/network-window/manifest")).status).toBe(404);
  });

  it("is absent until the window job publishes one", async () => {
    const report = { document: { ...reportOf(rows), networkWide: null } } as unknown as ComputedReport;
    const app = testApp({ reader: new MemoryReader(rows), report });
    expect(await (await app.request("/testnet/ecosystem")).text()).not.toContain("Network-wide");
    const manifest = await app.request("/api/v1/testnet/network-window/manifest");
    expect(manifest.status).toBe(404);
    expect(((await manifest.json()) as { error: { code: string } }).error.code).toBe("explorer_not_found");
  });
});
