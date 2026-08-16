/**
 * `@rail402.dev/sdk` — one install for the Rail402 app-developer surface on Stellar.
 *
 * This package adds no behaviour of its own. It re-exports three packages so a newcomer installs and
 * imports **one** thing instead of learning the package graph:
 *
 * - **buyer/agent** — `searchBazaar`, `payAndFetch`, `discoverAndPay` (from `@rail402.dev/agent-helpers`)
 * - **seller** — `describeEndpoint`, `describeTool`, `preflight` (from `@rail402.dev/seller-helpers`)
 * - **errors** — `X402Error`, `ErrorCode`, `createError`, the machine-readable registry (from `@rail402.dev/errors`)
 *
 * The three underlying packages export disjoint names, so the flat re-export below is unambiguous.
 * When you only want one role, import the narrower entry point and pull in only that surface:
 *
 * ```ts
 * import { discoverAndPay } from "@rail402.dev/sdk/buyer";
 * import { describeEndpoint } from "@rail402.dev/sdk/seller";
 * import { X402Error }        from "@rail402.dev/sdk/errors";
 * ```
 *
 * The individual packages remain published and are the lean/advanced path; this umbrella is the
 * batteries-included "start here" convenience. It never re-implements anything it re-exports.
 *
 * @module
 */

export * from "@rail402.dev/agent-helpers";
export * from "@rail402.dev/seller-helpers";
export * from "@rail402.dev/errors";
