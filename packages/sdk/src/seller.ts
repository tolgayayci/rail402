/**
 * Seller surface — re-exports `@rail402.dev/seller-helpers` verbatim.
 *
 * `describeEndpoint` / `describeTool` declare discovery metadata that is correct by construction
 * (branded so it cannot be double-wrapped), and `preflight` catches the setup mistakes that would
 * otherwise only surface when a real buyer's payment fails.
 *
 * @module
 */
export * from "@rail402.dev/seller-helpers";
