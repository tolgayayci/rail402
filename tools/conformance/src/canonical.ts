/**
 * Canonical-client conformance run: an unmodified x402 buyer pays an unmodified x402 seller whose
 * facilitator is Rail402, on the Stellar testnet, with every byte between seller and facilitator
 * recorded by a transparent forwarder.
 *
 *   node tools/conformance/src/canonical.ts --facilitator http://localhost:8080 \
 *     [--scheme exact,upto] [--asset usdc,test6] [--payer g,c] [--write [--allow-branch <branch>]]
 *
 * Comma lists run every combination. For each one:
 * - Buyer: a G… payer uses @x402/fetch with @x402/stellar's stock `ExactStellarScheme` client. A C…
 *   payer (a smart account) is signed by Rail402's test client (`smartAccountPayment`), because the
 *   stock client signs for G… accounts only; its cases are labelled so.
 * - Seller: @x402/express `paymentMiddleware` + `x402ResourceServer` + `HTTPFacilitatorClient`,
 *   pointed at the forwarder in front of the facilitator.
 * - Wire: the signed payload is `{ transaction }` only; the seller forwards it byte-equal to `/verify`
 *   and `/settle`; the transaction is a single `invokeHostFunction`; `PAYMENT-RESPONSE` decodes.
 * - Chain: the settled transaction carries the payer's authorization entry byte-equal to the signed
 *   one, emits exactly one transfer (payer → payTo, the amount), a facilitator signer pays the fee
 *   through a fee bump around a facilitator channel, and no facilitator account holds or moves the asset.
 * `upto`: the seller registers `@rail402.dev/upto`'s server scheme on the stock middleware, prices the
 * route as the cap and charges half of it after serving, through the stock settlement override
 * (`setSettlementOverrides(res, { amount: "50%" })`). The buyer is stock @x402/fetch with
 * `@rail402.dev/upto`'s client (a C… payer's entry signed by the test signer). The payload is
 * `{ authorization }`: one signed Soroban authorization entry, which the settled transaction must carry
 * byte-equal; the transfer is the charged amount; the settlement authority advertised in `/supported`
 * is the operation source and, like every facilitator account, holds and moves nothing.
 * Assets: `usdc` is Circle's testnet USDC (a Stellar Asset Contract, 7 decimals); `test6` is the 6-decimal
 * SEP-41 test token from its committed deployment record, checked on chain before any funds are spent.
 * The facilitator must accept each asset run.
 * The `/supported` answer is recorded verbatim and compared with the x402.org facilitator's Stellar kind.
 * Fresh Friendbot-funded accounts are created for every run, so the script needs no secrets.
 */
import type { AddressInfo } from "node:net";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { parseArgs } from "node:util";
import express from "express";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClient } from "@x402/stellar/exact/client";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { UptoStellarScheme as UptoStellarClient } from "@rail402.dev/upto/client";
import { UptoStellarScheme as UptoStellarServer, uptoSettlementOverrides } from "@rail402.dev/upto/server";
import {
  LocalNetwork,
  deploySimpleAccount,
  requirementsFor,
  signContractAccountEntry,
  smartAccountPayment,
} from "@rail402.dev/testkit";
import { checkTest6OnChain, test6Asset, test6Faucet, type RunAsset } from "./test-token.ts";
import {
  harnessProvenance,
  recheckProvenance,
  runFileName,
  writeEvidence,
  type CheckId,
} from "./evidence.ts";
import { startForwarder, type Forwarder } from "./forwarder.ts";
import {
  CaseRecorder,
  buildEvidence,
  innerTransaction,
  readTarget,
  settledTransaction,
  supportedSigners,
  type CaseContext,
} from "./harness.ts";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  versions,
} from "./testnet.ts";
import { authorizationEntries, checkWire } from "./wire.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    scheme: { type: "string", default: "exact" },
    asset: { type: "string", default: "usdc" },
    payer: { type: "string", default: "g,c" },
    price: { type: "string", default: "$0.01" },
    reference: { type: "string", default: "https://x402.org/facilitator/supported" },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

