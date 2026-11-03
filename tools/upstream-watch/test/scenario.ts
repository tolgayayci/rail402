/** A small upstream and a watch list pinned to it, for the watcher's tests. */
import { hashBody } from "../src/compare.ts";
import { GitHub } from "../src/github.ts";
import { parseWatchList, type WatchList } from "../src/watch-list.ts";
import { FakeUpstream, blobSha, sha } from "./fake-github.ts";

export const SPEC = "specs/x402-specification-v2.md";
export const STELLAR = "specs/schemes/exact/scheme_exact_stellar.md";
export const PENDING = "specs/schemes/upto/scheme_upto_stellar.md";
export const SOURCE = "typescript/packages/mechanisms/stellar/src";
export const SUPPORTED = "https://x402.org/facilitator/supported";

export const supportedBody = (extra: Record<string, unknown> = { areFeesSponsored: true }) =>
  JSON.stringify({
    kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:84532" },
      { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra },
    ],
  });

export interface Scenario {
  readonly upstream: FakeUpstream;
  readonly list: WatchList;
  readonly github: GitHub;
}

export function scenario(): Scenario {
  const upstream = new FakeUpstream();
  upstream.commit(
    "start",
    { [SPEC]: "# x402 v2\n\nline\n", [STELLAR]: "# exact on Stellar\n" },
    "2026-09-01T00:00:00Z",
  );
  upstream.commit("touch source (#1)", { [`${SOURCE}/index.ts`]: "export {};\n" }, "2026-09-10T00:00:00Z");
  const baseline = upstream.commit("release 2.27.0", { "CHANGELOG.md": "2.27.0\n" }, "2026-09-22T00:00:00Z");
  upstream.tags.set("npm-@x402/stellar@v2.27.0", { type: "commit", sha: baseline });
  upstream.npm.set("@x402/stellar", {
    latest: "2.27.0",
    versions: ["2.26.0", "2.27.0"],
    time: { "2.27.0": "2026-09-22T00:00:00Z" },
  });
  upstream.npm.set("@stellar/stellar-sdk", {
    latest: "17.1.0",
    versions: ["16.3.0", "17.0.0", "17.1.0", "16.9.9-rc.1"],
    time: {},
  });
  upstream.urls.set(SUPPORTED, supportedBody());
  const pin = (path: string) => ({
    pinnedCommit: upstream.lastCommitFor(path, baseline) as string,
    pinnedBlob: blobSha(upstream.contentAt(path, baseline) as string),
  });
  const list = parseWatchList({
    schemaVersion: 1,
    upstream: {
      repository: upstream.repository,
      branch: "main",
      baselineRef: "npm-@x402/stellar@v2.27.0",
      baselineCommit: baseline,
    },
    files: [
      { path: SPEC, ...pin(SPEC), affects: ["facilitator"], note: "the protocol" },
      { path: STELLAR, ...pin(STELLAR), affects: ["facilitator"], note: "exact on Stellar" },
    ],
    pending: [{ path: PENDING, affects: ["upto"], note: "upto on Stellar" }],
    paths: [{ path: SOURCE, affects: ["facilitator"], note: "ships later" }],
    packages: [
      {
        name: "@x402/stellar",
        pinned: "2.27.0",
        follow: "latest",
        releaseTag: "npm-@x402/stellar@v{version}",
        affects: ["facilitator"],
      },
      { name: "@stellar/stellar-sdk", pinned: "16.3.0", follow: "same-major", affects: ["facilitator"] },
    ],
    urls: [
      {
        url: SUPPORTED,
        normalize: "x402-supported-stellar",
        sha256: hashBody("x402-supported-stellar", supportedBody()),
        affects: ["facilitator"],
        note: "reference /supported",
      },
    ],
    components: {
      facilitator: {
        title: "Facilitator",
        paths: ["packages/facilitator/src/**"],
        tests: ["packages/facilitator/test/settlement.integration.test.ts"],
        docs: ["docs/facilitator/**"],
      },
      upto: {
        title: "upto",
        paths: ["packages/upto/src/**"],
        tests: ["packages/upto/test/**"],
        docs: ["docs/facilitator/upto.mdx"],
      },
    },
  });
  return { upstream, list, github: new GitHub({ fetch: upstream.fetch, token: "test-token" }) };
}

/** Upstream moves on: a spec edit and a new @x402/stellar release with its tag. */
export function driftSpec(upstream: FakeUpstream, text = "# x402 v2\n\nline changed @alice\n"): void {
  upstream.commit("docs(specs): fix a link (#3839)", { [SPEC]: text }, "2026-10-21T00:00:00Z");
}

export function releasePackage(upstream: FakeUpstream, version = "2.28.0"): void {
  const release = upstream.commit(
    `release ${version}`,
    { "CHANGELOG.md": `${version}\n` },
    "2026-09-29T00:00:00Z",
  );
  const tagObject = sha(`tag ${version}`);
  upstream.tags.set(`npm-@x402/stellar@v${version}`, { type: "tag", sha: tagObject, target: release });
  const entry = upstream.npm.get("@x402/stellar");
  if (entry !== undefined) {
    entry.latest = version;
    entry.versions.push(version);
    entry.time[version] = "2026-09-29T19:00:00Z";
  }
}
