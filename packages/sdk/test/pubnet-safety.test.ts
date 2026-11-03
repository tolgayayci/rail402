import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, USDC } from "@rail402.dev/stellar";
import {
  KEY_FILE_TAG,
  KeyHolder,
  PUBNET_CAP_CEILINGS,
  createBuyer,
  createConfirmationGate,
  keyFileContent,
  loadSigner,
  paymentError,
  parseKeyFile,
  resolveAgentConfig,
  resolvePolicy,
  windowSpecFor,
  type PaymentEvent,
  type SignIntent,
  type SignIntentInput,
} from "@rail402.dev/sdk";
import { payHttp } from "../src/flow/http.ts";
import { countingSigner, flowContext, paidRoute, startSeller, type FakeSeller } from "./flow-harness.ts";

const directory = mkdtempSync(join(tmpdir(), "rail402-pubnet-safety-"));
let files = 0;
function keyFile(content: string): string {
  const path = join(directory, `key-${String(files++)}.key`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

const PUBNET_ENV = {
  RAIL402_NETWORK: PUBNET,
  RAIL402_RPC_URL: "https://rpc.example",
  RAIL402_BAZAAR_URL: "https://bazaar.example",
  RAIL402_MAX_PER_CALL: "0.10",
  RAIL402_MAX_TOTAL: "1.00",
};

describe("network-tagged key files", () => {
  const seed = Keypair.random().secret();

  it("writes the network into new key files and reads it back", () => {
    const content = keyFileContent(seed, PUBNET);
    expect(content).toBe(`${KEY_FILE_TAG}${PUBNET}\n${seed}\n`);
    expect(parseKeyFile(content)).toEqual({ network: PUBNET, secret: seed });
    expect(parseKeyFile(`${seed}\n`)).toEqual({ network: undefined, secret: seed });
  });

  it("refuses a malformed tag or extra lines as key_invalid, without echoing the seed", () => {
    for (const content of [`# rail402-key network=stellar:mainnet\n${seed}\n`, `${seed}\n${seed}\n`]) {
      let caught: unknown;
      try {
        parseKeyFile(content);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "key_invalid" });
      expect(JSON.stringify(caught)).not.toContain(seed);
    }
  });

  it("refuses a testnet-tagged key on pubnet and a pubnet-tagged key on testnet", async () => {
    const testnetFile = keyFile(keyFileContent(seed, TESTNET));
    const pubnetFile = keyFile(keyFileContent(seed, PUBNET));
    await expect(KeyHolder.fromFile(testnetFile, { network: PUBNET })).rejects.toMatchObject({
      code: "key_network_mismatch",
    });
    await expect(loadSigner({ secretFile: pubnetFile }, { network: TESTNET })).rejects.toMatchObject({
      code: "key_network_mismatch",
    });
    const holder = await KeyHolder.fromFile(pubnetFile, { network: PUBNET });
    expect(holder.address).toBe(Keypair.fromSecret(seed).publicKey());
  });

  it("refuses an untagged key file on pubnet unless explicitly allowed, and takes it on testnet", async () => {
    const untagged = keyFile(`${seed}\n`);
    await expect(KeyHolder.fromFile(untagged, { network: PUBNET })).rejects.toMatchObject({
      code: "key_network_untagged",
    });
    await expect(
      KeyHolder.fromFile(untagged, { network: PUBNET, allowUntagged: true }),
    ).resolves.toBeDefined();
    await expect(KeyHolder.fromFile(untagged, { network: TESTNET })).resolves.toBeDefined();
  });

  it("refuses an untagged key file when a pubnet buyer is created", async () => {
    const untagged = keyFile(`${seed}\n`);
    await expect(
      createBuyer({
        network: PUBNET,
        rpcUrl: "https://rpc.example",
        signer: { secretFile: untagged },
        confirmPolicy: "never",
      }),
    ).rejects.toMatchObject({ code: "key_network_untagged" });
  });
});

describe("pubnet agent configuration", () => {
  it("refuses a seed in RAIL402_SECRET_KEY on pubnet and removes it from the environment", () => {
    const seed = Keypair.random().secret();
    const env: Record<string, string | undefined> = { ...PUBNET_ENV, RAIL402_SECRET_KEY: seed };
    let caught: unknown;
    try {
      resolveAgentConfig(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "key_network_untagged" });
    expect(JSON.stringify(caught)).not.toContain(seed);
    expect(env["RAIL402_SECRET_KEY"]).toBeUndefined();
  });

  it("reads the untagged-key, large-cap and session renewal switches", () => {
    const config = resolveAgentConfig({
      ...PUBNET_ENV,
      RAIL402_SECRET_KEY_FILE: "/tmp/never-read.key",
      RAIL402_ALLOW_UNTAGGED_KEY: "true",
      RAIL402_ALLOW_LARGE_CAPS: "true",
      RAIL402_SESSION_AUTO_RENEW: "true",
    });
    expect(config.allowUntaggedKey).toBe(true);
    expect(config.policy.allowLargeCaps).toBe(true);
    expect(config.session.autoRenew).toBe(true);
    const plain = resolveAgentConfig({ ...PUBNET_ENV, RAIL402_SECRET_KEY_FILE: "/tmp/never-read.key" });
    expect(plain.allowUntaggedKey).toBe(false);
    expect(plain.policy.allowLargeCaps).toBeUndefined();
    expect(plain.session.autoRenew).toBeUndefined();
  });
});

describe("pubnet operator endpoints and stores", () => {
  const signer = KeyHolder.random();
  const base = {
    network: PUBNET as typeof PUBNET,
    signer,
    rpcUrl: "https://rpc.example",
    policy: { assets: [{ asset: "USDC", perCall: "0.10", sessionTotal: "1.00" }] },
    confirmPolicy: "never" as const,
  };

  it("refuses a plain-http, IP-literal or private-network Bazaar or facilitator built in code", async () => {
    for (const bazaarUrl of [
      "http://bazaar.example",
      "https://10.0.0.5",
      "https://[::1]:8443",
      "https://localhost",
      "https://bazaar",
      "https://bazaar.internal",
      "https://user:pass@bazaar.example",
    ]) {
      await expect(createBuyer({ ...base, bazaarUrl }), bazaarUrl).rejects.toMatchObject({
        code: "payment_policy_invalid",
      });
    }
    const refused = createBuyer({
      ...base,
      bazaarUrl: "https://bazaar.example",
      facilitatorUrl: "http://169.254.169.254",
    });
    await expect(refused).rejects.toMatchObject({ code: "payment_policy_invalid" });
    await expect(refused).rejects.toThrow(/facilitator URL/);
  });

  it("keeps a keyed pubnet budget in the persistent store", () => {
    expect(() =>
      resolveAgentConfig({
        ...PUBNET_ENV,
        RAIL402_SECRET_KEY_FILE: "/tmp/never-read.key",
        RAIL402_BUDGET_STORE: "memory",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "payment_policy_invalid",
        details: { setting: "RAIL402_BUDGET_STORE" },
      }),
    );
    // Without a key (search only) or on testnet, memory stays allowed.
    expect(resolveAgentConfig({ ...PUBNET_ENV, RAIL402_BUDGET_STORE: "memory" }).budgetStore).toBe("memory");
    expect(resolveAgentConfig({ RAIL402_BUDGET_STORE: "memory" }).budgetStore).toBe("memory");
  });
});

describe("pubnet upto settlement authorities", () => {
  const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
  const authority = Keypair.random().publicKey();
  const uptoPolicy = (extra: Record<string, unknown> = {}) => ({
    assets: [{ asset: "USDC", perCall: "0.10", sessionTotal: "1.00" }],
    schemes: ["exact", "upto"] as ("exact" | "upto")[],
    uptoContracts: [contract],
    ...extra,
  });
  const supported = (kinds: unknown[]) =>
    (() =>
      Promise.resolve(new Response(JSON.stringify({ kinds, extensions: [], signers: {} })))) as typeof fetch;
  const base = {
    network: PUBNET as typeof PUBNET,
    signer: KeyHolder.random(),
    rpcUrl: "https://rpc.example",
    bazaarUrl: "https://bazaar.example",
    confirmPolicy: "never" as const,
  };

  it("refuses to open a signing pubnet upto buyer with no pinned authority", async () => {
    const refused = createBuyer({ ...base, policy: uptoPolicy() });
    await expect(refused).rejects.toMatchObject({ code: "payment_policy_invalid" });
    await expect(refused).rejects.toThrow(/settlement authorities pinned/);
  });

  it("pins the authorities the facilitator advertises for upto on pubnet", async () => {
    const buyer = await createBuyer({
      ...base,
      policy: uptoPolicy(),
      facilitatorUrl: "https://facilitator.example",
      fetch: supported([
        { x402Version: 2, scheme: "upto", network: PUBNET, extra: { facilitatorAddress: authority } },
        {
          x402Version: 2,
          scheme: "upto",
          network: TESTNET,
          extra: { facilitatorAddress: Keypair.random().publicKey() },
        },
        { x402Version: 2, scheme: "exact", network: PUBNET, extra: { areFeesSponsored: true } },
      ]),
    });
    expect([...(buyer.policy.uptoFacilitators ?? [])]).toEqual([authority]);
    await buyer.close();
  });

  it("refuses when the facilitator advertises no pubnet upto authority, and keeps an explicit list", async () => {
    await expect(
      createBuyer({
        ...base,
        policy: uptoPolicy(),
        facilitatorUrl: "https://facilitator.example",
        fetch: supported([{ x402Version: 2, scheme: "exact", network: PUBNET, extra: {} }]),
      }),
    ).rejects.toMatchObject({ code: "payment_policy_invalid" });
    const pinned = await createBuyer({ ...base, policy: uptoPolicy({ uptoFacilitators: [authority] }) });
    expect([...(pinned.policy.uptoFacilitators ?? [])]).toEqual([authority]);
    await pinned.close();
  });
});

describe("pubnet cap ceilings and session renewal", () => {
  it("refuses a pubnet call above the per-call ceiling unless overridden", async () => {
    const usdc = (perCall: string, sessionTotal: string) => ({
      assets: [{ asset: "USDC", perCall, sessionTotal }],
    });
    await expect(resolvePolicy(PUBNET, usdc("1.5", "5"), { requireCaps: true })).rejects.toMatchObject({
      code: "payment_cap_invalid",
      reason: expect.stringContaining(`ceiling of ${PUBNET_CAP_CEILINGS.perCall} USDC`) as string,
    });
    await expect(resolvePolicy(PUBNET, usdc("1", "10.5"), { requireCaps: true })).rejects.toMatchObject({
      code: "payment_cap_invalid",
    });
    const atCeiling = await resolvePolicy(PUBNET, usdc("1", "10"), { requireCaps: true });
    expect(atCeiling.assets[0]?.perCall).toBe(10_000_000n);
    const large = await resolvePolicy(
      PUBNET,
      { ...usdc("5", "50"), allowLargeCaps: true },
      { requireCaps: true },
    );
    expect(large.assets[0]?.perCall).toBe(50_000_000n);
    // Testnet has no ceiling.
    await expect(resolvePolicy(TESTNET, usdc("5", "50"), { requireCaps: true })).resolves.toBeDefined();
  });

  it("refuses caps on any other pubnet asset unless larger caps are allowed", async () => {
    const contract = StrKey.encodeContract(StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()));
    const describe = () => Promise.resolve({ symbol: "XLM", name: "native", decimals: 7 });
    const policy = (allowLargeCaps?: boolean) => ({
      assets: [{ asset: contract, decimals: 7, perCall: "0.5", sessionTotal: "5" }],
      ...(allowLargeCaps === undefined ? {} : { allowLargeCaps }),
    });
    await expect(resolvePolicy(PUBNET, policy(), { requireCaps: true, describe })).rejects.toMatchObject({
      code: "payment_cap_invalid",
      reason: expect.stringContaining("no built-in ceiling") as string,
    });
    const allowed = await resolvePolicy(PUBNET, policy(true), { requireCaps: true, describe });
    expect(allowed.assets[0]).toMatchObject({ symbol: "XLM", perCall: 5_000_000n });
    // Testnet has no ceilings, and a pubnet reader without caps is not refused.
    await expect(resolvePolicy(TESTNET, policy(), { requireCaps: true, describe })).resolves.toBeDefined();
    await expect(
      resolvePolicy(PUBNET, { assets: [{ asset: contract, decimals: 7 }] }, { requireCaps: false, describe }),
    ).resolves.toBeDefined();
  });

  it("does not renew the default window on pubnet", async () => {
    const payer = Keypair.random().publicKey();
    const caps = { assets: [{ asset: "USDC", perCall: "0.1", sessionTotal: "1" }] };
    const pubnet = await resolvePolicy(PUBNET, caps, { requireCaps: true });
    const testnet = await resolvePolicy(TESTNET, caps, { requireCaps: true });
    expect(windowSpecFor(pubnet, payer).autoRenew).toBe(false);
    expect(windowSpecFor(pubnet, payer, { autoRenew: true }).autoRenew).toBe(true);
    expect(windowSpecFor(testnet, payer).autoRenew).toBe(true);
  });
});

