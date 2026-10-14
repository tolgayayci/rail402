import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  SecretScanner,
  paymentEcho,
  randomContractId,
  schemaFindings,
  startDecoyOrigin,
} from "@rail402.dev/testkit";

const canary = Keypair.random();

/** A signed exact payment by the canary, and its PAYMENT-SIGNATURE header. */
async function payment(): Promise<{ header: string; transaction: string; entry: string }> {
  const asset = randomContractId();
  const call = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(asset).toScAddress(),
    functionName: "transfer",
    args: [
      nativeToScVal(canary.publicKey(), { type: "address" }),
      nativeToScVal(Keypair.random().publicKey(), { type: "address" }),
      nativeToScVal(10_000n, { type: "i128" }),
    ],
  });
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(canary.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString("42"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    }),
  });
  const signed = await authorizeEntry(unsigned, canary, 1_000, Networks.TESTNET);
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(60)
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(call),
        auth: [signed],
      }),
    )
    .build()
    .toXDR();
  const body = { x402Version: 2, payload: { transaction }, accepted: { scheme: "exact" } };
  return {
    header: Buffer.from(JSON.stringify(body)).toString("base64"),
    transaction,
    entry: signed.toXDR("base64"),
  };
}

const leaks = (scanner: SecretScanner) => scanner.findings().map((f) => `${f.channel}|${f.match}`);

