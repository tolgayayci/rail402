import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { CliConfig } from "./config.js";
import {
  cmdFund,
  cmdWhoami,
  cmdSearch,
  cmdPay,
  cmdBuy,
  cmdTx,
  cmdSupported,
  cmdConfig,
  type Ctx,
} from "./commands.js";

const baseConfig: CliConfig = {
  facilitatorUrl: "https://fac.test",
  explorerUrl: "https://exp.test",
  explorerWebUrl: "https://web.test",
  network: "stellar:testnet",
};

interface FakeResp {
  status?: number;
  json?: unknown;
  text?: string;
}

function makeFetch(router: (url: string) => FakeResp): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, json = null, text } = router(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => text ?? JSON.stringify(json),
      headers: new Headers(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxWith(config: CliConfig, fetchImpl: typeof fetch): Ctx {
  return { config, fetchImpl };
}

describe("fund", () => {
  it("generates an ephemeral key, funds it, and reports balances", async () => {
    const fetchImpl = makeFetch(url => {
      if (url.includes("friendbot")) return { status: 200, json: {} };
      if (url.includes("/accounts/"))
        return { status: 200, json: { balances: [{ asset_type: "native", balance: "10000.0" }] } };
      return { status: 404 };
    });
    const res = await cmdFund(ctxWith(baseConfig, fetchImpl));
    expect(res.error).toBeUndefined();
    const data = res.data as { generated: boolean; secret?: string; funded: boolean; balances: unknown[] };
    expect(data.generated).toBe(true);
    expect(data.secret).toMatch(/^S/);
    expect(data.funded).toBe(true);
    expect(data.balances).toHaveLength(1);
  });
});

describe("whoami", () => {
  it("errors with config_no_signer when no secret is set", async () => {
    const res = await cmdWhoami(ctxWith(baseConfig, makeFetch(() => ({}))));
    expect(res.error?.code).toBe("config_no_signer");
  });

  it("returns the address and balances for a configured secret", async () => {
    const kp = Keypair.random();
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: { balances: [{ asset_type: "native", balance: "42.0" }] },
    }));
    const res = await cmdWhoami(ctxWith({ ...baseConfig, secret: kp.secret() }, fetchImpl));
    expect(res.error).toBeUndefined();
    const data = res.data as { address: string; funded: boolean };
    expect(data.address).toBe(kp.publicKey());
    expect(data.funded).toBe(true);
  });
});

describe("search", () => {
  it("returns matched resources", async () => {
    const fetchImpl = makeFetch(url => {
      expect(url).toContain("/discovery/search");
      return {
        status: 200,
        json: { resources: [{ resource: "https://a/b", type: "http" }, { resource: "https://c/d", type: "http" }] },
      };
    });
    const res = await cmdSearch(ctxWith(baseConfig, fetchImpl), { query: "summarize" });
    expect(res.error).toBeUndefined();
    expect((res.data as { count: number }).count).toBe(2);
  });

  it("reports an empty result cleanly", async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, json: { resources: [] } }));
    const res = await cmdSearch(ctxWith(baseConfig, fetchImpl), { query: "nothing" });
    expect((res.data as { count: number }).count).toBe(0);
    expect(res.lines?.[0]).toMatch(/No Stellar resources/);
  });

  it("requires a query", async () => {
    const res = await cmdSearch(ctxWith(baseConfig, makeFetch(() => ({}))), { query: "" });
    expect(res.error?.code).toBe("mcp_invalid_input");
  });

  it("surfaces a Bazaar HTTP error with a coded reason", async () => {
    const fetchImpl = makeFetch(() => ({ status: 500, json: {} }));
    const res = await cmdSearch(ctxWith(baseConfig, fetchImpl), { query: "x" });
    expect(res.error).toBeDefined();
    expect(res.error?.reason).toBeTruthy();
  });
});

describe("pay / buy validation", () => {
  const noNet = ctxWith(baseConfig, makeFetch(() => ({})));

  it("pay requires a URL", async () => {
    expect((await cmdPay(noNet, { url: "" })).error?.code).toBe("mcp_invalid_input");
  });
  it("pay requires a spend cap", async () => {
    expect((await cmdPay(noNet, { url: "https://x/y" })).error?.code).toBe("mcp_budget_required");
  });
  it("pay requires a secret", async () => {
    expect((await cmdPay(noNet, { url: "https://x/y", max: "0.10" })).error?.code).toBe("config_no_signer");
  });
  it("pay rejects a malformed amount", async () => {
    const ctx = ctxWith({ ...baseConfig, secret: Keypair.random().secret() }, makeFetch(() => ({})));
    expect((await cmdPay(ctx, { url: "https://x/y", max: "abc" })).error?.code).toBe("config_invalid_value");
  });
  it("buy requires a query and a cap", async () => {
    expect((await cmdBuy(noNet, { query: "" })).error?.code).toBe("mcp_invalid_input");
    expect((await cmdBuy(noNet, { query: "x" })).error?.code).toBe("mcp_budget_required");
  });
});

describe("tx", () => {
  it("formats a found transaction and includes an explorer link", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: { payments: [{ scheme: "exact", amount: "1000000", confidence: "rail402" }] },
    }));
    const res = await cmdTx(ctxWith(baseConfig, fetchImpl), { hash: "abc123" });
    expect(res.error).toBeUndefined();
    expect((res.data as { explorer: string }).explorer).toBe("https://web.test/tx/abc123");
  });

  it("maps 404 to mcp_resource_not_found", async () => {
    const res = await cmdTx(ctxWith(baseConfig, makeFetch(() => ({ status: 404 }))), { hash: "missing" });
    expect(res.error?.code).toBe("mcp_resource_not_found");
  });

  it("maps other errors to mcp_upstream_error", async () => {
    const res = await cmdTx(ctxWith(baseConfig, makeFetch(() => ({ status: 502 }))), { hash: "boom" });
    expect(res.error?.code).toBe("mcp_upstream_error");
  });
});

describe("supported", () => {
  it("lists schemes and networks", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      json: {
        kinds: [{ scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }],
        extensions: ["bazaar"],
      },
    }));
    const res = await cmdSupported(ctxWith(baseConfig, fetchImpl));
    expect(res.error).toBeUndefined();
    expect(res.lines?.some(l => l.includes("exact on stellar:testnet"))).toBe(true);
  });
});

describe("config show", () => {
  it("redacts the secret and shows resolved endpoints", () => {
    const res = cmdConfig(ctxWith({ ...baseConfig, secret: "SABCDEFGHIJKLMNOP" }, makeFetch(() => ({}))), {
      action: "show",
    });
    const data = res.data as { secret: string; facilitatorUrl: string };
    expect(data.secret).not.toContain("HIJKL");
    expect(data.secret).toContain("…");
    expect(data.facilitatorUrl).toBe("https://fac.test");
  });

  it("rejects an unknown config key on set", () => {
    const res = cmdConfig(ctxWith(baseConfig, makeFetch(() => ({}))), {
      action: "set",
      key: "bogus",
      value: "x",
    });
    expect(res.error?.code).toBe("config_invalid_value");
  });
});