const SELLER = Keypair.random().publicKey();

function intent(window = "w-1", payTo = SELLER, listingId: string | null = null): SignIntentInput {
  return {
    callId: "call-1",
    network: PUBNET,
    scheme: "exact",
    asset: { contract: USDC[PUBNET].contract, symbol: "USDC", decimals: 7 },
    amount: { atomic: "10000", decimal: "0.001" },
    payTo,
    resource: "https://seller.example/weather",
    listingId,
    facilitator: null,
    session: {
      name: "default",
      window,
      expiresAt: "2026-10-24T00:00:00.000Z",
      perCall: "0.10",
      remaining: "1",
    },
  };
}

describe("confirmation before signing", () => {
  it("needs a confirmation choice for a pubnet buyer that can sign", () => {
    expect(() => createConfirmationGate(PUBNET, true, {})).toThrow(/confirmation choice/);
    expect(createConfirmationGate(PUBNET, true, { confirmPolicy: "never" }).policy).toBe("never");
    expect(createConfirmationGate(PUBNET, false, {}).policy).toBe("never");
    expect(createConfirmationGate(TESTNET, true, {}).policy).toBe("never");
    expect(() => createConfirmationGate(TESTNET, true, { confirmPolicy: "every" })).toThrow(
      /needs a confirm function/,
    );
  });

  it("asks before the first payment of each window, then not again in that window", async () => {
    const asked: SignIntent[] = [];
    const observed: SignIntent[] = [];
    const gate = createConfirmationGate(PUBNET, true, {
      confirm: (value) => {
        asked.push(value);
        return true;
      },
      onBeforeSign: (value) => observed.push(value),
    });
    expect(gate.policy).toBe("first-per-session");
    await gate.approve(intent("w-1"), undefined);
    await gate.approve(intent("w-1"), undefined);
    await gate.approve(intent("w-2"), undefined);
    expect(asked.map((value) => value.session.window)).toEqual(["w-1", "w-2"]);
    expect(asked.every((value) => value.firstInSession)).toBe(true);
    expect(observed.map((value) => value.firstInSession)).toEqual([true, false, true]);
  });

  it("asks again for every new recipient or listing in a window, and says what an approval covers", async () => {
    const asked: SignIntent[] = [];
    const gate = createConfirmationGate(PUBNET, true, {
      confirm: (value) => {
        asked.push(value);
        return true;
      },
    });
    const [first, second, third] = [0, 1, 2].map(() => Keypair.random().publicKey()) as [
      string,
      string,
      string,
    ];
    await gate.approve(intent("w-1", first), undefined);
    await gate.approve(intent("w-1", second), undefined);
    await gate.approve(intent("w-1", third), undefined);
    // The same recipient and resource again: covered by its own approval, not asked.
    await gate.approve(intent("w-1", second), undefined);
    // The same recipient for a listing it was not approved for: asked again.
    await gate.approve(intent("w-1", second, "listing-1"), undefined);
    await gate.approve(intent("w-1", second, "listing-1"), undefined);
    expect(asked.map((value) => [value.payTo, value.listingId])).toEqual([
      [first, null],
      [second, null],
      [third, null],
      [second, "listing-1"],
    ]);
    expect(asked.every((value) => value.approvalScope === "recipient" && value.firstInSession)).toBe(true);

    const seen: SignIntent[] = [];
    const observed = createConfirmationGate(PUBNET, true, {
      confirmPolicy: "every",
      confirm: (value) => {
        seen.push(value);
        return true;
      },
    });
    await observed.approve(intent(), undefined);
    expect(seen[0]?.approvalScope).toBe("payment");
  });

  it("asks every time with the every policy, and refuses when declined", async () => {
    let answer = true;
    let asks = 0;
    const events: PaymentEvent[] = [];
    const gate = createConfirmationGate(PUBNET, true, {
      confirmPolicy: "every",
      confirm: () => {
        asks++;
        return answer;
      },
    });
    await gate.approve(intent(), undefined);
    answer = false;
    await expect(gate.approve(intent(), (event) => events.push(event))).rejects.toMatchObject({
      code: "payment_confirmation_declined",
      paid: "none",
    });
    expect(asks).toBe(2);
    expect(events).toEqual([{ type: "refused", callId: "call-1", code: "payment_confirmation_declined" }]);
  });

  it("passes a confirm function's own refusal through unchanged", async () => {
    const gate = createConfirmationGate(PUBNET, true, {
      confirm: () => {
        throw new Error("no terminal");
      },
    });
    await expect(gate.approve(intent(), undefined)).rejects.toThrow("no terminal");
  });

  it("records a coded refusal, but not a request to ask first, as a refused event", async () => {
    const events: PaymentEvent[] = [];
    const unavailable = createConfirmationGate(PUBNET, true, {
      confirm: () => {
        throw paymentError("payment_confirmation_unavailable");
      },
    });
    await expect(unavailable.approve(intent(), (event) => events.push(event))).rejects.toMatchObject({
      code: "payment_confirmation_unavailable",
    });
    expect(events).toEqual([{ type: "refused", callId: "call-1", code: "payment_confirmation_unavailable" }]);
    class AskFirst extends Error {}
    const asking = createConfirmationGate(PUBNET, true, {
      confirm: () => {
        throw new AskFirst("ask the user");
      },
    });
    await expect(asking.approve(intent(), (event) => events.push(event))).rejects.toBeInstanceOf(AskFirst);
    expect(events).toHaveLength(1);
  });
});

