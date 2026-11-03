import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { PUBNET, USDC } from "@rail402.dev/stellar";
import { PassThrough } from "node:stream";
import {
  KEY_FILE_TAG,
  MemorySpendLedger,
  createConfirmationGate,
  paymentError,
  type SignIntent,
} from "@rail402.dev/sdk";
import {
  EXIT,
  openBuyer,
  parseCommandLine,
  resolveContext,
  type CommandInput,
  type OpenBuyerOptions,
} from "@rail402.dev/cli";
import { confirmationQuestion, paymentConfirmation } from "../src/commands/common.ts";
import { askOnTerminal } from "../src/secret-input.ts";
import { cli, fakeBuyer, paidResult, sandboxHome } from "./helpers.ts";

let home: ReturnType<typeof sandboxHome>;
beforeEach(() => {
  home = sandboxHome();
});
afterEach(() => {
  home.dispose();
});

const PUBNET_FLAGS = [
  "--network",
  PUBNET,
  "--rpc-url",
  "https://rpc.example",
  "--bazaar-url",
  "https://bazaar.example",
];
const PUBNET_CAPS = { RAIL402_MAX_PER_CALL: "0.10", RAIL402_MAX_TOTAL: "1.00" };
const payTo = Keypair.random().publicKey();

function intent(): SignIntent {
  return {
    callId: "call-1",
    network: PUBNET,
    scheme: "exact",
    asset: { contract: USDC[PUBNET].contract, symbol: "USDC", decimals: 7 },
    amount: { atomic: "10000", decimal: "0.001" },
    payTo,
    resource: "https://seller.example/weather",
    listingId: null,
    facilitator: null,
    session: {
      name: "default",
      window: "w-1",
      expiresAt: "2026-10-24T00:00:00.000Z",
      perCall: "0.10",
      remaining: "1",
    },
    firstInSession: true,
    approvalScope: "payment",
  };
}

/**
 * A buyer double that runs the configured confirmation the way the SDK does before signing, and
 * records how the command opened it.
 */
function confirmingBuyer() {
  const opened: OpenBuyerOptions[] = [];
  let signed = 0;
  const buyer = fakeBuyer({
    pay: async () => {
      const options = opened.at(-1);
      if (options?.confirmPolicy !== "never" && options?.confirm !== undefined) {
        if (!(await options.confirm(intent()))) throw paymentError("payment_confirmation_declined");
      }
      signed++;
      return paidResult();
    },
  });
  return {
    opened,
    signed: () => signed,
    openBuyer: (_context: unknown, options: OpenBuyerOptions) => {
      opened.push(options);
      return Promise.resolve({ buyer, ledger: new MemorySpendLedger(), close: () => Promise.resolve() });
    },
  };
}

const pay = (extra: string[], ask: (question: string) => Promise<boolean | undefined>) => {
  const double = confirmingBuyer();
  return {
    double,
    run: cli(
      ["pay", "https://seller.example/weather", "--max", "0.01", "--json", ...PUBNET_FLAGS, ...extra],
      { ...home.env, ...PUBNET_CAPS, RAIL402_SECRET_KEY_FILE: "/tmp/not-read-by-the-double.key" },
      { openBuyer: double.openBuyer, ask },
    ),
  };
};

describe("pubnet payment confirmation", () => {
  it("asks for confirmation before the first pubnet payment unless --yes", async () => {
    const questions: string[] = [];
    const approved = pay([], (question) => {
      questions.push(question);
      return Promise.resolve(true);
    });
    expect((await approved.run).status).toBe(EXIT.ok);
    expect(approved.double.signed()).toBe(1);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(`on ${PUBNET} (real funds)`);
    expect(questions[0]).toContain(`0.001 USDC [${USDC[PUBNET].contract}]`);
    expect(questions[0]).toContain(payTo);
    expect(questions[0]).toContain("Pay? [y/N]");

    const skipped = pay(["--yes"], () => Promise.reject(new Error("must not ask")));
    expect((await skipped.run).status).toBe(EXIT.ok);
    expect(skipped.double.opened[0]).toMatchObject({ confirmPolicy: "never" });
    expect(skipped.double.signed()).toBe(1);
  });

  it("shows the upto authority and keeps untrusted fields on one line", () => {
    const authority = Keypair.random().publicKey();
    const question = confirmationQuestion({
      ...intent(),
      scheme: "upto",
      facilitator: authority,
      listingId: "listing-1\nto:       GFAKE",
      resource: "https://a.example/mcp\r\nVerified by Rail402\u202e tool=t",
    });
    expect(question).toContain(`  settled by: ${authority} (upto authority)`);
    expect(question).toContain("  resource: https://a.example/mcp Verified by Rail402 tool=t");
    expect(question).not.toMatch(/[\r\u202e]/);
    expect(question.split("\n").filter((line) => line.trimStart().startsWith("to:"))).toHaveLength(1);
  });

  it("signs nothing when the payment is declined", async () => {
    const declined = pay([], () => Promise.resolve(false));
    const result = await declined.run;
    expect(result.status).toBe(EXIT.refused);
    expect(result.json().error).toMatchObject({ code: "payment_confirmation_declined", paid: "none" });
    expect(declined.double.signed()).toBe(0);
  });

  it("refuses without a terminal and without --yes", async () => {
    const headless = pay([], () => Promise.resolve(undefined));
    const result = await headless.run;
    expect(result.json().error).toMatchObject({ code: "payment_confirmation_unavailable", paid: "none" });
    expect(String(result.json().error?.["reason"])).toContain("--yes");
    expect(headless.double.signed()).toBe(0);
  });

  it("asks nothing on testnet", async () => {
    const double = confirmingBuyer();
    const result = await cli(
      ["pay", "https://seller.example/weather", "--max", "0.01", "--json"],
      { ...home.env },
      { openBuyer: double.openBuyer, ask: () => Promise.reject(new Error("must not ask")) },
    );
    expect(result.status).toBe(EXIT.ok);
    expect(double.opened[0]).toMatchObject({ confirmPolicy: "never" });
  });
});