const list = (name: string, value: string, allowed: readonly string[]) => {
  const items = [...new Set(value.split(",").map((item) => item.trim().toLowerCase()))];
  const unknown = items.filter((item) => !allowed.includes(item));
  if (items.length === 0 || unknown.length > 0) {
    throw new Error(`--${name} ${value}: expected a comma list of ${allowed.join(", ")}`);
  }
  return items;
};
// Rail402 settles `exact` and `upto` in the assets it accepts; anything else is refused before any
// funds are spent.
type Scheme = "exact" | "upto";
const SCHEMES = list("scheme", args.scheme, ["exact", "upto"]) as Scheme[];
const ASSETS = list("asset", args.asset, ["usdc", "test6"]) as ("usdc" | "test6")[];
const PAYERS = list("payer", args.payer, ["g", "c"]).map((payer) => payer.toUpperCase() as "G" | "C");

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const net = new LocalNetwork(TESTNET_RPC_URL, TESTNET_FRIENDBOT_URL);
const USDC: RunAsset = { contract: USDC_TESTNET_ADDRESS, symbol: "USDC", decimals: 7 };
const RESOURCE = { exact: "/weather", upto: "/metered-weather" } as const;
/** What an upto seller charges after serving: half of the cap, as a stock settlement override. */
const UPTO_CHARGE = "50%";

/**
 * What each asset's resource is and costs: `--price` in USDC, 0.01 TEST6 (10000 base units). An `upto`
 * route is priced the same, as its cap.
 */
function offerOf(scheme: Scheme, asset: "usdc" | "test6"): Offer {
  if (asset === "usdc") return { scheme, asset: USDC, path: RESOURCE[scheme], price: args.price };
  const test6 = test6Asset();
  return {
    scheme,
    asset: test6,
    path: `${RESOURCE[scheme]}-test6`,
    price: { amount: "10000", asset: test6.contract },
  };
}

interface Offer {
  readonly scheme: Scheme;
  readonly asset: RunAsset;
  readonly path: string;
  /** The stock route price: a dollar string for USDC, a base-unit amount for another token. */
  readonly price: string | { readonly amount: string; readonly asset: string };
}

