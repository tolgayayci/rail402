/**
 * The operational exercises: what each one proves, how it is run, and the tests that run it. The
 * tests are the exercise; `ops.ts` runs them, joins their results with what they recorded through
 * `recordOps`, and writes the evidence the operational test report is rendered from. Nothing here is
 * a result: an exercise shows as run only once `ops.ts --write` recorded it.
 *
 * `testnet` lists conformance cases (`harness#case`) that exercise the same behaviour against the
 * public testnet; the report shows their recorded outcome next to the local run.
 */
import { evidenceFileName, type CheckId } from "./evidence.ts";

/** Where `ops.ts --write` records the local run. */
export const OPS_EVIDENCE_FILE = evidenceFileName("ops", "stellar:testnet", "local");

/** One test's result in a recorded run. */
export interface TestOutcome {
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly durationMs: number;
}

export interface ExerciseTest {
  /** The file that defines the test. */
  readonly file: string;
  /** The test's name, or a literal part of it for a parameterised name. */
  readonly name: string;
  /** The test file that runs it, when the test is defined in a shared suite. */
  readonly runIn?: string;
}

export interface OpsExercise {
  readonly id: string;
  readonly title: string;
  /** Threat ids from docs/security/threats.json. */
  readonly threats: readonly string[];
  readonly checks: readonly CheckId[];
  readonly environment: string;
  readonly procedure: string;
  readonly expected: string;
  readonly tests: readonly ExerciseTest[];
  readonly testnet?: readonly string[];
}

const PRIVATE = "Private Stellar network (1 s ledgers)";
const PRIVATE_PG = "Private Stellar network (1 s ledgers) and Postgres";
const SERVICE = "The Rail402 service on the private network";
const KILLED = "Rail402 service processes over Postgres on the private network, killed with SIGKILL";
const SOCKETS = "Local sockets and a stub resolver";
const UNIT = "In-process, with the RPC or store simulated";

const SI = "packages/facilitator/test/settlement.integration.test.ts";
const IDEM = "apps/rail402/test/idempotency.integration.test.ts";
const FR = "packages/facilitator/test/front-run.integration.test.ts";
const FE = "packages/facilitator/test/fee-exposure.integration.test.ts";
const EXP = "packages/facilitator/test/expiration.integration.test.ts";
const OBS = "apps/rail402/test/observability.integration.test.ts";
const CRASH = "apps/rail402/test/crash-recovery.integration.test.ts";
const FUP = "packages/facilitator/test/upto.integration.test.ts";
const CAT = "packages/bazaar/src/testing.ts";
const STORES = "packages/store-postgres/test/stores.integration.test.ts";
const SFE = "packages/safe-fetch/test/egress.integration.test.ts";
const UPAY = "apps/rail402/test/upto-payers.integration.test.ts";
const US = "apps/rail402/test/upto-settlement.integration.test.ts";

