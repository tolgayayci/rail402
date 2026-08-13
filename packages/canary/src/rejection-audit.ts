import { Asset, Keypair, Operation, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { ALL_ERROR_CODES, X402Error, type ErrorCode } from "@rail402/errors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { CanaryRun, type CanaryReport } from "./report.js";
import { callFacilitator, decodeExtensionResponses, postRaw, stockBuyer } from "./payment.js";
import { requireBazaarFacilitator } from "./supported.js";
import { startSyntheticSeller, type SyntheticSeller } from "./seller.js";
import {
  NETWORK,
  NETWORK_PASSPHRASE,
  friendbotFund,
  prepareFixtures,
  submitClassic,
  type Fixtures,
} from "./testnet.js";
import { assetCodeFor } from "./discovery-loop.js";

/**
 * C-4 — the rejection-audit battery.
 *
 * "A non-null reason on every rejection" is a hard acceptance criterion, and it is the single
 * property most easily eroded by a careless refactor: nothing breaks, no test fails, the payment is
 * still correctly refused — the caller just stops being told why. The upstream library it wraps
 * demonstrates the failure mode precisely, setting a machine code on every rejection and a
 * human-readable message on roughly one of twenty.
 *
 * So this battery drives every rejection path over real HTTP against a live facilitator and, for
 * each one, asserts three things:
 *
 *   1. It was **rejected**. Accepting something that must be refused is the worst outcome here and
 *      is reported as its own code, not as a failed assertion among others.
 *   2. The rejection carries a **registered machine-readable code**, and the expected one. An agent
 *      branches on the code; the wrong code sends it down the wrong remediation path.
 *   3. The rejection carries a **reason a human can act on** — non-empty, and not merely the code
 *      spelled differently, which is the shape a "non-null reason" degrades into first.
 *
 * ## Why it has to be live
 *
 * Most of these are unit-tested already. What unit tests cannot cover is the classification of real
 * Soroban failures: `invalid_exact_stellar_payload_simulation_failed` is one upstream code covering
 * "no trustline", "insufficient balance", "already used" and "archived state", and our refinement of
 * it is pattern-matched against error strings the network actually emits. Those strings change
 * without notice, and when they do, the codes silently collapse back into the useless catch-all
 * while every unit test stays green.
 *
 * ## The ledger-state cases
 *
 * Three cases could not be produced by mutating a payload, because the stock client simulates
 * before signing and would refuse to build one. They are produced instead by signing a **valid**
 * payment and then changing the ledger underneath it — dropping a trustline, draining a balance.
 * That is not a contrivance: it is the real race between verification and settlement, and it is the
 * one an operator will actually meet.
 */

const AMOUNT = "2500000";

/** The authorization entries carried by a signed payload's transaction. */
function decodeAuth(payload: PaymentPayload): xdr.SorobanAuthorizationEntry[] {
  const raw = (payload.payload as { transaction: string }).transaction;
  const tx = new Transaction(raw, NETWORK_PASSPHRASE);
  return (tx.operations[0] as Operation.InvokeHostFunction).auth ?? [];
}

/**
 * Rebuild a payload's transaction with different authorization entries, changing nothing else.
 *
 * Surgery at the XDR level rather than via the client, because the stock client simulates before
 * signing and would simply refuse to construct any of these — which is the point: only a hostile
 * or broken client emits them, so only hand-built XDR can prove the facilitator refuses them.
 */
function withAuth(payload: PaymentPayload, auth: xdr.SorobanAuthorizationEntry[]): PaymentPayload {
  const raw = (payload.payload as { transaction: string }).transaction;
  const tx = new Transaction(raw, NETWORK_PASSPHRASE);
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  const rebuilt = TransactionBuilder.cloneFrom(tx)
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
    .build();
  return { ...payload, payload: { ...(payload.payload as object), transaction: rebuilt.toXDR() } };
}

type Expectation = ErrorCode | readonly ErrorCode[];

interface CaseResult {
  readonly name: string;
  readonly expected: readonly string[];
  readonly observed: string;
  readonly reason: string;
  readonly ok: boolean;
}

export interface RejectionAuditOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  readonly log?: (line: string) => void;
}