async function main() {
  const target = await readTarget(args.facilitator);
  const signers = new Set(supportedSigners(target.supported));
  log(
    `facilitator ${target.facilitatorUrl} (version ${target.healthVersion}), ${String(signers.size)} signers`,
  );
  const recorder = new CaseRecorder();

  await recorder.run(
    {
      id: "supported",
      title:
        "/supported advertises exact on stellar:testnet with areFeesSponsored, like x402.org's Stellar kind",
      checks: ["supported", "fees-sponsored"],
    },
    async (context) => {
      const supported = target.supported as { kinds?: Record<string, unknown>[] };
      const kind = supported.kinds?.find(
        (entry) => entry["network"] === NETWORK && entry["scheme"] === "exact",
      );
      deepStrictEqual(kind, {
        x402Version: 2,
        scheme: "exact",
        network: NETWORK,
        extra: { areFeesSponsored: true },
      });
      ok(signers.size >= 2, "the sponsor and at least one channel are advertised as signers");
      context.observe("reference", await compareWithReference(kind));
    },
  );

  // The settlement authority an upto payer authorizes, from the facilitator's upto kind.
  let authority: string | undefined;
  if (SCHEMES.includes("upto")) {
    await recorder.run(
      {
        id: "supported-upto",
        title:
          "/supported advertises upto on stellar:testnet with areFeesSponsored and its settlement authority as a signer",
        checks: ["supported", "fees-sponsored", "scheme-upto"],
        scheme: "upto",
      },
      (context) => {
        const supported = target.supported as { kinds?: Record<string, unknown>[] };
        const kind = supported.kinds?.find(
          (entry) => entry["network"] === NETWORK && entry["scheme"] === "upto",
        );
        ok(kind !== undefined, "the facilitator advertises upto on stellar:testnet");
        const extra = kind["extra"] as
          { areFeesSponsored?: unknown; facilitatorAddress?: unknown } | undefined;
        strictEqual(extra?.areFeesSponsored, true, "upto fees are sponsored");
        ok(typeof extra.facilitatorAddress === "string", "the kind names its settlement authority");
        ok(signers.has(extra.facilitatorAddress), "the settlement authority is an advertised signer");
        authority = extra.facilitatorAddress;
        context.observe("kind", kind);
        return Promise.resolve();
      },
    );
  }

  const offers = SCHEMES.flatMap((scheme) => ASSETS.map((asset) => offerOf(scheme, asset)));
  if (ASSETS.includes("test6")) {
    const checked = await checkTest6OnChain(net.server);
    log(`TEST6 checked on chain: instance live until ledger ${String(checked.instanceLiveUntil)}`);
  }

  log("opening a treasury: Friendbot XLM, then USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open("5");
  const [seller] = await treasury.accounts(1, "0");
  if (seller === undefined) throw new Error("no seller account");
  const forwarder = await startForwarder({ target: target.facilitatorUrl });
  const shop = await startSeller(forwarder, seller.publicKey(), offers);
  const accounts: Record<string, string> = {
    payTo: seller.publicKey(),
    treasury: treasury.keypair.publicKey(),
  };

  try {
    for (const offer of offers) {
      const { asset, scheme } = offer;
      for (const payer of PAYERS) {
        const id = `${scheme}-${asset.symbol.toLowerCase()}-${payer.toLowerCase()}-payer`;
        if (scheme === "upto" && authority === undefined) {
          recorder.skip(
            {
              id,
              title: `upto in ${asset.symbol}`,
              checks: ["scheme-upto"],
              scheme,
              asset: asset.symbol,
              payer,
            },
            "the facilitator does not advertise upto on stellar:testnet",
          );
          continue;
        }
        await recorder.run(
          {
            id,
            title: titleOf(offer, payer),
            checks: checksOf(scheme, payer, asset),
            scheme,
            asset: asset.symbol,
            payer,
            payTo: "G",
          },
          async (context) => {
            forwarder.exchanges.length = 0;
            shop.signatures.length = 0;
            const buyer =
              scheme === "upto"
                ? await uptoBuyer(treasury, offer, payer, accounts)
                : payer === "G"
                  ? await stockBuyer(treasury, offer)
                  : await smartAccountBuyer(treasury, asset, accounts);
            accounts[id] = buyer.address;
            if (asset.record !== undefined) context.observe("assetRecord", asset.record);
            await payAndProve(context, {
              scheme,
              asset,
              url: shop.url(offer.path),
              buyer,
              shop,
              forwarder,
              signers,
              payTo: seller.publicKey(),
              ...(authority === undefined ? {} : { authority }),
            });
          },
        );
      }
    }
  } finally {
    await shop.close();
    await forwarder.close();
  }

  const evidence = buildEvidence(
    {
      kind: "canonical",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      target,
      packages: versions([
        "@x402/core",
        "@x402/fetch",
        "@x402/express",
        "@x402/stellar",
        "@stellar/stellar-sdk",
        ...(SCHEMES.includes("upto") ? ["@rail402.dev/upto"] : []),
      ]),
      command:
        `node tools/conformance/src/canonical.ts --facilitator ${target.facilitatorUrl} ` +
        `--scheme ${SCHEMES.join(",")} --asset ${ASSETS.join(",")} --payer ${PAYERS.join(",").toLowerCase()}`,
      config: Object.fromEntries(
        offers.flatMap((offer): [string, string][] => {
          const key = `${offer.scheme === "exact" ? "" : "upto."}${offer.asset.symbol.toLowerCase()}`;
          const price =
            typeof offer.price === "string"
              ? offer.price
              : `${offer.price.amount} base units (${String(offer.asset.decimals)} decimals) of ${offer.price.asset}`;
          return [
            [offer.scheme === "exact" ? `${key}.price` : `${key}.cap`, price],
            [`${key}.resource`, `GET ${offer.path}`],
            ...(offer.scheme === "upto" ? [[`${key}.charge`, UPTO_CHARGE] as [string, string]] : []),
          ];
        }),
      ),
      accounts,
      startedAt: recorder.startedAt,
    },
    recorder.cases,
  );
  if (provenance === undefined) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    const file = runFileName(evidence);
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
  }
  if (recorder.failed > 0) process.exitCode = 1;
}

