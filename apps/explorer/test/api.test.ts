/**
 * The read API: keyset paging only, bounded limits, per-client rate limits, stable error codes and the
 * OpenAPI document.
 */
import { describe, expect, it } from "vitest";
import { RULES_VERSION } from "@rail402.dev/x402-index";
import { clientKey } from "../src/web/client-key.ts";
import { explorerCodes } from "../src/api/codes.ts";
import { keyset } from "../src/api/paging.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const x402org = rowOf(TRANSACTIONS["x402org-exact-1"]);
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; reason: string; retryable: boolean } }).error;

describe("explorer read API", () => {
  it("refuses a limit above 100 and an offset parameter", async () => {
    const app = testApp({ reader: new MemoryReader([exact]) });
    const base = `/api/v1/testnet/accounts/${exact.payer}/settlements`;
    for (const [query, code] of [
      ["limit=101", "explorer_invalid_limit"],
      ["limit=0", "explorer_invalid_limit"],
      ["limit=abc", "explorer_invalid_limit"],
      ["offset=10", "explorer_offset_unsupported"],
      ["page=2", "explorer_offset_unsupported"],
      ["amount=5", "explorer_invalid_parameter"],
      ["role=fee", "explorer_invalid_parameter"],
      ["cursor=garbage", "explorer_invalid_cursor"],
    ] as const) {
      const response = await app.request(`${base}?${query}`);
      expect(response.status, query).toBe(400);
      const error = await errorOf(response);
      expect(error.code, query).toBe(code);
      expect(error.reason.length, query).toBeGreaterThan(0);
    }
    expect((await app.request(`${base}?limit=100`)).status).toBe(200);
  });

  it("rate-limits per client with Retry-After", async () => {
    let now = 0;
    const app = testApp({ reader: new MemoryReader([exact]), ratePerMinute: 3, now: () => now });
    const ask = (ip: string) =>
      app.request("/api/v1/testnet/facilitators", { headers: { "x-forwarded-for": ip } });
    // Without trusted proxy hops every request comes from the same peer.
    for (let index = 0; index < 3; index++) expect((await ask("198.51.100.1")).status).toBe(200);
    const refused = await ask("198.51.100.2");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await errorOf(refused)).toMatchObject({ code: "explorer_rate_limited", retryable: true });
    // Static files and health stay reachable.
    expect((await app.request("/health")).status).toBe(200);
    now += 60_000;
    expect((await ask("198.51.100.1")).status).toBe(200);
  });

  it("asks the database at most once per interval for /health, however many clients ask", async () => {
    let now = 0;
    let pings = 0;
    let healthy = true;
    const reader = new MemoryReader([exact]);
    const counting = Object.assign(Object.create(reader) as MemoryReader, {
      ping: () => {
        pings++;
        return healthy ? Promise.resolve() : Promise.reject(new Error("down"));
      },
    });
    const app = testApp({ reader: counting, now: () => now });
    const answers = await Promise.all(Array.from({ length: 50 }, async () => app.request("/health")));
    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    expect(pings).toBe(1);
    now += 1_999;
    await app.request("/health");
    expect(pings).toBe(1);
    healthy = false;
    now += 1;
    expect((await app.request("/health")).status).toBe(503);
    expect((await app.request("/health")).status).toBe(503);
    expect(pings).toBe(2);
  });

  it("answers 503 with Retry-After instead of queueing beyond the in-flight limit", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = new MemoryReader([exact]);
    const slow = Object.assign(Object.create(reader) as MemoryReader, {
      payments: async (...args: Parameters<MemoryReader["payments"]>) => {
        await gate;
        return reader.payments(...args);
      },
    });
    const app = testApp({ reader: slow, maxInFlight: 1 });
    const first = app.request("/testnet");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await app.request("/api/v1/testnet/facilitators");
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(await errorOf(second)).toMatchObject({ code: "explorer_unavailable", retryable: true });
    expect((await app.request("/health")).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await app.request("/api/v1/testnet/facilitators")).status).toBe(200);
  });

  it("keys IPv6 clients by their /64", () => {
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("[2001:db8:1:2:aaaa::9]")).toBe("2001:db8:1:2::/64");
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("198.51.100.7")).toBe("198.51.100.7");
  });

  it("pages an account's settlements with a cursor bound to the list", async () => {
    const second = { ...exact, txHash: "1".repeat(64), innerHash: null, ledger: exact.ledger - 1 };
    const third = { ...exact, txHash: "2".repeat(64), innerHash: null, ledger: exact.ledger - 2 };
    const app = testApp({ reader: new MemoryReader([exact, second, third]) });
    const base = `/api/v1/testnet/accounts/${exact.payer}/settlements`;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response: Response = await app.request(
        `${base}?role=payer&limit=1${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: { txHash: string }[]; nextCursor: string | null };
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.txHash));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual([exact.txHash, second.txHash, third.txHash]);
    // A cursor from one list is refused on another.
    const first = (await (await app.request(`${base}?role=payer&limit=1`)).json()) as { nextCursor: string };
    const other = await app.request(`${base}?role=payTo&limit=1&cursor=${first.nextCursor}`);
    expect(await errorOf(other)).toMatchObject({ code: "explorer_invalid_cursor" });
    expect(() => keyset("a", { cursor: first.nextCursor })).toThrow(/explorer_invalid_cursor/);
  });

  it("answers transactions with versions, links and cache headers", async () => {
    const app = testApp({ reader: new MemoryReader([exact, x402org]) });
    const response = await app.request(`/api/v1/testnet/transactions/${x402org.txHash}`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600, no-transform");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "index",
      kind: "settlement",
      settlement: { txHash: x402org.txHash, attribution: { tier: "facilitator", facilitatorId: "x402-org" } },
      versions: { rules: RULES_VERSION },
      links: { page: `https://explorer.example.org/testnet/tx/${x402org.txHash}` },
    });
    const facilitators = (await (await app.request("/api/v1/testnet/facilitators")).json()) as {
      items: { id: string }[];
    };
    expect(facilitators.items.map((item) => item.id)).toContain("rail402");
    const missing = await app.request("/api/v1/testnet/report");
    expect(missing.status).toBe(503);
    expect(await errorOf(missing)).toMatchObject({ code: "explorer_report_unavailable" });
  });

  it("refuses methods other than GET and HEAD", async () => {
    const app = testApp({ reader: new MemoryReader([exact]) });
    const response = await app.request(`/api/v1/testnet/transactions/${exact.txHash}`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(await errorOf(response)).toMatchObject({ code: "explorer_method_not_allowed" });
    expect((await app.request(`/testnet/tx/${exact.txHash}`, { method: "HEAD" })).status).toBe(200);
  });

  it("serves the OpenAPI document with every code", async () => {
    const app = testApp({ reader: new MemoryReader([]) });
    const document = (await (await app.request("/api/v1/openapi.json")).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: {
        schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
      };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/{network}/transactions/{hash}",
        "/api/v1/{network}/report",
        "/api/v1/{network}/settlements",
        "/api/v1/{network}/manifest",
      ]),
    );
    expect(document.components.schemas.Error.properties.error.properties.code.enum.sort()).toEqual(
      Object.keys(explorerCodes).sort(),
    );
    for (const spec of Object.values(explorerCodes)) expect(spec.reason.trim()).not.toBe("");
  });

  it("documents the report's attributed totals as registered facilitators", async () => {
    const app = testApp({ reader: new MemoryReader([]) });
    const text = await (await app.request("/api/v1/openapi.json")).text();
    const report = (
      JSON.parse(text) as {
        components: {
          schemas: {
            Report: { required: string[]; properties: { headlineScope: { enum: string[] } } };
          };
        };
      }
    ).components.schemas.Report;
    expect(report.required).toContain("headlineScope");
    expect(report.properties.headlineScope.enum).toEqual(["registered-facilitators"]);
    // "Network-wide" names only the sampled window, never the registry-scope totals.
    const { networkWide, ...rest } = (
      JSON.parse(text) as { components: { schemas: { Report: { properties: Record<string, unknown> } } } }
    ).components.schemas.Report.properties;
    expect(JSON.stringify(rest)).not.toMatch(/network-wide/i);
    expect(JSON.stringify(networkWide)).toMatch(/network-wide \(sampled window\)/);
  });
});