describe("SecretScanner", () => {
  it("passes clean channels that carry only public data", async () => {
    const scanner = new SecretScanner(canary.secret());
    const { header } = await payment();
    scanner.addPaymentHeader(header, Networks.TESTNET);
    scanner.capture("receipt", {
      payer: canary.publicKey(),
      transaction: "ab".repeat(32),
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${"ab".repeat(32)}`,
    });
    scanner.capture("log", `{"level":"info","msg":"paid","payer":"${canary.publicKey()}"}`);
    expect(scanner.needles).toBeGreaterThan(10);
    expect(() => {
      scanner.assertClean();
    }).not.toThrow();
  });

  it("refuses to pass when nothing was captured", () => {
    expect(() => {
      new SecretScanner(canary.secret()).assertClean();
    }).toThrow(/no channel/);
  });

  it("finds a planted seed, raw key bytes and any other valid seed", () => {
    const scanner = new SecretScanner(canary.secret());
    const raw = canary.rawSecretKey();
    scanner.capture("stdout", `key=${canary.secret()}`);
    scanner.capture("hex", `bytes ${raw.toString("hex")}`);
    scanner.capture("base64url", { value: raw.toString("base64url") });
    scanner.capture("file", Buffer.concat([Buffer.from("header"), raw, Buffer.from("tail")]));
    scanner.capture("other seed", `x ${Keypair.random().secret()} y`);
    scanner.capture("glued seed", `KEYS${Keypair.random().secret()}`);
    expect(leaks(scanner)).toEqual(
      expect.arrayContaining([
        "stdout|exact",
        "hex|exact",
        "base64url|exact",
        "file|bytes",
        "other seed|seed",
        "glued seed|seed",
      ]),
    );
    expect(() => {
      scanner.assertClean();
    }).toThrow(/leak/);
    // The report names labels only, never the secret.
    try {
      scanner.assertClean();
    } catch (error) {
      expect(String(error)).not.toContain(canary.secret());
    }
  });

  it("finds payment material verbatim, encoded, escaped and truncated", async () => {
    const scanner = new SecretScanner(canary.secret());
    const { header, transaction, entry } = await payment();
    scanner.addPaymentHeader(header, Networks.TESTNET);
    scanner.capture("header", { headers: { "payment-signature": header } });
    scanner.capture("url", `https://x.example/?p=${encodeURIComponent(transaction)}`);
    scanner.capture("json", JSON.stringify({ text: JSON.stringify({ tx: transaction }) }));
    scanner.capture("truncated", `…${entry.slice(40, 70)}…`);
    expect(leaks(scanner)).toEqual(
      expect.arrayContaining(["header|exact", "url|url-encoded", "json|exact", "truncated|window"]),
    );
  });

  it("derives the preimage and signature from the header, as a signer tap records them", async () => {
    const fromHeader = new SecretScanner(canary.secret());
    const { header, entry } = await payment();
    fromHeader.addPaymentHeader(header, Networks.TESTNET);
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64");
    const credentials = signed.credentials().address();
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: credentials.nonce(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
        invocation: signed.rootInvocation(),
      }),
    ).toXDR("base64");
    const signature = canary.sign(hash(Buffer.from(preimage, "base64")));
    fromHeader.capture("preimage", preimage);
    fromHeader.capture("signature", signature.toString("base64"));
    expect(leaks(fromHeader)).toEqual(expect.arrayContaining(["preimage|exact", "signature|exact"]));

    const tapped = new SecretScanner(canary.secret());
    const signer = tapped.tap({
      address: canary.publicKey(),
      signAuthEntry: (authEntry: string) =>
        Promise.resolve({
          signedAuthEntry: canary.sign(hash(Buffer.from(authEntry, "base64"))).toString("base64"),
        }),
    });
    const { signAuthEntry } = signer;
    await signAuthEntry(preimage);
    tapped.capture("signature hex", signature.toString("hex"));
    expect(leaks(tapped)).toEqual(["signature hex|exact"]);
  });

  it("registers a signed authorization sent on its own, as an upto payment carries it", async () => {
    const scanner = new SecretScanner(canary.secret());
    const { entry } = await payment();
    scanner.addPayment({ x402Version: 2, payload: { authorization: entry } }, Networks.TESTNET);
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64");
    const signature = signed.credentials().address().signature().toXDR("base64");
    scanner.capture("entry", `{"authorization":"${entry}"}`);
    scanner.capture("signature value", signature);
    expect(leaks(scanner)).toEqual(expect.arrayContaining(["entry|exact", "signature value|exact"]));
  });

  it("builds an echo that carries every needle of the payment", async () => {
    const { header } = await payment();
    const scanner = new SecretScanner(canary.secret());
    scanner.addPaymentHeader(header, Networks.TESTNET);
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    const echo = paymentEcho(payload, Networks.TESTNET, header);
    for (const [field, value] of Object.entries(echo)) scanner.capture(field, value);
    const found = new Set(scanner.findings().map((f) => f.channel));
    expect([...found].sort()).toEqual(
      [
        "entries",
        "header",
        "headerInQuery",
        "nested",
        "payload",
        "payment",
        "paymentJson",
        "preimages",
        "signatureValues",
        "signatures",
      ].sort(),
    );
    // A signature whose base64 has no '+' or '/' is also its own base64url form, so that needle may match too.
    const needles = scanner.findings().map((f) => f.needle);
    expect(new Set(needles.filter((needle) => needle !== "signature (base64url)"))).toEqual(
      new Set([
        "PAYMENT-SIGNATURE header",
        "x402 payment JSON",
        "payment transaction XDR",
        "signed authorization entry XDR",
        "signed authorization signature ScVal",
        "signature (base64)",
        "signature (hex)",
        "authorization preimage",
      ]),
    );
  });

  it("walks thrown errors: message, stack, own properties and the cause chain", () => {
    const scanner = new SecretScanner(canary.secret());
    const hidden = new Error("outer", { cause: new Error("middle", { cause: new Error(canary.secret()) }) });
    const property = Object.defineProperty(new Error("plain"), "detail", {
      value: { seed: canary.secret() },
      enumerable: false,
    });
    scanner.capture("cause", hidden);
    scanner.capture("hidden property", property);
    expect(leaks(scanner)).toEqual(expect.arrayContaining(["cause|exact", "hidden property|exact"]));
  });

  it("flags secret-like schema properties and x-mcp-header", () => {
    expect(
      schemaFindings({
        type: "object",
        properties: {
          query: { type: "string" },
          nested: { type: "object", properties: { secretKey: { type: "string" } } },
          token: { type: "string", "x-mcp-header": "Authorization" },
        },
      }),
    ).toEqual([
      "$.properties.token",
      "$.properties.nested.properties.secretKey",
      "$.properties.token: x-mcp-header",
    ]);
    expect(schemaFindings({ type: "object", properties: { query: { type: "string" } } })).toEqual([]);
    const output = { type: "object", properties: { maxAuthorizationSeconds: { type: "integer" } } };
    expect(schemaFindings(output)).toEqual(["$.properties.maxAuthorizationSeconds"]);
    expect(schemaFindings(output, { allow: ["maxAuthorizationSeconds"] })).toEqual([]);
  });

  it("records what a decoy origin receives", async () => {
    const decoy = await startDecoyOrigin();
    try {
      const response = await fetch(`${decoy.url}/x?y=1`, { headers: { "x-test": "1" } });
      expect(await response.json()).toEqual({ decoy: true });
      expect(decoy.requests).toMatchObject([{ method: "GET", url: "/x?y=1", headers: { "x-test": "1" } }]);
    } finally {
      await decoy.close();
    }
  });
});