// --- seller ------------------------------------------------------------------------------------------

interface Shop {
  /** The resource URL for a route path. */
  url(path: string): string;
  /** Every `PAYMENT-SIGNATURE` header the seller received, in order. */
  readonly signatures: string[];
  close(): Promise<void>;
}

/**
 * The stock @x402/express seller, one route per offer, its facilitator client pointed at the
 * forwarder. `upto` routes charge half of the cap through the stock settlement override.
 */
async function startSeller(forwarder: Forwarder, payTo: string, offers: readonly Offer[]): Promise<Shop> {
  const facilitator = new HTTPFacilitatorClient({ url: forwarder.url });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactStellarServer())
    .register(NETWORK, new UptoStellarServer());
  const signatures: string[] = [];
  const app = express();
  // Records what the buyer sent, before the stock middleware sees it.
  app.use((request, _response, next) => {
    const header = request.header("payment-signature");
    if (header !== undefined) signatures.push(header);
    next();
  });
  app.use(
    paymentMiddleware(
      Object.fromEntries(
        offers.map((offer) => [
          `GET ${offer.path}`,
          {
            accepts: { scheme: offer.scheme, price: offer.price, network: NETWORK, payTo },
            description:
              offer.scheme === "exact"
                ? `Weather report, paid in ${offer.asset.symbol}`
                : `Metered weather report, up to the price in ${offer.asset.symbol}`,
            mimeType: "application/json",
          },
        ]),
      ),
      resourceServer,
    ),
  );
  for (const offer of offers) {
    app.get(offer.path, (_request, response) => {
      if (offer.scheme === "upto") setSettlementOverrides(response, uptoSettlementOverrides(UPTO_CHARGE));
      response.json({ report: { weather: "sunny", temperature: 21 } });
    });
  }
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  return {
    url: (path) => `http://127.0.0.1:${String((listener.address() as AddressInfo).port)}${path}`,
    signatures,
    close: () =>
      new Promise<void>((resolve) => {
        listener.closeAllConnections();
        listener.close(() => {
          resolve();
        });
      }),
  };
}

// --- buyers ------------------------------------------------------------------------------------------

interface Buyer {
  readonly address: string;
  readonly client: string;
  /** Requests the resource, paying as the 402 answer asks. */
  request(url: string): Promise<Response>;
}

/**
 * A G… buyer using the unmodified @x402/fetch client and stock Stellar scheme, holding 1 USDC (with a
 * trustline) or 100 TEST6 (no trustline needed).
 */
async function stockBuyer(treasury: Treasury, offer: Offer): Promise<Buyer> {
  const { asset, price } = offer;
  const usdc = asset.contract === USDC.contract;
  const [buyer] = await treasury.accounts(1, usdc ? "1" : "0", usdc);
  if (buyer === undefined) throw new Error("no buyer account");
  if (!usdc) await test6Faucet(net, treasury.keypair, buyer.publicKey());
  const paying = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: NETWORK, client: new ExactStellarClient(createEd25519Signer(buyer.secret(), NETWORK)) },
    ],
    // USDC is a default asset of the stock client; another token is opted in with a per-payment cap.
    ...(usdc
      ? {}
      : {
          spendControls: {
            allowedAssets: [
              {
                network: NETWORK,
                asset: asset.contract,
                maxAmountPerPayment: typeof price === "string" ? undefined : price.amount,
              },
            ],
          },
        }),
  });
  return {
    address: buyer.publicKey(),
    client: `@x402/fetch wrapFetchWithPaymentFromConfig + @x402/stellar ExactStellarScheme (unmodified)${
      usdc ? "" : `, spendControls.allowedAssets [${asset.symbol}]`
    }`,
    request: (url) => paying(url),
  };
}