export const EXERCISES: readonly OpsExercise[] = [
  {
    id: "replay-sequential",
    title: "A settled payment sent to /settle again",
    threats: ["R1"],
    checks: ["idempotency"],
    environment: PRIVATE_PG,
    procedure:
      "Settle an exact payment, then send the same payload and requirements again, with the in-memory and the Postgres settlement ledger.",
    expected:
      "The repeat is answered with the recorded response and a repeat marker; one transfer on chain; nothing is submitted again.",
    tests: [
      { file: IDEM, name: "answers a sequential repeat with the recorded response, marked as a repeat" },
      { file: SI, name: "answers a repeated settle with the original result and moves funds once" },
    ],
    testnet: ["live-matrix#replay-idempotent", "live-matrix#replay-late"],
  },
  {
    id: "replay-concurrent",
    title: "Concurrent copies of one payment",
    threats: ["R1", "S6"],
    checks: ["idempotency", "concurrency"],
    environment: PRIVATE_PG,
    procedure: "Send five copies of one payment to /settle at the same moment.",
    expected:
      "One transaction, one transfer; every caller gets the same body; four answers are marked as repeats.",
    tests: [
      { file: IDEM, name: "settles 5 concurrent repeats once: one transfer, one original, identical bodies" },
      { file: SI, name: "settles concurrent duplicates exactly once, all callers getting the same result" },
    ],
    testnet: ["live-matrix#replay-concurrent"],
  },
  {
    id: "replay-new-envelope",
    title: "A settled authorization in a new envelope",
    threats: ["R2"],
    checks: ["idempotency", "rejection-codes"],
    environment: PRIVATE_PG,
    procedure: "Re-wrap a settled authorization entry in a transaction with different bytes and settle it.",
    expected: "Refused with the idempotency conflict naming the recorded transaction; nothing is submitted.",
    tests: [
      {
        file: IDEM,
        name: "refuses the same authorization in another envelope, naming the recorded transaction",
      },
      {
        file: SI,
        name: "refuses a settled authorization in a different envelope, and verify names the replay",
      },
    ],
    testnet: ["live-matrix#replay-rejected"],
  },
  {
    id: "replay-upfront",
    title: "One payment signature sent twice to a seller",
    threats: ["R4"],
    checks: ["idempotency"],
    environment: PRIVATE,
    procedure:
      "Pay a seller built with the seller helpers, then send the same PAYMENT-SIGNATURE again, in the authorization and the upfront flow.",
    expected:
      "The resource is served once; the second request is refused; the facilitator's repeat marker is honoured.",
    tests: [
      {
        file: "packages/sdk/test/seller.integration.test.ts",
        name: "does not serve a replayed payment signature again",
      },
      {
        file: "packages/sdk/test/seller.integration.test.ts",
        name: "serves an upfront settlement once when the facilitator answers its repeat",
      },
    ],
  },
  {
    id: "front-run",
    title: "A copied exact authorization lands first",
    threats: ["F1", "F2"],
    checks: ["front-running"],
    environment: PRIVATE,
    procedure:
      "The RPC proxy runs an attacker right before Rail402's sendTransaction is forwarded: the attacker copies the payer's authorization entry into its own transaction and lands it.",
    expected:
      "Rail402's transaction fails on chain; the answer is a success with the attacker's hash; the payer is debited once; exactly one wasted fee equal to the sponsor's balance change.",
    tests: [
      {
        file: FR,
        name: "answers success with the attacker's hash; the payment moves once and our fee is wasted",
      },
      { file: FR, name: "refuses an authorization consumed before the request was claimed" },
      {
        file: FR,
        name: "refuses when the consuming transaction carried a different invocation for the same nonce",
      },
    ],
  },
  {
    id: "front-run-upto",
    title: "Front-running an upto settlement",
    threats: ["F3", "F4"],
    checks: ["front-running", "scheme-upto"],
    environment: PRIVATE,
    procedure:
      "An attacker without the settlement authority copies an upto settlement and submits it first; then a transaction signed by the authority itself lands first.",
    expected:
      "The attacker's copy fails and Rail402's settlement proceeds; a landing by the authority for the same amount is answered with its hash.",
    tests: [
      {
        file: FR,
        name: "cannot be landed by an attacker without the settlement authority; Rail402's settlement proceeds",
      },
      {
        file: FR,
        name: "answers with the authority's own earlier transaction for the same amount; our fee is wasted",
      },
    ],
  },
  {
    id: "smart-account-signer",
    title: "A smart-account payment signed by a key the account does not accept",
    threats: ["A1"],
    checks: ["scheme-exact", "scheme-upto"],
    environment: PRIVATE_PG,
    procedure:
      "Sign an exact payment from a custom account (C…) with a random key, and an upto payment from a custom account with another key, and send them to /verify and /settle.",
    expected:
      "Both are refused before anything is submitted, named as the account's own rejection (smart_account_rejected or invalid_signature); nothing moves.",
    tests: [
      { file: SI, name: "rejects a smart-account payment signed by the wrong key" },
      { file: UPAY, name: "refuses a signature by another key as the account's own rejection" },
    ],
    testnet: ["live-matrix#c-payer-wrong-key", "rejection-audit#upto-c-payer-wrong-key"],
  },
  {
    id: "smart-account-budget",
    title: "An OpenZeppelin smart account paying with an agent key under a spending limit",
    threats: ["A4", "A5", "A6"],
    checks: ["scheme-upto"],
    environment: PRIVATE_PG,
    procedure:
      "Deploy an OpenZeppelin smart account whose agent key may only pay through a rule with the spending-limit policy, pay upto within the budget, then over it, then try to use the owner's policy-free default rule with the agent key.",
    expected:
      "Payments within the budget settle and reserve their full cap; a payment over the limit and a cap that would exceed the remaining budget are refused with nothing moved; the agent key cannot use the default rule.",
    tests: [
      { file: UPAY, name: "refuses a payment over its own spending limit, and nothing moves" },
      { file: UPAY, name: "has reserved the full cap of each payment against its budget" },
      { file: UPAY, name: "does not let the agent key use the owner's policy-free default rule" },
      { file: UPAY, name: "pays up to its budget and refuses the cap that would exceed it" },
    ],
    testnet: ["live-matrix#upto-c-over-limit"],
  },
  {
    id: "smart-account-apply-failure",
    title: "A smart account whose __check_auth passes simulation and fails at inclusion",
    threats: ["A2"],
    checks: ["fees-sponsored"],
    environment: PRIVATE,
    procedure:
      "Pay exact from an OpenZeppelin smart account with a delegate key under its own context rule, then, through the RPC proxy between the settle-time simulation and the broadcast, have the owner remove that rule.",
    expected:
      "The transaction fails on chain in the account's __check_auth, is named smart_account_rejected, moves nothing, and its fee is the only sponsor cost, counted as wasted.",
    tests: [
      {
        file: FE,
        name: "names a smart account whose __check_auth passes the settle-time simulation and fails at inclusion",
      },
    ],
  },
  {
    id: "balance-race",
    title: "The payer spends the balance before settlement lands",
    threats: ["S1"],
    checks: ["fees-sponsored"],
    environment: PRIVATE,
    procedure:
      "Verify a payment, then move the payer's whole balance away: once before /settle, and once through the RPC proxy between the settle-time simulation and the broadcast.",
    expected:
      "Before settle: refused as insufficient_funds with nothing submitted. After simulation: the transaction fails on chain, is named insufficient_funds, and its fee is the only sponsor cost, counted as wasted.",
    tests: [
      {
        file: FE,
        name: "refuses at settle, with nothing submitted, a payment whose balance moved after verify",
      },
      {
        file: FE,
        name: "names a balance spent between the settle-time simulation and inclusion; the fee is spent and counted as wasted",
      },
    ],
  },
  {
    id: "expiry-race",
    title: "An authorization that expires while the settlement waits",
    threats: ["S2"],
    checks: ["expiration"],
    environment: PRIVATE,
    procedure:
      "Hold an exact settlement at the RPC proxy until its authorization's expiration ledger has passed; hold an upto settlement past its expiration_ledger.",
    expected:
      "exact: included and failed, named signature_expired, fee spent. upto: refused by the network before inclusion (ledger bounds), no fee spent.",
    tests: [
      {
        file: EXP,
        name: "names an authorization that expires between submission and inclusion; the fee is spent",
      },
      {
        file: EXP,
        name: "refuses at the network an upto settlement held past expiration_ledger; no fee is spent",
      },
      { file: EXP, name: "holds the lower edge at the current ledger plus a one-ledger margin" },
    ],
    testnet: ["live-matrix#expiry-window", "live-matrix#upto-expiry-window"],
  },
  {
    id: "ceiling-refusal",
    title: "A settlement above the fee ceiling",
    threats: ["S3"],
    checks: ["fees-sponsored", "rejection-codes"],
    environment: PRIVATE,
    procedure:
      "Configure a fee ceiling below the payment's simulated fee and send it to /verify and /settle.",
    expected:
      "Both refuse with invalid_exact_stellar_payload_fee_exceeds_maximum; nothing is recorded or submitted; the sponsor's balance is unchanged.",
    tests: [
      {
        file: FE,
        name: "refuses a payment whose settlement would cost more than the fee ceiling, before signing anything",
      },
      { file: "packages/upto/test/facilitator.test.ts", name: "enforces the fee ceiling" },
    ],
  },
  {
    id: "budget-trip",
    title: "The hourly fee budget is reached",
    threats: ["S4"],
    checks: ["fees-sponsored"],
    environment: PRIVATE,
    procedure: "Set an hourly fee budget that one settlement exhausts; settle one payment, then another.",
    expected:
      "The first settles; the second is refused with settle_exact_stellar_sponsor_unavailable before any RPC work, and the refusal is counted as a budget refusal.",
    tests: [
      { file: FE, name: "stops settling once the hourly fee budget is committed, before any RPC work" },
      {
        file: "packages/facilitator/test/fees.test.ts",
        name: "refuses once the hourly fee budget is committed",
      },
    ],
  },
  {
    id: "sponsor-floor",
    title: "The sponsor below its reserve",
    threats: ["S5"],
    checks: ["observability", "fees-sponsored"],
    environment: SERVICE,
    procedure:
      "Run the service with a reserve floor above the sponsor's balance, and with a readiness floor above it.",
    expected:
      "Settlements are refused and counted as reserve refusals; /health reports the sponsor below its floor; /ready fails.",
    tests: [
      { file: OBS, name: "counts refusals below the reserve and reports the sponsor below its floor" },
      {
        file: "apps/rail402/test/runtime.integration.test.ts",
        name: "fails while the sponsor holds less than MIN_SPONSOR_BALANCE_XLM",
      },
    ],
  },
  {
    id: "ssrf-origin",
    title: "Origin checks and SEP-1 fetches to private addresses",
    threats: ["X1", "X5"],
    checks: ["discovery"],
    environment: SOCKETS,
    procedure:
      "Catalog resources whose URLs are private IP literals or names that resolve to private addresses; fetch a stellar.toml from a private address.",
    expected:
      "Refused before any connection is made, unless loopback is explicitly allowed; never with pubnet.",
    tests: [
      {
        file: "packages/bazaar/test/origin.test.ts",
        name: "refuses a host whose DNS answers are not public, before connecting",
      },
      {
        file: "packages/bazaar/test/egress.test.ts",
        name: "refuses a private IP literal for origin checks unless loopback is allowed",
      },
      {
        file: "packages/bazaar/test/stellar-toml.test.ts",
        name: "never connects to a private address unless loopback is explicitly allowed",
      },
      {
        file: "apps/rail402/test/config.test.ts",
        name: "refuses loopback discovery fetches on a service that serves pubnet",
      },
    ],
  },
  {
    id: "ssrf-rebinding",
    title: "DNS rebinding",
    threats: ["X2"],
    checks: ["discovery", "mcp"],
    environment: SOCKETS,
    procedure:
      "Resolve a name to a public and a private address, and to a private address on the second lookup.",
    expected: "The private address is never dialled.",
    tests: [
      { file: SFE, name: "checks every DNS answer, so a rebinding name cannot reach a private address" },
    ],
  },
  {
    id: "ssrf-redirect",
    title: "Redirects to private or other destinations",
    threats: ["X3"],
    checks: ["discovery", "mcp"],
    environment: SOCKETS,
    procedure:
      "Answer an origin check and a buyer request with redirects to a private address and to another origin.",
    expected:
      "Origin checks follow no redirect; buyers follow none to a private or other origin, and none after paying.",
    tests: [
      { file: SFE, name: "never follows a redirect towards a private or other destination" },
      { file: "packages/bazaar/test/origin.test.ts", name: "does not follow redirects" },
    ],
    testnet: ["rejection-audit#mcp-redirect-private"],
  },
  {
    id: "ssrf-oversized",
    title: "Oversized, compressed and slow answers",
    threats: ["X4"],
    checks: ["discovery", "mcp"],
    environment: SOCKETS,
    procedure: "Serve a body larger than the cap, a compression bomb, and answers that stall.",
    expected: "Stopped at the decoded size limit and at the header, idle and total timeouts.",
    tests: [
      { file: SFE, name: "stops oversized and compressed-bomb answers at the decoded limit" },
      {
        file: "packages/safe-fetch/test/fetch.test.ts",
        name: "times out waiting for headers, on an idle body, and in total",
      },
    ],
  },
  {
    id: "catalog-takeover",
    title: "Another payTo pays for a listed resource",
    threats: ["P2"],
    checks: ["discovery", "rejection-codes"],
    environment: SERVICE,
    procedure:
      "After a resource is listed, settle a payment for the same URL to a different payTo through a real seller.",
    expected:
      "The listing is unchanged; the settlement reports bazaar_owner_conflict in EXTENSION-RESPONSES.",
    tests: [
      {
        file: "apps/rail402/test/bazaar.integration.test.ts",
        name: "refuses a different payTo for the same resource, with a coded reason",
      },
      { file: CAT, name: "never lets a different payTo modify a listing", runIn: STORES },
      { file: CAT, name: "transfers ownership only when the origin names the new payTo", runIn: STORES },
    ],
    testnet: ["live-bazaar#owner-conflict"],
  },
  {
    id: "forged-metadata",
    title: "Echoed metadata that the origin does not confirm",
    threats: ["P1"],
    checks: ["discovery"],
    environment: "Postgres",
    procedure: "Settle payments whose resource block carries a changed description and price.",
    expected: "The listing changes only when the resource's own 402 confirms the new metadata.",
    tests: [
      {
        file: CAT,
        name: "does not let echoed metadata change a listing until the origin confirms it",
        runIn: STORES,
      },
      { file: CAT, name: "never lists an HTTP resource whose own response is not a 402", runIn: STORES },
    ],
    testnet: ["live-bazaar#forged-metadata"],
  },
  {
    id: "mcp-tool-planting",
    title: "A payer plants content under a seller's MCP tool",
    threats: ["P9"],
    checks: ["discovery", "mcp"],
    environment: "Postgres",
    procedure:
      "Pay a seller's payTo one base unit, exact and upto under a huge cap, echoing the seller's MCP endpoint and tool with a forged description and price; then settle the tool's real price.",
    expected:
      "The planted listing stays pending and is quarantined with origin_payment_mismatch; the real settlement publishes the tool's own content, and a planted settlement never changes or withdraws a confirmed tool.",
    tests: [
      {
        file: CAT,
        name: "never publishes a tool description or price planted with",
        runIn: STORES,
      },
      {
        file: CAT,
        name: "never lets a planted settlement withdraw or change a tool its origin confirmed",
        runIn: STORES,
      },
      {
        file: "packages/bazaar/test/mcp-origin.test.ts",
        name: "reads a tool's PaymentRequired from its unpaid call, sending the example arguments",
      },
    ],
    testnet: ["live-bazaar#mcp-tool"],
  },
  {
    id: "schema-redos",
    title: "Hostile JSON Schema",
    threats: ["P3"],
    checks: ["discovery"],
    environment: UNIT,
    procedure:
      "Validate metadata against schemas with catastrophic patterns, combinatorial checks, deep nesting and external references.",
    expected: "Each stops within its budget or is refused before compiling; the sandbox keeps serving.",
    tests: [
      {
        file: "packages/bazaar/test/security.test.ts",
        name: "stops a catastrophic-backtracking pattern within its budget and keeps serving",
      },
      {
        file: "packages/bazaar/test/security.test.ts",
        name: "stops a combinatorial uniqueItems check within its budget",
      },
      {
        file: "packages/bazaar/test/security.test.ts",
        name: "finds external references in every schema position, and only there",
      },
    ],
    testnet: ["live-bazaar#schema-rejected"],
  },
  {
    id: "route-traversal",
    title: "Encoded traversal in route templates and parameters",
    threats: ["P4"],
    checks: ["discovery"],
    environment: "Postgres",
    procedure:
      "Catalog templates that decode to NUL, CR, LF, a backslash or an empty segment; fill parameters with encoded dot segments.",
    expected: "Unsafe templates are not used; unsafe parameter values are refused before any request.",
    tests: [
      {
        file: "packages/bazaar/test/security.test.ts",
        name: "refuses route templates that decode to NUL, CR, LF, a backslash or an empty segment",
      },
      {
        file: CAT,
        name: "uses a routeTemplate only when it is safe and matches the paid path",
        runIn: STORES,
      },
      { file: "packages/sdk/test/discovery.test.ts", name: "fills route parameters and refuses traversal" },
    ],
    testnet: ["live-bazaar#route-template"],
  },
  {
    id: "crash-k0",
    title: "Killed after the network accepted the transaction",
    threats: ["O1"],
    checks: ["crash-recovery"],
    environment: KILLED,
    procedure: "SIGKILL the service right after sendTransaction returned; restart it.",
    expected: "Recovery finds the accepted transaction; no replacement is submitted; one transfer.",
    tests: [{ file: CRASH, name: "K0: finds the transaction the network accepted before the process died" }],
    testnet: ["fault-recovery#k0-exact", "fault-recovery#k0-upto"],
  },
  {
    id: "crash-k1",
    title: "Killed before the broadcast left",
    threats: ["O1"],
    checks: ["crash-recovery"],
    environment: KILLED,
    procedure: "Hold the broadcast at the RPC proxy, SIGKILL the service, drop the held request, restart.",
    expected: "Recovery rebroadcasts the identical recorded bytes; one transaction hash; one transfer.",
    tests: [
      { file: CRASH, name: "K1: rebroadcasts the identical recorded bytes when the broadcast never left" },
    ],
    testnet: ["fault-recovery#k1-exact", "fault-recovery#k1-upto"],
  },
  {
    id: "crash-k2",
    title: "Killed after inclusion, before confirmation",
    threats: ["O1"],
    checks: ["crash-recovery"],
    environment: KILLED,
    procedure: "Hide the transaction from getTransaction until the service is killed; restart.",
    expected: "Recovery finds the included transaction and answers its success.",
    tests: [
      { file: CRASH, name: "K2: finds a transaction that was included before the process saw it confirmed" },
    ],
  },
  {
    id: "crash-k3",
    title: "Down until the time bound passed",
    threats: ["O1"],
    checks: ["crash-recovery"],
    environment: KILLED,
    procedure:
      "Drop the broadcast, keep the service down until the transaction's time bound has passed, restart.",
    expected: "The settlement expires only because retained history proves it absent; nothing moves.",
    tests: [
      {
        file: CRASH,
        name: "K3: expires a transaction whose time bound passed while the service was down, and nothing moves",
      },
    ],
    testnet: ["fault-recovery#k3-exact"],
  },
  {
    id: "crash-unresolvable",
    title: "A settlement beyond the RPC's retention",
    threats: ["O4"],
    checks: ["crash-recovery", "observability"],
    environment: KILLED,
    procedure: "Restart with a recorded settlement whose ledgers the RPC no longer retains.",
    expected: "It stays unresolved and is reported in /health and the metrics; it is never expired.",
    tests: [
      {
        file: CRASH,
        name: "keeps a settlement the RPC can no longer prove absent unresolved, and reports it",
      },
    ],
  },
  {
    id: "concurrency",
    title: "Three batches of twenty concurrent settlements",
    threats: ["O2", "S6"],
    checks: ["concurrency"],
    environment: PRIVATE,
    procedure:
      "Settle 3 batches of 20 payments over 8 channels, exact, upto and mixed, with duplicates injected into every batch.",
    expected:
      "Every payment settles once; distinct (source, sequence) pairs; no txBadSeq or TRY_AGAIN_LATER.",
    tests: [
      {
        file: "packages/facilitator/test/concurrency.integration.test.ts",
        name: "with injected duplicates, without a collision",
      },
    ],
    testnet: ["concurrency#distinct-sequences"],
  },
  {
    id: "replicas",
    title: "Two replicas on one Postgres",
    threats: ["O2", "R1"],
    checks: ["concurrency", "idempotency"],
    environment: "Two Rail402 service processes over one Postgres on the private network",
    procedure: "Run two service replicas on one Postgres and send every duplicate to the other replica.",
    expected: "One settlement per payment across replicas; no channel is leased twice.",
    tests: [
      {
        file: "apps/rail402/test/replicas.integration.test.ts",
        name: "with every duplicate sent to the other replica",
      },
    ],
  },
  {
    id: "seq-conflict",
    title: "A channel used behind the service's back",
    threats: ["O2"],
    checks: ["observability"],
    environment: SERVICE,
    procedure: "Submit a transaction from a channel account outside the service, then settle through it.",
    expected: "The conflict is counted in rail402_sequence_conflicts_total.",
    tests: [
      { file: OBS, name: "counts a sequence conflict when a channel's sequence is used behind its back" },
    ],
  },
  {
    id: "rpc-outage",
    title: "The RPC stops answering",
    threats: ["O3"],
    checks: ["observability"],
    environment: SERVICE,
    procedure: "Make the RPC proxy answer errors, then recover.",
    expected:
      "/ready fails while the RPC is unreachable; transport errors are counted and reported in /health.",
    tests: [
      { file: "apps/rail402/test/runtime.integration.test.ts", name: "fails while the RPC is unreachable" },
      {
        file: OBS,
        name: "counts transport and request errors while the RPC fails, and reports it in /health",
      },
    ],
  },
  {
    id: "store-outage",
    title: "The settlement store fails",
    threats: ["O3"],
    checks: ["idempotency", "observability"],
    environment: PRIVATE_PG,
    procedure:
      "Fail the envelope write before broadcast; fail the ledger read at verify; close Postgres' idle connections.",
    expected:
      "Nothing is broadcast without a record and the payment stays retryable; verify stays available; the pool reconnects.",
    tests: [
      {
        file: SI,
        name: "broadcasts nothing when the envelope cannot be recorded first, leaving the payment retryable",
      },
      { file: IDEM, name: "keeps verify available when the ledger cannot be read" },
      { file: STORES, name: "survives the server closing its idle connections, as in a restart or failover" },
    ],
  },
  {
    id: "channel-exhaustion",
    title: "Every channel busy",
    threats: ["O5"],
    checks: ["concurrency", "observability"],
    environment: PRIVATE,
    procedure: "Hold every channel and settle; send more settlements than channels to a service.",
    expected: "A retryable channel_unavailable refusal with no record left; lease waits are measured.",
    tests: [
      { file: SI, name: "refuses when no channel frees up in time, leaving the payment retryable" },
      { file: OBS, name: "measures the wait for a channel when settlements outnumber channels" },
    ],
  },
  {
    id: "ttl-extend",
    title: "Extending the upto contract's TTL",
    threats: ["U7"],
    checks: ["observability", "scheme-upto"],
    environment: SERVICE,
    procedure:
      "Let the keeper and the operator command extend the settlement contract's instance and code entries.",
    expected: "Both entries' liveUntilLedgerSeq move; /health and the TTL gauge report the new values.",
    tests: [
      {
        file: "apps/rail402/test/upto.integration.test.ts",
        name: "extends the contract from the keeper and the operator command, and reports its TTL",
      },
    ],
  },
  {
    id: "ttl-restore",
    title: "An archived upto contract",
    threats: ["U7", "S7"],
    checks: ["observability", "scheme-upto"],
    environment: "A dedicated Stellar network with short TTLs, and the service",
    procedure:
      "Let the settlement contract's entries expire, pay while archived, then restore by the operator command and by the keeper.",
    expected:
      "Payments are refused with invalid_upto_stellar_settlement_contract_archived and nothing is submitted; after restoration they settle.",
    tests: [
      {
        file: "apps/rail402/test/upto-archival.integration.test.ts",
        name: "refuses payments while the contract is archived, and settles once an operator restores it",
      },
      {
        file: "apps/rail402/test/upto-archival.integration.test.ts",
        name: "is restored by the TTL keeper where automatic restoration is allowed",
      },
    ],
  },
  {
    id: "degraded-indexing",
    title: "The embedder fails",
    threats: ["O7"],
    checks: ["discovery", "observability"],
    environment: UNIT,
    procedure: "Make the embedding model throw or time out during search and index builds.",
    expected: "Search answers lexical-only with partialResults: true; index builds are counted as degraded.",
    tests: [
      {
        file: "packages/search/test/search.test.ts",
        name: "answers lexical-only, as partial results, when the embedder fails or runs out of time",
      },
      {
        file: "packages/search/test/search.test.ts",
        name: "builds a lexical-only snapshot when listings cannot be embedded",
      },
    ],
  },
  {
    id: "mcp-cap",
    title: "Paid calls above the agent's caps",
    threats: ["M1"],
    checks: ["mcp"],
    environment: PRIVATE,
    procedure:
      "Ask rail402-mcp and the guarded signer to pay above the per-call cap; run concurrent payments against one session budget.",
    expected: "Refused before signing; the session budget is never exceeded; balances unchanged.",
    tests: [
      {
        file: "packages/mcp/test/pay.integration.test.ts",
        name: "refuses a price above the caller's cap before signing",
      },
      {
        file: "packages/sdk/test/guard.integration.test.ts",
        name: "refuses to sign a payment above the per-call cap",
      },
      {
        file: "packages/sdk/test/guard.test.ts",
        name: "never lets 20 concurrent payments exceed the session budget",
      },
    ],
    testnet: ["rejection-audit#mcp-per-call-cap"],
  },
  {
    id: "mcp-ssrf",
    title: "Paid calls to private destinations",
    threats: ["X6"],
    checks: ["mcp"],
    environment: SOCKETS,
    procedure:
      "Ask the buyer to pay URLs on this machine in every IP spelling and a name that resolves to a private address.",
    expected: "Refused before anything is sent, without naming the address.",
    tests: [
      { file: SFE, name: "refuses IP-literal URLs to this machine in every spelling, before connecting" },
      {
        file: "packages/sdk/test/http-flow.test.ts",
        name: "refuses private destinations before sending anything",
      },
    ],
    testnet: ["rejection-audit#mcp-private-address"],
  },
  {
    id: "mcp-secret-scan",
    title: "Canary key scan of the MCP server, SDK and CLI",
    threats: ["M3"],
    checks: ["mcp"],
    environment: PRIVATE,
    procedure:
      "Pay through every outcome with a canary signing key, capturing protocol frames, tool results, logs at trace level, stdout, stderr and the budget ledger.",
    expected: "No seed, raw key bytes, signature or payment header appears in any captured channel.",
    tests: [
      {
        file: "packages/mcp/test/secrets.integration.test.ts",
        name: "leaks nothing into frames, logs or the ledger",
      },
      {
        file: "packages/sdk/test/secrets.integration.test.ts",
        name: "leaks nothing, and the payment reached only the paid origin",
      },
      {
        file: "packages/cli/test/secrets.integration.test.ts",
        name: "leaks nothing on stdout, stderr or in the ledger",
      },
    ],
  },
  {
    id: "upto-over-cap",
    title: "An upto settlement above the cap",
    threats: ["U1"],
    checks: ["scheme-upto", "rejection-codes"],
    environment: UNIT,
    procedure: "Ask the upto facilitator to settle more than the signed cap.",
    expected: "Refused before simulating, with the payer and a reason.",
    tests: [
      {
        file: "packages/upto/test/facilitator.test.ts",
        name: "refuses an amount above the cap before simulating",
      },
    ],
    testnet: ["live-matrix#upto-over-cap", "rejection-audit#upto-settle-over-cap"],
  },
  {
    id: "upto-zero",
    title: "Zero upto settlements",
    threats: ["R5", "U6"],
    checks: ["scheme-upto", "idempotency"],
    environment: PRIVATE,
    procedure: "Settle an upto payment for zero on chain, and off chain where configured.",
    expected:
      "On chain: the nonce is consumed and no funds move. Off chain: no transaction, the authorization used up in the ledger.",
    tests: [
      { file: FUP, name: "settles zero on-chain: the nonce is consumed and no funds move" },
      {
        file: FUP,
        name: "settles zero off-chain when configured: no transaction, the authorization used up in the ledger",
      },
    ],
    testnet: ["live-matrix#upto-zero", "live-matrix#upto-c-zero", "live-bazaar#upto-offchain-zero"],
  },
  {
    id: "upto-concurrent",
    title: "Concurrent upto requests for different amounts",
    threats: ["U3", "F5"],
    checks: ["scheme-upto", "idempotency", "concurrency"],
    environment: PRIVATE_PG,
    procedure:
      "Send five settle requests for one upto authorization with different amounts at once; then settle a copy of a payload for zero before the seller settles it.",
    expected:
      "One success, four idempotency conflicts, one transfer; the first accepted amount holds the authorization and the seller's later request is a conflict.",
    tests: [
      {
        file: IDEM,
        name: "settles 5 concurrent requests for different amounts once: one success, four conflicts",
      },
      {
        file: US,
        name: "lets the first settle request fix the amount: a payload holder's zero turns the seller's settle into a conflict",
      },
    ],
    testnet: ["live-matrix#upto-repeat-different-amount", "live-matrix#upto-concurrent-same-authorization"],
  },
  {
    id: "upto-third-party-amount",
    title: "An upto settlement landed first by another holder of the authority",
    threats: ["F4"],
    checks: ["scheme-upto", "front-running"],
    environment: PRIVATE,
    procedure:
      "Land the same upto authorization from another process holding the authority, for the same and for a different amount.",
    expected:
      "Same amount: success with that transaction. Different amount: settle_upto_stellar_settled_elsewhere naming both amounts.",
    tests: [
      { file: FUP, name: "succeeds with that transaction when it settled the same amount" },
      { file: FUP, name: "answers settled_elsewhere when it settled a different amount" },
    ],
  },
  {
    id: "rotation-channels",
    title: "The channel steps of a sponsor rotation",
    threats: ["O6"],
    checks: ["observability"],
    environment: PRIVATE_PG,
    procedure:
      "Run channels status, provision and retire against the network, with the memory store and with Postgres.",
    expected:
      "Channels are provisioned and merged back into the sponsor; retire refuses while a channel is leased.",
    tests: [
      {
        file: "apps/rail402/test/channels.integration.test.ts",
        name: "reports, provisions and retires channel accounts with STORE=memory",
      },
      {
        file: "apps/rail402/test/channels.integration.test.ts",
        name: "reports durable state and refuses to retire while a channel is leased",
      },
    ],
  },
];
