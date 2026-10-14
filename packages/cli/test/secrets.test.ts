/**
 * Secret canary scan of the rail402 CLI: payments with a canary key run through the real payment
 * flows (successes, a replay, a refusal before signing, a rejected payment, failures after paying,
 * sellers that echo the payment into their answer),
 * each command in JSON and text output, with and without --verbose; keys are imported from the
 * canary and shown; the key comes from the environment for commands that load it. Every byte on
 * stdout and stderr must be free of the seed, its raw bytes, signatures, preimages, signed
 * authorization entries and payment headers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { KeyHolder, MemorySpendLedger, type FlowContext } from "@rail402.dev/sdk";
import type { CliDeps, OpenBuyer } from "@rail402.dev/cli";
import { SecretScanner } from "@rail402.dev/testkit";
import { payHttp, quoteHttp } from "../../sdk/src/flow/http.ts";
import { payMcp } from "../../sdk/src/flow/mcp.ts";
import {
  TX_HASH,
  echoRoute,
  flowContext,
  paidRoute,
  startSeller,
  type FakeSeller,
} from "../../sdk/test/flow-harness.ts";
import { usdc } from "../../sdk/test/helpers.ts";
import { acceptingFacilitator, startMcpSeller, type McpSeller } from "../../sdk/test/mcp-seller.ts";
import { cli, fakeBuyer, sandboxHome } from "./helpers.ts";

const canary = Keypair.random();

describe("secret canary scan of the rail402 CLI", () => {
  const scanner = new SecretScanner(canary.secret());
  const home = sandboxHome();
  let seller: FakeSeller;
  let mcpSeller: McpSeller;
  let base: FlowContext;
  let deps: Partial<CliDeps>;

  /** Runs a command and captures both streams. */
  const rail = async (argv: readonly string[], env: Record<string, string> = {}) => {
    const run = await cli(argv, { ...home.env, ...env }, deps);
    scanner.capture(`stdout ${argv.join(" ").slice(0, 80)}`, run.stdout);
    scanner.capture(`stderr ${argv.join(" ").slice(0, 80)}`, run.stderr);
    return run;
  };

  beforeAll(async () => {
    seller = await startSeller({
      "/paid": paidRoute({}, { weather: "sunny" }),
      "/echo-paid": echoRoute,
      "/reject": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.paymentRequired(response, {}, { error: "invalid_exact_stellar_payload_signature" });
      },
      "/fails-after-settling": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.settled(response, { error: "boom" }, 500);
      },
      "/drops-after-pay": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.socket?.destroy();
      },
    });
    mcpSeller = await startMcpSeller({
      mode: "stateless",
      facilitator: acceptingFacilitator(TX_HASH),
      payTo: Keypair.random().publicKey(),
      asset: usdc,
      amount: "20000",
    });
    base = await flowContext({
      signer: scanner.tap(KeyHolder.fromSecret(canary.secret())),
      ports: [seller.port, mcpSeller.port],
    });
    // Commands open the buyer themselves; --verbose hands its event writer to the flows.
    const openBuyer: OpenBuyer = (_context, options) => {
      // A fresh budget per command: the fake sellers report the same transaction for every payment.
      const ledger = new MemorySpendLedger();
      const context: FlowContext = { ...base, ledger, onEvent: options.onEvent };
      const buyer = fakeBuyer(
        {
          pay: (target, payOptions) =>
            target.kind === "http"
              ? payHttp(context, target, payOptions)
              : payMcp(context, target, payOptions),
          quote: (target, quoteOptions) =>
            target.kind === "http"
              ? quoteHttp(context, target, quoteOptions)
              : Promise.reject(new Error("no MCP quotes here")),
        },
        canary.publicKey(),
      );
      return Promise.resolve({ buyer, ledger, close: () => Promise.resolve() });
    };
    deps = { openBuyer, readSecret: () => Promise.resolve(`${canary.secret()}\n`) };
  });

  afterAll(async () => {
    await Promise.all([seller.close(), mcpSeller.close()]);
    home.dispose();
  });

  it("pays in JSON and text output, with and without --verbose", async () => {
    const url = (path: string) => `${seller.url}${path}`;
    for (const format of [["--json"], [], ["--json", "--verbose"], ["--verbose"]]) {
      const paid = await rail(["pay", url("/paid"), "--max", "0.05", ...format]);
      expect(paid.status, paid.stdout + paid.stderr).toBe(0);
      await rail(["pay", url("/paid"), "--max", "0.05", "--idempotency-key", "canary-cli-1", ...format]);
      const echoed = await rail(["pay", url("/echo-paid"), "--max", "0.05", ...format]);
      expect(echoed.status, echoed.stdout + echoed.stderr).toBe(0);
      await rail(["pay", url("/reject"), "--max", "0.05", ...format]);
      await rail(["pay", url("/fails-after-settling"), "--max", "0.05", ...format]);
      await rail(["pay", url("/drops-after-pay"), "--max", "0.05", ...format]);
      await rail(["pay", url("/paid"), "--max", "0.0000001", ...format]);
      await rail(["quote", url("/paid"), "--max", "0.05", ...format]);
      await rail([
        "pay",
        mcpSeller.url,
        "--tool",
        "forecast",
        "--args",
        '{"city":"Izmir"}',
        "--max",
        "0.05",
        ...format,
      ]);
      await rail(["pay", mcpSeller.url, "--tool", "broken", "--max", "0.05", ...format]);
      await rail(["pay", mcpSeller.url, "--tool", "echo-payment", "--max", "0.05", ...format]);
    }
    const verbose = await rail(["pay", url("/paid"), "--max", "0.05", "--json", "--verbose"]);
    expect(verbose.stderr).toContain('"type":"signed"');
  });

  it("imports and shows keys without printing the seed", async () => {
    for (const format of [["--json"], []]) {
      const name = `canary${String(format.length)}`;
      const imported = await rail(["keys", "import", "--name", name, ...format]);
      expect(imported.status).toBe(0);
      expect(`${imported.stdout}${imported.stderr}`).toContain(canary.publicKey());
      await rail(["keys", "show", "--name", name, ...format]);
      await rail(["keys", "import", "--name", name, ...format]);
      await rail(["keys", "path", ...format]);
    }
  });

  it("never prints a key taken from the environment", async () => {
    const env = { RAIL402_SECRET_KEY: canary.secret() };
    for (const format of [["--json"], []]) {
      await rail(["keys", "show", ...format], env);
      await rail(["session", "show", ...format], env);
      await rail(["pay", "--max", "0.05", ...format], env);
      await rail(["pay", "https://a.example", "--max", "0.05", "--secret", canary.secret(), ...format], env);
    }
    await rail(["--help"], env);
    await rail(["help", "pay"], env);
    await rail(["version"], env);
  });

  it("leaks nothing on stdout or stderr", () => {
    for (const request of seller.seen) {
      const header = request.headers["payment-signature"];
      if (typeof header === "string") scanner.addPaymentHeader(header, Networks.TESTNET);
    }
    for (const payment of mcpSeller.payments) scanner.addPayment(payment, Networks.TESTNET);
    expect(scanner.needles).toBeGreaterThan(100);
    scanner.assertClean();
  });
});