/**
 * A C… buyer: a deployed smart account holding the asset, whose owner key signs the authorization entry
 * the way the account's `__check_auth` expects. The HTTP flow is the x402 one, done by hand: the 402
 * answer's requirements are paid with a `PAYMENT-SIGNATURE` header.
 */
async function smartAccountBuyer(
  treasury: Treasury,
  asset: RunAsset,
  accounts: Record<string, string>,
): Promise<Buyer> {
  const owner = Keypair.random();
  const account = await deploySimpleAccount(net, treasury.keypair, owner);
  if (asset.contract === USDC.contract) await treasury.transfer(account, 1_000_000n);
  else await test6Faucet(net, treasury.keypair, account);
  accounts["smartAccountOwner"] = owner.publicKey();
  return {
    address: account,
    client: "Rail402 test client (testkit smartAccountPayment), stock @x402/core header encoding",
    async request(url) {
      const challenge = await fetch(url);
      strictEqual(challenge.status, 402, "the seller asks for payment");
      const header = challenge.headers.get("payment-required");
      ok(header !== null, "the 402 answer carries PAYMENT-REQUIRED");
      const required = decodePaymentRequiredHeader(header);
      const requirements = required.accepts.find(
        (entry) => entry.network === NETWORK && entry.scheme === "exact",
      );
      ok(requirements !== undefined, "the seller accepts exact on stellar:testnet");
      const signed = await smartAccountPayment(net, {
        account,
        owner,
        source: treasury.keypair,
        requirements: requirementsFor(
          requirements.asset,
          requirements.payTo,
          requirements.amount,
          requirements.maxTimeoutSeconds,
        ),
      });
      const payload = {
        x402Version: required.x402Version,
        resource: required.resource,
        accepted: requirements,
        payload: signed.payload,
      };
      return fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
    },
  };
}

/**
 * An `upto` buyer: stock @x402/fetch with `@rail402.dev/upto`'s client, unmodified for a G… payer. A
 * C… payer is a deployed smart account whose entry the client hands to the test signer
 * (`signContractAccountEntry`), the way the account's `__check_auth` expects. TEST6 is opted in with
 * the cap as its per-payment limit, as for `exact`.
 */
async function uptoBuyer(
  treasury: Treasury,
  offer: Offer,
  payer: "G" | "C",
  accounts: Record<string, string>,
): Promise<Buyer> {
  const { asset, price } = offer;
  const usdc = asset.contract === USDC.contract;
  let address: string;
  let client: UptoStellarClient;
  if (payer === "G") {
    const [buyer] = await treasury.accounts(1, usdc ? "1" : "0", usdc);
    if (buyer === undefined) throw new Error("no buyer account");
    if (!usdc) await test6Faucet(net, treasury.keypair, buyer.publicKey());
    address = buyer.publicKey();
    client = new UptoStellarClient(createEd25519Signer(buyer.secret(), NETWORK), {
      rpcConfig: { url: TESTNET_RPC_URL },
    });
  } else {
    const owner = Keypair.random();
    address = await deploySimpleAccount(net, treasury.keypair, owner);
    if (usdc) await treasury.transfer(address, 1_000_000n);
    else await test6Faucet(net, treasury.keypair, address);
    accounts["uptoSmartAccountOwner"] = owner.publicKey();
    client = new UptoStellarClient(
      {
        address,
        signAuthEntry: () => Promise.reject(new Error("the smart account's owner signs its entry")),
      },
      {
        rpcConfig: { url: TESTNET_RPC_URL },
        authorizeEntry: (entry, context) =>
          Promise.resolve(
            signContractAccountEntry(entry, owner, context.expirationLedger, context.networkPassphrase),
          ),
      },
    );
  }
  const paying = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client }],
    ...(usdc
      ? {}
      : {
          spendControls: {
            allowedAssets: [
              {
                network: NETWORK,
                asset: asset.contract,
                maxAmountPerPayment: typeof price === "string" ? undefined : price.amount,
              },
            ],
          },
        }),
  });
  return {
    address,
    client:
      payer === "G"
        ? `@x402/fetch wrapFetchWithPaymentFromConfig + @rail402.dev/upto UptoStellarScheme client (unmodified)${
            usdc ? "" : `, spendControls.allowedAssets [${asset.symbol}]`
          }`
        : "@x402/fetch + @rail402.dev/upto UptoStellarScheme client with the Rail402 test signer for the smart account's entry",
    request: (url) => paying(url),
  };
}

