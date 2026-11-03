import { readFileSync } from "node:fs";
import { Account, Address, Keypair, MuxedAccount, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { inspectTransaction } from "../src/inspect/transaction.ts";
import {
  accountSignature,
  addressCredentials,
  payAs,
  sealResult,
  signEntry,
} from "../../x402-index/test/helpers.ts";

interface Fixture {
  readonly network: "stellar:testnet" | "stellar:pubnet";
  readonly hash: string;
  readonly ledger: number;
  readonly closedAt: string;
  readonly envelopeXdr: string;
  readonly resultXdr: string;
  readonly metaXdr: string;
}

/** Real settlements from public ledgers, shared with the indexing rules' tests. */
const FIXTURES = JSON.parse(
  readFileSync(new URL("../../x402-index/test/fixtures/transactions.json", import.meta.url), "utf8"),
) as Record<string, Fixture>;

const fixture = (name: string): Fixture => {
  const found = FIXTURES[name];
  if (found === undefined) throw new Error(name);
  return found;
};

function rpcFor(tx: Fixture, status: "SUCCESS" | "FAILED" = "SUCCESS") {
  const response = {
    status,
    ledger: tx.ledger,
    createdAt: Date.parse(tx.closedAt) / 1000,
    envelopeXdr: xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64"),
    resultXdr: xdr.TransactionResult.fromXDR(tx.resultXdr, "base64"),
    resultMetaXdr: xdr.TransactionMeta.fromXDR(tx.metaXdr, "base64"),
  } as unknown as rpc.Api.GetTransactionResponse;
  return { getTransaction: () => Promise.resolve(response) };
}

const signers = (list: readonly string[]) => () =>
  Promise.resolve(new Response(JSON.stringify({ signers: { "stellar:*": list } })));

describe("inspectTransaction", () => {
  it("explains a sponsored exact payment: fee bump, invocation, authorization, transfer and shape", async () => {
    const tx = fixture("rail402-exact");
    const report = await inspectTransaction(tx.hash, {
      network: tx.network,
      server: rpcFor(tx),
      describe: () => Promise.resolve({ symbol: "USDC", decimals: 7 } as never),
      facilitator: {
        url: "https://example.org/",
        fetch: signers(["GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62"]),
      },
    });
    expect(report).toMatchObject({
      hash: tx.hash,
      status: "SUCCESS",
      ledger: 5_330_311,
      feeBump: {
        outerHash: tx.hash,
        feeSource: "GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62",
        feeCharged: "11781",
      },
      source: "GAYEVWAGRDU537EDK7NAWOHW7NSNND4TUCEAOZJDRQX6VK4VXDKKMLNZ",
      operations: [
        {
          type: "invokeHostFunction",
          contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          function: "transfer",
          args: [
            "GANVCYEU5N2ZBZVULCCB3TRY2HJMZJPHFSTVKHRA7AM2HPWKL453IHFR",
            "GBSVTVRQ4AEFRNGH2MIOOWZSAVLZKOKNKI4UAGSMBZSNRP4I3FL3ELYP",
            "10000",
          ],
        },
      ],
      authorizations: [
        {
          address: "GANVCYEU5N2ZBZVULCCB3TRY2HJMZJPHFSTVKHRA7AM2HPWKL453IHFR",
          credential: "address",
          signed: true,
          subInvocations: 0,
        },
      ],
      transfers: [{ symbol: "USDC", amount: { atomic: "10000", decimal: "0.001" } }],
      x402: {
        shape: "exact",
        checks: [
          "one token transfer invocation",
          "authorized by GANVCYEU5N2ZBZVULCCB3TRY2HJMZJPHFSTVKHRA7AM2HPWKL453IHFR alone",
          "no sub-invocations",
          "one transfer from the payer",
        ],
      },
      facilitator: { url: "https://example.org", attributed: true },
      explorerUrl: `https://explorer.rail402.dev/testnet/tx/${tx.hash}`,
    });
    expect(report.feeBump?.innerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.feeBump?.innerHash).not.toBe(tx.hash);
  });

  it("recognises the upto shape and a failed transaction without transfers", async () => {
    const tx = fixture("rail402-upto");
    const ok = await inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(tx) });
    expect(ok.x402.shape).toBe("upto");
    expect(ok.facilitator).toBeNull();
    const failed = await inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(tx, "FAILED") });
    expect(failed).toMatchObject({ status: "FAILED", transfers: [], x402: { shape: "upto" } });
    expect(failed.x402.checks.at(-1)).toBe("the transaction failed");
  });

  it("reports a fee source the facilitator does not advertise", async () => {
    const tx = fixture("x402org-exact-1");
    const report = await inspectTransaction(tx.hash, {
      network: tx.network,
      server: rpcFor(tx),
      facilitator: {
        url: "https://example.org",
        fetch: signers(["GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62"]),
      },
    });
    expect(report.facilitator).toEqual({ url: "https://example.org", attributed: false });
  });

  it("attributes a settlement from before a sponsor rotation through the published registry", async () => {
    const tx = fixture("rail402-exact-previous-sponsor");
    let fetched = 0;
    const report = await inspectTransaction(tx.hash, {
      network: tx.network,
      server: rpcFor(tx),
      // The facilitator's current signers no longer include the previous sponsor.
      facilitator: {
        url: "https://testnet.rail402.dev",
        fetch: () => {
          fetched++;
          return signers(["GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62"])();
        },
      },
    });
    expect(report.facilitator).toEqual({ url: "https://testnet.rail402.dev", attributed: true });
    expect(fetched).toBe(0);
  });

  it("shows muxed sources, fee sources and recipients as M… strkeys, as the network does", async () => {
    const tx = fixture("rail402-exact");
    const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
    const feeBump = envelope.feeBump().tx();
    const inner = feeBump.innerTx().v1().tx();
    const muxed = (account: xdr.MuxedAccount, id: string) =>
      xdr.MuxedAccount.keyTypeMuxedEd25519(
        new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString(id), ed25519: account.ed25519() }),
      );
    feeBump.feeSource(muxed(feeBump.feeSource(), "7"));
    inner.sourceAccount(muxed(inner.sourceAccount(), "9"));
    const edited = { ...tx, envelopeXdr: envelope.toXDR("base64") };
    const report = await inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(edited) });
    const sponsor = "GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62";
    expect(report.feeBump?.feeSource).toBe(new MuxedAccount(new Account(sponsor, "0"), "7").accountId());
    expect(StrKey.isValidMed25519PublicKey(report.source)).toBe(true);
  });

  it("says a payer authorized a transfer only when the chain proves it", async () => {
    // x402.org's settlement paid by another account, through a token that is not a Stellar Asset
    // Contract unless `custom` is false.
    const tx = fixture("x402org-exact-1");
    const token = StrKey.encodeContract(Buffer.alloc(32, 7));
    const tokenId = Address.fromString(token).toScAddress().contractId();
    const edited = (
      from: Keypair,
      sign: (entry: xdr.SorobanAuthorizationEntry) => void,
      custom = true,
    ): Fixture => {
      const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
      const meta = xdr.TransactionMeta.fromXDR(tx.metaXdr, "base64");
      const op = envelope.feeBump().tx().innerTx().v1().tx().operations()[0]?.body().invokeHostFunctionOp();
      const events = meta.v4().operations()[0]?.events() ?? [];
      const [entry] = op?.auth() ?? [];
      if (op === undefined || entry === undefined) throw new Error("no authorization");
      if (custom) {
        op.hostFunction().invokeContract().contractAddress(xdr.ScAddress.scAddressTypeContract(tokenId));
        entry
          .rootInvocation()
          .function()
          .contractFn()
          .contractAddress(xdr.ScAddress.scAddressTypeContract(tokenId));
        for (const event of events) event.contractId(tokenId);
      }
      payAs(op, events, from.publicKey());
      sign(entry);
      return {
        ...tx,
        envelopeXdr: envelope.toXDR("base64"),
        resultXdr: sealResult(tx.resultXdr, meta),
        metaXdr: meta.toXDR("base64"),
      };
    };
    const victim = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
    const garbage = (entry: xdr.SorobanAuthorizationEntry) => {
      addressCredentials(entry).signature(
        xdr.ScVal.scvVec([accountSignature(victim.rawPublicKey(), Buffer.alloc(64, 0xab))]),
      );
    };
    const forged = edited(victim, garbage);
    const unproven = await inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(forged) });
    expect(unproven.x402.shape).toBe("exact");
    expect(unproven.x402.checks).toContain(
      `an authorization entry for ${victim.publicKey()} alone, not proven by the chain`,
    );
    expect(unproven.x402.checks.join("\n")).not.toContain("authorized by");

    // The same transfer signed by the payer's own key is proven by that signature.
    const buyer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));
    const signed = edited(buyer, (entry) => {
      signEntry(entry, [buyer]);
    });
    const proven = await inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(signed) });
    expect(proven.x402.checks).toContain(`authorized by ${buyer.publicKey()} alone`);

    // In a Stellar Asset Contract the transfer itself proves it: the contract required the authorization.
    const asset = edited(victim, garbage, false);
    const contract = await inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(asset) });
    expect(contract.x402.checks).toContain(`authorized by ${victim.publicKey()} alone`);
  });

  it("refuses an envelope it cannot represent with its own code", async () => {
    const tx = fixture("rail402-exact");
    const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
    const [operation] = envelope.feeBump().tx().innerTx().v1().tx().operations();
    operation
      ?.body()
      .invokeHostFunctionOp()
      .auth()[0]
      ?.credentials()
      .address()
      .address(
        xdr.ScAddress.scAddressTypeClaimableBalance(
          xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(Buffer.alloc(32)),
        ),
      );
    const edited = { ...tx, envelopeXdr: envelope.toXDR("base64") };
    await expect(
      inspectTransaction(tx.hash, { network: tx.network, server: rpcFor(edited) }),
    ).rejects.toMatchObject({ code: "transaction_unreadable" });
  });
});
