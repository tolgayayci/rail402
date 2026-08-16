/**
 * Buyer/agent surface — re-exports `@rail402.dev/agent-helpers` verbatim.
 *
 * `searchBazaar` (find a service), `payAndFetch` (pay a known URL under a spend cap), and
 * `discoverAndPay` (do both). A `maxAmount` cap is mandatory and the price is read before any money
 * moves — see the underlying package for the guarantees.
 *
 * @module
 */
export * from "@rail402.dev/agent-helpers";