function titleOf(offer: Offer, payer: "G" | "C"): string {
  const symbol = offer.asset.symbol;
  if (offer.scheme === "upto") {
    return payer === "G"
      ? `a G… payer authorizes an upto cap with the stock @x402/fetch client and @rail402.dev/upto; a stock @x402/express seller charges half of it in ${symbol}`
      : `a smart-account (C…) payer authorizes an upto cap, signed by the Rail402 test signer; a stock @x402/express seller charges half of it in ${symbol}`;
  }
  return payer === "G"
    ? `the stock @x402/fetch client pays a stock @x402/express seller in ${symbol} (G… payer)`
    : `a smart-account (C…) payer, signed by the Rail402 test client, pays a stock @x402/express seller in ${symbol}`;
}

function checksOf(scheme: Scheme, payer: "G" | "C", asset: RunAsset): CheckId[] {
  const checks: CheckId[] =
    scheme === "upto"
      ? ["scheme-upto", "fees-sponsored"]
      : payer === "G"
        ? ["canonical-client", "payload-transaction", "scheme-exact", "fees-sponsored"]
        : ["payload-transaction", "scheme-exact", "fees-sponsored"];
  // A token other than USDC, with other decimals, is the second asset.
  return asset.contract === USDC.contract ? checks : [...checks, "second-asset"];
}

// --- one payment -------------------------------------------------------------------------------------

