import { describe, expect, it } from "vitest";
import { StrKey, hash, xdr } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer, type ClientStellarSigner } from "@x402/stellar";
import { authorizationPayload, decodeAuthorizationEntry, inspectUptoAuthorization } from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import { UptoStellarScheme as UptoServer, uptoSettlementOverrides } from "@rail402.dev/upto/server";
import {
  CONTRACT,
  LEDGER,
  NETWORK,
  PASSPHRASE,
  TOKEN,
  authority,
  payer,
  recipient,
  requirements,
} from "./helpers.ts";

const signer = createEd25519Signer(payer.secret(), NETWORK);
const latestLedger = () => Promise.resolve(LEDGER);

function client(
  options: ConstructorParameters<typeof UptoClient>[1] = {},
  key: ClientStellarSigner = signer,
) {
  return new UptoClient(key, { contracts: CONTRACT, latestLedger, ledgerSeconds: 5, ...options });
}

function authorizationOf(result: { payload: Record<string, unknown> }) {
  const base64 = result.payload["authorization"];
  if (typeof base64 !== "string") throw new Error("no authorization");
  const inspected = inspectUptoAuthorization(base64, CONTRACT);
  if (!inspected.ok) throw new Error(inspected.rejection.code);
  return { base64, ...inspected.authorization };
}

