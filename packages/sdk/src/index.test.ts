import { describe, it, expect } from "vitest";

import * as root from "./index.js";
import * as buyer from "./buyer.js";
import * as seller from "./seller.js";
import * as errorsEntry from "./errors.js";

import * as agentHelpers from "@rail402.dev/agent-helpers";
import * as sellerHelpers from "@rail402.dev/seller-helpers";
import * as errorsPkg from "@rail402.dev/errors";

/**
 * The umbrella must be a PURE re-export: same symbols, same identities, nothing re-implemented and
 * nothing dropped. These tests fail if a subpath forgets a package, if a name collides (which would
 * silently drop it from `export *`), or if a helper is ever shadowed by a local re-implementation.
 */
describe("@rail402.dev/sdk umbrella", () => {
  it("root re-exports the headline buyer symbols", () => {
    for (const name of ["searchBazaar", "payAndFetch", "discoverAndPay"] as const) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("root re-exports the headline seller symbols", () => {
    for (const name of ["describeEndpoint", "describeTool", "preflight", "preflightAndReport"] as const) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("root re-exports the error registry surface", () => {
    for (const name of ["createError", "X402Error", "isErrorCode", "enrichUpstreamCode"] as const) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
    }
    expect((root as Record<string, unknown>).ERROR_REGISTRY).toBeTypeOf("object");
    expect(Array.isArray((root as Record<string, unknown>).ALL_ERROR_CODES)).toBe(true);
  });

  it("re-exports are the SAME objects, not re-implementations", () => {
    expect((root as Record<string, unknown>).discoverAndPay).toBe(agentHelpers.discoverAndPay);
    expect((root as Record<string, unknown>).describeEndpoint).toBe(sellerHelpers.describeEndpoint);
    expect((root as Record<string, unknown>).X402Error).toBe(errorsPkg.X402Error);
  });

  it("subpath entries carry exactly their own package's surface", () => {
    expect(typeof (buyer as Record<string, unknown>).discoverAndPay).toBe("function");
    expect(typeof (seller as Record<string, unknown>).describeEndpoint).toBe("function");
    expect(typeof (errorsEntry as Record<string, unknown>).X402Error).toBe("function");
    // buyer must not leak the seller surface, and vice versa
    expect((buyer as Record<string, unknown>).describeEndpoint).toBeUndefined();
    expect((seller as Record<string, unknown>).discoverAndPay).toBeUndefined();
  });

  it("every name in each underlying package survives the root re-export (no silent collision drop)", () => {
    const rootKeys = new Set(Object.keys(root));
    for (const pkg of [agentHelpers, sellerHelpers, errorsPkg]) {
      for (const name of Object.keys(pkg)) {
        expect(rootKeys.has(name), `root is missing re-exported "${name}"`).toBe(true);
      }
    }
  });
});