async function payAndProve(
  context: CaseContext,
  options: {
    scheme: Scheme;
    /** The settlement authority `/supported` advertises for upto. */
    authority?: string;
    asset: RunAsset;
    url: string;
    buyer: Buyer;
    shop: Shop;
    forwarder: Forwarder;
    signers: ReadonlySet<string>;
    payTo: string;
  },
) {
  const { scheme, asset, url, buyer, shop, forwarder, signers, payTo } = options;
  const facilitatorAccounts = [...signers];
  const before = {
    payer: await net.tokenBalance(asset.contract, buyer.address),
    payTo: await net.tokenBalance(asset.contract, payTo),
    facilitator: await Promise.all(
      facilitatorAccounts.map((account) => net.tokenBalance(asset.contract, account)),
    ),
  };

  const started = performance.now();
  const response = await buyer.request(url);
  const elapsedMs = Math.round(performance.now() - started);
  const body: unknown = await response.json();
  strictEqual(
    response.status,
    200,
    `paid request answered HTTP ${String(response.status)}: ${JSON.stringify(body)}; the facilitator answered ${JSON.stringify(
      forwarder.exchanges.map((exchange) => ({
        path: exchange.path,
        status: exchange.status,
        body: exchange.responseBody,
      })),
    )}`,
  );

  // Wire: what the buyer signed is what the facilitator received, in the defined shape.
  const wire = checkWire(
    {
      paymentSignature: shop.signatures.at(-1),
      paymentResponse: response.headers.get("payment-response"),
      exchanges: forwarder.exchanges,
    },
    scheme,
  );
  strictEqual(wire.settlement.payer, buyer.address, "the settlement names the buyer as payer");
  strictEqual(wire.settlement.network, NETWORK);
  const cap = BigInt(wire.payload.accepted.amount);
  const amount = BigInt(wire.settledAmount);
  if (scheme === "upto") {
    strictEqual(amount, cap / 2n, "the seller settled half of the cap");
    strictEqual(wire.settlement.amount, amount.toString(), "the settlement reports the amount charged");
  } else {
    strictEqual(amount, cap, "exact settles the price");
  }

  // Chain: the signed authorization, one transfer, the fee paid by the facilitator, non-custody.
  const hash = wire.settlement.transaction;
  const onChain = await net.server.getTransaction(hash);
  if (onChain.status !== rpc.Api.GetTransactionStatus.SUCCESS)
    throw new Error(`${hash} is ${onChain.status}`);
  const signedEntries =
    scheme === "exact"
      ? authorizationEntries(xdr.TransactionEnvelope.fromXDR(wire.signed, "base64"), buyer.address)
      : [xdr.SorobanAuthorizationEntry.fromXDR(wire.signed, "base64").toXDR("base64")];
  const settledEntries = authorizationEntries(onChain.envelopeXdr, buyer.address);
  strictEqual(signedEntries.length, 1, "the buyer signed one authorization entry");
  deepStrictEqual(
    settledEntries,
    signedEntries,
    "the settled authorization entry is byte-equal to the signed one",
  );

  const transaction = await settledTransaction(net, hash, {
    scheme,
    asset: asset.contract,
    decimals: asset.decimals,
    amount,
    payerType: buyer.address.startsWith("C") ? "C" : "G",
    withXdr: true,
  });
  deepStrictEqual(
    transaction.transfers,
    [{ from: buyer.address, to: payTo, amount: amount.toString() }],
    "exactly one transfer, payer → payTo, for the amount",
  );
  ok(signers.has(transaction.feeSource), `fee source ${transaction.feeSource} is a facilitator signer`);
  ok(
    signers.has(transaction.innerSource),
    `transaction source ${transaction.innerSource} is a facilitator signer`,
  );
  ok(![buyer.address, payTo].includes(transaction.feeSource), "the fee source is neither party");
  if (scheme === "upto") {
    const operation = innerTransaction(onChain.envelopeXdr.toXDR("base64"), net.passphrase).operations[0];
    strictEqual(operation?.source, options.authority, "the settlement authority is the operation source");
  }

  strictEqual(await net.tokenBalance(asset.contract, buyer.address), before.payer - amount, "payer debited");
  strictEqual(await net.tokenBalance(asset.contract, payTo), before.payTo + amount, "payTo credited");
  const facilitatorAfter = await Promise.all(
    facilitatorAccounts.map((account) => net.tokenBalance(asset.contract, account)),
  );
  deepStrictEqual(
    facilitatorAfter,
    before.facilitator,
    `no facilitator account's ${asset.symbol} balance changed`,
  );

  context.transaction(transaction);
  context.observe("client", buyer.client);
  context.observe("elapsedMs", elapsedMs);
  context.observe("wire", {
    scheme,
    payloadKeys: Object.keys(wire.payload.payload),
    ...(scheme === "upto" ? { cap: cap.toString(), settledAmount: amount.toString() } : {}),
    forwardedByteEqual: true,
    verifyStatus: wire.verifyStatus,
    settleStatus: wire.settleStatus,
    paymentResponse: wire.settlement,
    ...(wire.extensionResponses === undefined ? {} : { extensionResponses: wire.extensionResponses }),
    authorizationEntryByteEqual: true,
    exchanges: forwarder.exchanges.map((exchange) => ({
      method: exchange.method,
      path: exchange.path,
      status: exchange.status,
    })),
  });
}

/** How Rail402's Stellar kind compares with the x402.org facilitator's (read-only); never fails the run. */
async function compareWithReference(kind: unknown): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(args.reference, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { url: args.reference, available: false, status: response.status };
    const reference = (await response.json()) as { kinds?: Record<string, unknown>[] };
    const stellar = (reference.kinds ?? []).filter(
      (entry) => typeof entry["network"] === "string" && entry["network"].startsWith("stellar:"),
    );
    const shape = (value: unknown): unknown =>
      value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]))
        : typeof value;
    const ours = shape(kind);
    const match = stellar.find((entry) => entry["network"] === NETWORK && entry["scheme"] === "exact");
    return {
      url: args.reference,
      available: true,
      stellarKinds: stellar,
      sameShape: match !== undefined && JSON.stringify(shape(match)) === JSON.stringify(ours),
    };
  } catch (error) {
    return {
      url: args.reference,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