describe("upto client", () => {
  it("signs the terms of the requirements, expiring after maxTimeoutSeconds", async () => {
    const result = await client().createPaymentPayload(2, requirements({ maxTimeoutSeconds: 61 }));
    expect(result.x402Version).toBe(2);
    expect(Object.keys(result.payload)).toEqual(["authorization"]);
    const authorization = authorizationOf(result);
    expect(authorization).toMatchObject({
      payer: payer.publicKey(),
      credential: "address",
      signatureExpirationLedger: LEDGER + 13,
      treeValid: true,
      terms: {
        expirationLedger: LEDGER + 13,
        facilitator: authority.publicKey(),
        maxAmount: 1_000_000n,
        recipient: recipient.publicKey(),
        token: TOKEN,
        validAfterLedger: 0,
      },
    });
    const entry = decodeAuthorizationEntry(authorization.base64);
    const signature = entry.credentials().address().signature().vec()?.[0]?.map();
    const signatureBytes = signature
      ?.find((field) => field.key().sym().toString() === "signature")
      ?.val()
      .bytes();
    expect(signatureBytes && payer.verify(authorizationPayload(entry, PASSPHRASE), signatureBytes)).toBe(
      true,
    );
  });

  it("draws a fresh nonce for every payment", async () => {
    const nonces = new Set<bigint>();
    for (let i = 0; i < 5; i++)
      nonces.add(authorizationOf(await client().createPaymentPayload(2, requirements())).nonce);
    expect(nonces.size).toBe(5);
  });

  it("signs V2 credentials on request", async () => {
    const result = await client({ authV2: true }).createPaymentPayload(2, requirements());
    expect(authorizationOf(result).credential).toBe("address_v2");
  });

  it("uses an injected signer for a contract-account payer, with delegated signer entries", async () => {
    const account = StrKey.encodeContract(hash(Buffer.from("client smart account")));
    const delegated = xdr.SorobanAuthorizationEntry.fromXDR(
      decodeAuthorizationEntry(
        authorizationOf(await client().createPaymentPayload(2, requirements())).base64,
      ).toXDR(),
    );
    const scheme = new UptoClient(
      { address: account, signAuthEntry: () => Promise.reject(new Error("unused")) },
      {
        contracts: { [NETWORK]: CONTRACT },
        latestLedger,
        ledgerSeconds: 5,
        authorizeEntry: (entry, context) => {
          expect(context).toMatchObject({
            network: NETWORK,
            networkPassphrase: PASSPHRASE,
            contract: CONTRACT,
          });
          entry
            .credentials()
            .address()
            .signature(xdr.ScVal.scvBytes(Buffer.alloc(64, 9)));
          return Promise.resolve({ authorization: entry, signerAuthorizations: [delegated] });
        },
      },
    );
    const result = await scheme.createPaymentPayload(2, requirements());
    expect(authorizationOf(result).payer).toBe(account);
    expect(result.payload["signerAuthorizations"]).toEqual([delegated.toXDR("base64")]);

    const bare = new UptoClient(
      { address: account, signAuthEntry: () => Promise.reject(new Error("unused")) },
      { contracts: CONTRACT, latestLedger, ledgerSeconds: 5 },
    );
    await expect(bare.createPaymentPayload(2, requirements())).rejects.toThrow(/authorizeEntry/);
  });

  it("accepts a bare signed entry from an injected signer", async () => {
    const scheme = client({
      authorizeEntry: (entry) => {
        entry
          .credentials()
          .address()
          .signature(xdr.ScVal.scvBytes(Buffer.alloc(64, 1)));
        return Promise.resolve(entry);
      },
    });
    const result = await scheme.createPaymentPayload(2, requirements());
    expect(Object.keys(result.payload)).toEqual(["authorization"]);
  });

  it("surfaces a wallet refusal", async () => {
    const refusing: ClientStellarSigner = {
      address: payer.publicKey(),
      signAuthEntry: () =>
        Promise.resolve({ signedAuthEntry: "", error: { message: "user rejected", code: -4 } }),
    };
    await expect(client({}, refusing).createPaymentPayload(2, requirements())).rejects.toThrow(
      /user rejected/,
    );
  });

  const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([recipient.rawPublicKey(), Buffer.alloc(8, 2)]));
  it.each<[string, Partial<PaymentRequirements>]>([
    ["another scheme", { scheme: "exact" }],
    ["a non-Stellar network", { network: "eip155:8453" }],
    ["a zero cap", { amount: "0" }],
    ["a decimal cap", { amount: "1.5" }],
    ["a G… asset", { asset: payer.publicKey() }],
    ["a muxed payTo", { payTo: muxed }],
    ["a zero timeout", { maxTimeoutSeconds: 0 }],
    ["unsponsored fees", { extra: { areFeesSponsored: false, facilitatorAddress: authority.publicKey() } }],
    ["a missing facilitator address", { extra: { areFeesSponsored: true } }],
    ["a C… facilitator address", { extra: { areFeesSponsored: true, facilitatorAddress: CONTRACT } }],
    [
      "the payer as facilitator",
      { extra: { areFeesSponsored: true, facilitatorAddress: payer.publicKey() } },
    ],
    ["the payer as payTo", { payTo: payer.publicKey() }],
  ])("refuses %s", async (_name, overrides) => {
    await expect(client().createPaymentPayload(2, requirements(overrides))).rejects.toThrow();
  });

  it("names the G… account a settlement authority must be", async () => {
    await expect(
      client().createPaymentPayload(
        2,
        requirements({ extra: { areFeesSponsored: true, facilitatorAddress: CONTRACT } }),
      ),
    ).rejects.toThrow(/G… settlement authority/);
  });

  it("applies the core spend cap to the upto cap", async () => {
    await expect(
      client().createPaymentPayload(2, requirements(), { maxAmountPerPayment: "999999" }),
    ).rejects.toThrow(/spend limit/);
    await expect(
      client().createPaymentPayload(2, requirements(), { maxAmountPerPayment: "1000000" }),
    ).resolves.toBeDefined();
  });

  it("signs for at most 300 seconds unless configured otherwise", async () => {
    await expect(
      client().createPaymentPayload(2, requirements({ maxTimeoutSeconds: 300 })),
    ).resolves.toBeDefined();
    await expect(client().createPaymentPayload(2, requirements({ maxTimeoutSeconds: 301 }))).rejects.toThrow(
      /exceeds the 300 seconds/,
    );
    // A seller naming itself as the settlement authority cannot ask for a months-long authorization.
    await expect(
      client().createPaymentPayload(2, requirements({ maxTimeoutSeconds: 180 * 86_400 })),
    ).rejects.toThrow(/maxTimeoutSeconds/);
    await expect(
      client({ maxTimeoutSeconds: 60 }).createPaymentPayload(2, requirements({ maxTimeoutSeconds: 61 })),
    ).rejects.toThrow(/exceeds the 60 seconds/);
  });

  it("refuses a network without a settlement contract", async () => {
    // Pubnet has no canonical deployment yet; testnet falls back to its canonical contract.
    const scheme = new UptoClient(signer, { latestLedger, ledgerSeconds: 5 });
    await expect(scheme.createPaymentPayload(2, requirements({ network: "stellar:pubnet" }))).rejects.toThrow(
      /no upto settlement contract/,
    );
  });

  it("exposes the default-asset lookup for spend controls", () => {
    expect(client().findDefaultAsset(TOKEN, NETWORK)?.decimals).toBe(7);
  });
});