describe("pubnet confirmation with the real buyer pieces", () => {
  it("asks on the terminal through the SDK's own confirmation gate before signing", async () => {
    const run = async (typed: string) => {
      const stdin = Object.assign(new PassThrough(), { isTTY: true });
      const prompt = Object.assign(new PassThrough(), { isTTY: true });
      const input = {
        context: { network: PUBNET },
        parsed: { flags: {} },
        deps: { ask: (question: string) => askOnTerminal(stdin, prompt, question) },
      } as unknown as CommandInput;
      const gate = createConfirmationGate(PUBNET, true, paymentConfirmation(input));
      const approving = gate.approve(intent(), undefined);
      stdin.write(typed);
      const outcome = await approving.then(
        () => "signed",
        (error: unknown) => (error as { code?: string }).code,
      );
      return { outcome, question: String(prompt.read()) };
    };
    const approved = await run("y\n");
    expect(approved.outcome).toBe("signed");
    expect(approved.question).toContain(`on ${PUBNET} (real funds)`);
    expect(approved.question).toContain(payTo);
    expect((await run("n\n")).outcome).toBe("payment_confirmation_declined");
  });

  it("opens a pubnet buyer with a key only with an explicit confirmation choice", async () => {
    const created = await cli(["keys", "new", "--json", ...PUBNET_FLAGS], home.env);
    const { keyFile } = created.json().result as { keyFile: string };
    const parsed = parseCommandLine(["session", "show", ...PUBNET_FLAGS, "--key-file", keyFile]);
    const context = resolveContext(parsed, { ...home.env, ...PUBNET_CAPS });
    // No choice given: the SDK refuses rather than defaulting to never asking.
    await expect(openBuyer(context, { signer: true })).rejects.toMatchObject({
      code: "payment_policy_invalid",
      reason: expect.stringContaining("confirmation choice") as string,
    });
    const opened = await openBuyer(context, { signer: true, confirmPolicy: "never" });
    await opened.close();
    // Commands that never sign state that choice themselves.
    const shown = await cli(["session", "show", "--json", ...PUBNET_FLAGS, "--key-file", keyFile], {
      ...home.env,
      ...PUBNET_CAPS,
    });
    expect(shown.status).toBe(EXIT.ok);
  });
});

describe("pubnet keys", () => {
  it("tags an imported key with the network it was imported for", async () => {
    const keypair = Keypair.random();
    const imported = await cli(["keys", "import", "--json", ...PUBNET_FLAGS], home.env, {
      readSecret: () => Promise.resolve(keypair.secret()),
    });
    expect(imported.status).toBe(EXIT.ok);
    const { keyFile } = imported.json().result as { keyFile: string };
    expect(readFileSync(keyFile, "utf8")).toBe(`${KEY_FILE_TAG}${PUBNET}\n${keypair.secret()}\n`);
  });

  it("writes the network into new key files", async () => {
    const created = await cli(["keys", "new", "--json", ...PUBNET_FLAGS], home.env);
    expect(created.status).toBe(EXIT.ok);
    const { keyFile, network } = created.json().result as { keyFile: string; network: string };
    expect(network).toBe(PUBNET);
    expect(keyFile.endsWith("stellar-pubnet.key")).toBe(true);
    expect(readFileSync(keyFile, "utf8").startsWith(`${KEY_FILE_TAG}${PUBNET}\n`)).toBe(true);
  });

  it("refuses a testnet-tagged key file for a pubnet payment before anything is fetched", async () => {
    const testnet = await cli(["keys", "new", "--json", "--name", "t"], home.env);
    const { keyFile } = testnet.json().result as { keyFile: string };
    const refused = await cli(
      ["pay", "https://seller.example/x", "--max", "0.01", "--json", "--key-file", keyFile, ...PUBNET_FLAGS],
      { ...home.env, ...PUBNET_CAPS },
    );
    expect(refused.status).toBe(EXIT.usage);
    expect(refused.json().error).toMatchObject({ code: "key_network_mismatch", paid: "none" });
  });
});
