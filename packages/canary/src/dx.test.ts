import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SELLER_SURFACE } from "./time-to-discoverable.js";
import { findRepoRoot } from "./facilitator.js";

/**
 * Keep the DX claims tied to the code that has to back them.
 *
 * `SELLER_SURFACE` says a seller needs **zero** manual steps, **zero** third-party accounts, and
 * exactly **one** extra config key to become discoverable. Those are the numbers we would put in
 * front of a reviewer, which is precisely why they must be checked rather than asserted: a claim
 * about integration cost that nothing verifies is marketing, and it decays the moment the code
 * grows a second required step.
 *
 * So these tests read the **working example** — the same file a developer copies from — and fail if
 * reality drifts away from the claim.
 */

const root = findRepoRoot();

/**
 * Strip comments before scanning.
 *
 * Both files *describe* the absence of registration steps in prose ("no registration step, no
 * dashboard and no API key"), so a naive substring scan finds the very words it is looking for and
 * fails on the documentation of the property it is checking. Only executable code counts.
 */
const code = (path: string): string =>
  readFileSync(join(root, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const sellerExample = code("examples/paid-api-agent/src/server.ts");
const canarySeller = code("packages/canary/src/seller.ts");

describe("seller integration surface", () => {
  it("needs exactly one extra config key beyond a plain paywall", () => {
    expect(SELLER_SURFACE.extraConfigForDiscovery).toBe(1);
    expect(SELLER_SURFACE.extraConfigName).toBe("extensions");
    // The example must actually demonstrate that key, or the claim is untested prose.
    expect(sellerExample).toMatch(/extensions:\s*declareDiscoveryExtension\(/);
  });

  it("claims zero manual steps, and the example proves it by having none", () => {
    expect(SELLER_SURFACE.manualSteps).toBe(0);
    expect(SELLER_SURFACE.thirdPartyAccounts).toBe(0);

    // Patterns that would mean a seller has to do something with a third party before being
    // listed. Note what is deliberately NOT here: `x402Server.register(...)` is local, in-process
    // scheme registration — matching on the bare word "register" would flag legitimate code and
    // teach whoever hits it to weaken the test.
    const requiresThirdParty = [
      /\/discovery\/register/i,
      /registerResource\s*\(/i,
      /apiKey\s*[:=]/i,
      /API_KEY/,
    ];
    for (const forbidden of requiresThirdParty) {
      expect(sellerExample, `seller example now requires ${forbidden}`).not.toMatch(forbidden);
      expect(canarySeller, `synthetic seller now requires ${forbidden}`).not.toMatch(forbidden);
    }
  });

  /**
   * The synthetic seller in the canary is what the DX number is actually measured against, so it
   * must stay a *stock* integration. If it ever imports our own helpers, the measurement would be
   * of a privileged path no real seller uses, and the number would quietly stop meaning anything.
   */
  it("measures a stock integration, not a privileged one", () => {
    expect(canarySeller).toMatch(/@x402\/hono/);
    expect(canarySeller).toMatch(/@x402\/extensions\/bazaar/);
    expect(canarySeller, "the measured seller must not use our own SDK").not.toMatch(
      /@x402-stellar\/seller-helpers/,
    );
  });

  it("explains the zero rather than just asserting it", () => {
    // A bare "0" invites suspicion; the note is what makes it checkable by a reader.
    expect(SELLER_SURFACE.note).toMatch(/settled payment/i);
    expect(SELLER_SURFACE.note.length).toBeGreaterThan(60);
  });
});