describe("a declined confirmation in the payment flow", () => {
  let seller: FakeSeller;
  beforeAll(async () => {
    seller = await startSeller({ "/paid": paidRoute({}, { ok: true }) });
  });
  afterAll(async () => {
    await seller.close();
  });

  it("signs nothing, reserves nothing and sends nothing", async () => {
    const signer = countingSigner();
    const asked: SignIntent[] = [];
    const context = await flowContext({
      signer,
      ports: [seller.port],
      confirmation: createConfirmationGate(TESTNET, true, {
        confirm: (value) => {
          asked.push(value);
          return false;
        },
      }),
    });
    const paidBefore = seller.seen.filter((request) => request.payment !== undefined).length;
    await expect(
      payHttp(context, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: { amount: "0.05" } }),
    ).rejects.toMatchObject({ code: "payment_confirmation_declined", paid: "none" });
    expect(signer.signatures).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ network: TESTNET, scheme: "exact", payTo: seller.payTo });
    expect(seller.seen.filter((request) => request.payment !== undefined).length).toBe(paidBefore);
    const usage = context.ledger.usage(context.ledger.window(context.spec ?? never()).id);
    expect([...usage.assets.values()].every((asset) => asset.pending === 0n && asset.spent === 0n)).toBe(
      true,
    );
  });
});

function never(): never {
  throw new Error("no spec");
}