export async function runRejectionAudit(options: RejectionAuditOptions): Promise<CanaryReport> {
  const run = new CanaryRun(
    "rejection-audit",
    NETWORK,
    options.facilitatorUrl,
    options.log ?? (line => console.error(line)),
  );
  const results: CaseResult[] = [];
  const sellers: SyntheticSeller[] = [];

  /**
   * Assert one rejection.
   *
   * `observe` returns what the facilitator said. Every branch below produces a coded canary failure
   * rather than an assertion message, so a red run names the property that broke.
   */
  const audit = async (
    name: string,
    expected: Expectation,
    observe: () => Promise<{ code?: unknown; reason?: unknown; accepted: boolean }>,
  ): Promise<void> => {
    const codes = (Array.isArray(expected) ? expected : [expected]) as readonly string[];
    await run.step(name, async () => {
      const seen = await observe();

      if (seen.accepted) {
        results.push({ name, expected: codes, observed: "(accepted)", reason: "", ok: false });
        throw new X402Error("canary_rejection_accepted", {
          reason: `"${name}" was ACCEPTED. It must be rejected with ${codes.join(" or ")}.`,
          details: { case: name, expected: codes },
        });
      }

      const code = typeof seen.code === "string" ? seen.code : "";
      const reason = typeof seen.reason === "string" ? seen.reason : "";

      if (!code || !ALL_ERROR_CODES.includes(code as ErrorCode)) {
        results.push({ name, expected: codes, observed: code || "(none)", reason, ok: false });
        throw new X402Error("canary_rejection_uncoded", {
          reason: code
            ? `"${name}" was rejected with "${code}", which is not in the shared error registry. An agent cannot branch on a code that is not part of the contract.`
            : `"${name}" was rejected with no machine-readable code at all.`,
          details: { case: name, code, expected: codes },
        });
      }

      // A "reason" that restates the code is the shape this criterion decays into first: still
      // non-null, still useless. Require prose, and require it to say more than the identifier.
      const restatesCode = reason.replace(/[^a-z]/gi, "").toLowerCase() === code.replace(/_/g, "");
      if (reason.trim().length < 20 || restatesCode) {
        results.push({ name, expected: codes, observed: code, reason, ok: false });
        throw new X402Error("canary_rejection_uncoded", {
          reason: `"${name}" was rejected with code "${code}" but a reason a human cannot act on: ${JSON.stringify(reason)}.`,
          details: { case: name, code, observedReason: reason },
        });
      }

      if (!codes.includes(code)) {
        results.push({ name, expected: codes, observed: code, reason, ok: false });
        throw new X402Error("canary_rejection_wrong_code", {
          reason: `"${name}" was correctly refused but reported as "${code}" rather than ${codes.join(" or ")}.`,
          details: { case: name, expected: codes, observed: code },
        });
      }

      results.push({ name, expected: codes, observed: code, reason, ok: true });
      return { detail: `${code} — ${truncate(reason)}` };
    });
  };

  try {
    await run.step("facilitator-reachable", async () => {
      const extensions = await requireBazaarFacilitator(options.facilitatorUrl);
      return { detail: `/supported advertises ${extensions.join(", ")}` };
    });

    const fixtures = (
      await run.step("testnet-fixtures", async () => {
        const f = await prepareFixtures(assetCodeFor(options.runId));
        return { detail: `asset ${f.assetCode}`, f };
      })
    ).f;

    const url = options.facilitatorUrl;

    // ── A. Protocol level — no payment required ───────────────────────────
    await audit("malformed-json", "invalid_payload", async () => {
      const r = await postRaw(url, "/verify", "{ not json");
      return { ...r.body, accepted: r.status < 400 };
    });

    await audit("missing-fields", "invalid_payload", async () => {
      const r = await postRaw(url, "/verify", JSON.stringify({ x402Version: 2 }));
      return { ...r.body, accepted: r.status < 400 };
    });

    await audit("search-without-query", "invalid_payload", async () => {
      const response = await fetch(`${url}/discovery/search`);
      const body = (await response.json()) as Record<string, unknown>;
      return { ...body, accepted: response.ok };
    });

    await audit("unknown-endpoint", "invalid_payload", async () => {
      const response = await fetch(`${url}/discovery/resource`); // singular: a plausible typo
      const body = (await response.json()) as Record<string, unknown>;
      return { ...body, accepted: response.ok };
    });

    // ── B. A real signed payment, then everything that can be wrong with it ─
    const seller = await startSyntheticSeller({
      facilitatorUrl: url,
      network: NETWORK,
      payTo: fixtures.seller.publicKey(),
      asset: fixtures.assetContractId,
      amount: AMOUNT,
      runId: options.runId,
    });
    sellers.push(seller);

    const buyer = stockBuyer(fixtures.buyer.secret());
    const good = await run.step("signed-payment", async () => {
      const built = await buyer.pay(seller.resourceUrl);
      return { detail: "stock client payload ready", ...built };
    });

    await audit("unknown-x402-version", "invalid_x402_version", async () => {
      const r = await callFacilitator(url, "/verify", { ...good.payload, x402Version: 99 }, good.accepted, 99);
      return { ...r.body, accepted: r.body["isValid"] === true };
    });

    await audit("unserved-network", "invalid_network", async () => {
      const r = await verify(url, good.payload, { ...good.accepted, network: "eip155:8453" });
      return { ...r, accepted: r["isValid"] === true };
    });

    await audit("unsupported-scheme", "unsupported_scheme", async () => {
      const r = await verify(url, good.payload, { ...good.accepted, scheme: "handshake" });
      return { ...r, accepted: r["isValid"] === true };
    });

    await audit("tampered-amount", "invalid_exact_stellar_payload_wrong_amount", async () => {
      const doubled = (BigInt(AMOUNT) * 2n).toString();
      const r = await verify(url, good.payload, { ...good.accepted, amount: doubled });
      return { ...r, accepted: r["isValid"] === true };
    });

    await audit("wrong-recipient", "invalid_exact_stellar_payload_wrong_recipient", async () => {
      const r = await verify(url, good.payload, {
        ...good.accepted,
        payTo: Keypair.random().publicKey(),
      });
      return { ...r, accepted: r["isValid"] === true };
    });

    await audit("wrong-asset", "invalid_exact_stellar_payload_wrong_asset", async () => {
      // A different asset the payer genuinely holds nothing of: a real contract address, so this
      // tests asset comparison rather than address parsing.
      const other = new Asset("OTHERX", fixtures.issuer.publicKey()).contractId(NETWORK_PASSPHRASE);
      const r = await verify(url, good.payload, { ...good.accepted, asset: other });
      return { ...r, accepted: r["isValid"] === true };
    });

    await audit("malformed-transaction", "invalid_exact_stellar_payload_malformed", async () => {
      const r = await verify(
        url,
        { ...good.payload, payload: { transaction: "not-base64-xdr" } },
        good.accepted,
      );
      return { ...r, accepted: r["isValid"] === true };
    });

    // The authorization entry IS the payment. Everything above tampers with what the payment says;
    // these two tamper with the signature covering it, which is the only thing making any of it
    // binding. `validateAuthEntries` is the most security-critical branch upstream has and nothing
    // in this battery reached it before.
    await audit("stripped-auth-entries", "invalid_exact_stellar_payload_no_auth_entries", async () => {
      // Same transaction, same amount, same recipient — with the signature removed. A facilitator
      // that settles this pays out on an unsigned instruction, which is the whole ballgame.
      const stripped = withAuth(good.payload, []);
      const r = await verify(url, stripped, good.accepted);
      return { ...r, accepted: r["isValid"] === true };
    });

    await audit(
      "auth-entry-signature-cleared",
      [
        "invalid_exact_stellar_payload_missing_payer_signature",
        "invalid_exact_stellar_payload_simulation_failed",
      ],
      async () => {
        // Keep the entry and its nonce, blank the signature. This is the shape a forged payload
        // takes: structurally perfect, cryptographically empty.
        const blanked = withAuth(
          good.payload,
          decodeAuth(good.payload).map(entry => {
            const copy = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
            if (copy.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
              copy.credentials().address().signature(xdr.ScVal.scvVec([]));
            }
            return copy;
          }),
        );
        const r = await verify(url, blanked, good.accepted);
        return { ...r, accepted: r["isValid"] === true };
      },
    );

    // ── C. Ledger-state races: sign a valid payment, then move the ledger ──
    await audit(
      "recipient-trustline-removed",
      [
        "invalid_exact_stellar_payload_missing_trustline_recipient",
        "invalid_exact_stellar_payload_simulation_failed",
      ],
      async () => {
        // A fresh seller with a trustline, a signed payment, then the trustline is dropped. This is
        // the real race, and the case our facilitator refines out of the upstream catch-all so a
        // buyer is not blamed for a seller's misconfiguration.
        const victim = await freshSeller(url, fixtures, options.runId, "trustline");
        sellers.push(victim.seller);
        const payment = await buyer.pay(victim.seller.resourceUrl);
        await submitClassic(victim.keypair, b =>
          b.addOperation(
            Operation.changeTrust({
              asset: new Asset(fixtures.assetCode, fixtures.issuer.publicKey()),
              limit: "0",
            }),
          ),
        );
        const r = await verify(url, payment.payload, payment.accepted);
        return { ...r, accepted: r["isValid"] === true };
      },
    );

    await audit(
      "payer-balance-drained",
      [
        "invalid_exact_stellar_payload_insufficient_balance",
        "invalid_exact_stellar_payload_simulation_failed",
      ],
      async () => {
        const poor = Keypair.random();
        const victim = await freshSeller(url, fixtures, options.runId, "drained");
        sellers.push(victim.seller);
        await fundWithAsset(fixtures, poor, "0.3"); // just over the price
        const poorBuyer = stockBuyer(poor.secret());
        const payment = await poorBuyer.pay(victim.seller.resourceUrl);
        // Send the balance away AFTER signing: the authorization stays valid, the funds do not.
        await submitClassic(poor, b =>
          b.addOperation(
            Operation.payment({
              destination: fixtures.issuer.publicKey(),
              asset: new Asset(fixtures.assetCode, fixtures.issuer.publicKey()),
              amount: "0.3",
            }),
          ),
        );
        const r = await verify(url, payment.payload, payment.accepted);
        return { ...r, accepted: r["isValid"] === true };
      },
    );

    // ── D. Replay — settle the good payment, then settle it again ──────────
    const settled = await run.step("settle-once", async () => {
      const { body, headers } = await callFacilitator(url, "/settle", good.payload, good.accepted);
      if (body["success"] !== true) {
        throw new X402Error("canary_settlement_failed", {
          reason: `The battery's own reference payment did not settle, so the replay case cannot run: ${JSON.stringify(body)}`,
        });
      }
      run.observe("referenceTransaction", body["transaction"]);
      return {
        detail: `tx ${String(body["transaction"]).slice(0, 12)}…`,
        verdict: decodeExtensionResponses(headers.get("extension-responses")),
      };
    });

    await audit("replayed-payload", "invalid_exact_stellar_payload_authorization_replayed", async () => {
      const r = await callFacilitator(url, "/settle", good.payload, good.accepted);
      // `errorMessage` deliberately, not `extra.reason`: this asserts the message reaches the field
      // a STOCK consumer reads. `x402HTTPResourceServer` does `errorMessage || errorReason`, so a
      // reason parked anywhere else shows the buyer a bare code string. This case caught exactly
      // that: the reason existed, in `extra`, where nothing looks.
      return {
        code: r.body["errorReason"],
        reason: r.body["errorMessage"],
        accepted: r.body["success"] === true,
      };
    });

    // ── E. Catalog integrity — reported through EXTENSION-RESPONSES ────────
    // Everything below is a hostile CLIENT, not a hostile seller: the client echoes the resource
    // block into the payload, so these fields are attacker-controlled on every single payment.
    await audit("catalog-resource-url-missing", "bazaar_missing_resource_url", async () => {
      const victim = await freshSeller(url, fixtures, options.runId, "nourl");
      sellers.push(victim.seller);
      const payment = await buyer.pay(victim.seller.resourceUrl);
      const poisoned = stripResourceUrl(payment.payload);
      return catalogVerdict(await callFacilitator(url, "/settle", poisoned, payment.accepted));
    });

    await audit("catalog-non-http-url", "bazaar_invalid_resource_url", async () => {
      const victim = await freshSeller(url, fixtures, options.runId, "ftpurl");
      sellers.push(victim.seller);
      const payment = await buyer.pay(victim.seller.resourceUrl);
      const poisoned = withResourceUrl(payment.payload, "ftp://internal.example/secret");
      return catalogVerdict(await callFacilitator(url, "/settle", poisoned, payment.accepted));
    });

    await audit("catalog-ownership-conflict", "bazaar_listing_ownership_conflict", async () => {
      // Someone else's listing, claimed by paying a different seller for the same URL. This is the
      // spoofing attack: nobody may overwrite another seller's entry
      // or its pricing.
      const attacker = await freshSeller(url, fixtures, options.runId, "attacker");
      sellers.push(attacker.seller);
      const payment = await buyer.pay(attacker.seller.resourceUrl);
      const impersonating = withResourceUrl(payment.payload, seller.catalogKey);
      return catalogVerdict(await callFacilitator(url, "/settle", impersonating, payment.accepted));
    });

    run.observe("cases", results);
    run.observe("casesPassed", results.filter(r => r.ok).length);
    run.observe("casesTotal", results.length);
    run.observe("firstSettlementCataloged", settled.verdict?.status ?? null);
    return run.finish();
  } catch (error) {
    run.observe("cases", results);
    run.observe("casesPassed", results.filter(r => r.ok).length);
    run.observe("casesTotal", results.length);
    return run.finish(error);
  } finally {
    for (const s of sellers) await s.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function verify(
  base: string,
  payload: PaymentPayload | Record<string, unknown>,
  requirements: PaymentRequirements | Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { body } = await callFacilitator(base, "/verify", payload, requirements);
  // Rejections arrive two ways: a 200 with `isValid: false` and `invalidReason`, or a 4xx/5xx with
  // a `{code, reason}` payload. Normalise so each case can state its expectation once.
  return {
    code: body["code"] ?? body["invalidReason"],
    reason: body["reason"] ?? body["invalidMessage"],
    isValid: body["isValid"],
  };
}

/** Read the cataloging verdict off a settle response, as a seller would. */
function catalogVerdict(response: {
  body: Record<string, unknown>;
  headers: Headers;
}): { code?: unknown; reason?: unknown; accepted: boolean } {
  const verdict = decodeExtensionResponses(response.headers.get("extension-responses"));
  return {
    code: verdict?.code,
    reason: verdict?.rejectedReason,
    // The PAYMENT still settles — only the listing is refused. Accepting here means the catalog
    // took the poisoned entry, which is the failure we care about.
    accepted: verdict === undefined || verdict.status === "success",
  };
}

function stripResourceUrl(payload: PaymentPayload): Record<string, unknown> {
  const copy = structuredClone(payload) as Record<string, unknown>;
  const resource = copy["resource"] as Record<string, unknown> | undefined;
  if (resource) delete resource["url"];
  return copy;
}

function withResourceUrl(payload: PaymentPayload, url: string): Record<string, unknown> {
  const copy = structuredClone(payload) as Record<string, unknown>;
  copy["resource"] = { ...((copy["resource"] as Record<string, unknown>) ?? {}), url };
  return copy;
}

/** A throwaway paid endpoint with its own payTo, for cases that must not disturb the main one. */
async function freshSeller(
  facilitatorUrl: string,
  fixtures: Fixtures,
  runId: string,
  label: string,
): Promise<{ seller: SyntheticSeller; keypair: Keypair }> {
  const keypair = Keypair.random();
  await fundAndTrust(fixtures, keypair);
  const seller = await startSyntheticSeller({
    facilitatorUrl,
    network: NETWORK,
    payTo: keypair.publicKey(),
    asset: fixtures.assetContractId,
    amount: AMOUNT,
    runId: `${runId}-${label}`,
  });
  return { seller, keypair };
}

async function fundAndTrust(fixtures: Fixtures, kp: Keypair): Promise<void> {
  await friendbotFund(kp);
  await submitClassic(kp, b =>
    b.addOperation(
      Operation.changeTrust({ asset: new Asset(fixtures.assetCode, fixtures.issuer.publicKey()) }),
    ),
  );
}

async function fundWithAsset(fixtures: Fixtures, kp: Keypair, amount: string): Promise<void> {
  await fundAndTrust(fixtures, kp);
  await submitClassic(fixtures.issuer, b =>
    b.addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: new Asset(fixtures.assetCode, fixtures.issuer.publicKey()),
        amount,
      }),
    ),
  );
}

function truncate(text: string): string {
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}