describe("upto server", () => {
  it("prices in testnet USDC by default and keeps asset amounts as they are", async () => {
    const server = new UptoServer();
    expect(server.scheme).toBe("upto");
    expect(server.paymentFlows.default.supported).toEqual(["authorization"]);
    expect(await server.parsePrice("$0.01", NETWORK)).toEqual({ amount: "100000", asset: TOKEN, extra: {} });
    expect(await server.parsePrice({ amount: "5", asset: CONTRACT }, NETWORK)).toEqual({
      amount: "5",
      asset: CONTRACT,
      extra: {},
    });
    await expect(server.parsePrice({ amount: "5", asset: "" }, NETWORK)).rejects.toThrow();
  });

  it("tries registered money parsers first", async () => {
    const server = new UptoServer()
      .registerMoneyParser(() => Promise.resolve(null))
      .registerMoneyParser((amount) => Promise.resolve({ amount: `${amount}000000`, asset: CONTRACT }));
    expect(await server.parsePrice("2", NETWORK)).toEqual({ amount: "2000000", asset: CONTRACT });
  });

  it("knows default and registered decimals, without assuming 7", () => {
    const server = new UptoServer().registerAssetDecimals(NETWORK, CONTRACT, 18);
    expect(server.getAssetDecimals(TOKEN, NETWORK)).toBe(7);
    expect(server.getAssetDecimals(CONTRACT, NETWORK)).toBe(18);
    expect(server.getAssetDecimals(CONTRACT, "stellar:pubnet")).toBeUndefined();
    expect(() => server.registerAssetDecimals(NETWORK, CONTRACT, -1)).toThrow();
  });

  it("copies areFeesSponsored and the settlement authority from the supported kind", async () => {
    const enhanced = await new UptoServer().enhancePaymentRequirements(
      { ...requirements(), extra: { note: "kept" } },
      {
        x402Version: 2,
        scheme: "upto",
        network: NETWORK,
        extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey(), other: 1 },
      },
      [],
    );
    expect(enhanced.extra).toEqual({
      note: "kept",
      areFeesSponsored: true,
      facilitatorAddress: authority.publicKey(),
    });
    const untouched = await new UptoServer().enhancePaymentRequirements(
      { ...requirements(), extra: {} },
      { x402Version: 2, scheme: "upto", network: NETWORK },
      [],
    );
    expect(untouched.extra).toEqual({});
  });

  it("builds settlement overrides in every supported format", () => {
    expect(uptoSettlementOverrides(300_000n)).toEqual({ amount: "300000" });
    expect(uptoSettlementOverrides(0)).toEqual({ amount: "0" });
    expect(uptoSettlementOverrides("50%")).toEqual({ amount: "50%" });
    expect(uptoSettlementOverrides("33.33%")).toEqual({ amount: "33.33%" });
    expect(uptoSettlementOverrides(" $0.002 ")).toEqual({ amount: "$0.002" });
    for (const bad of ["-1", "1.5", "150%", "1.234%", "$", "abc", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => uptoSettlementOverrides(bad)).toThrow();
    }
  });
});
