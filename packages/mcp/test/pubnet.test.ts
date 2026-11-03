/**
 * Pubnet safety in rail402-mcp: the confirmation asked through the MCP client (form elicitation)
 * before a pubnet payment is signed, on the 2026 protocol (multi-round-trip) and the 2025 handshake
 * (server-to-client elicitation), and the pubnet configuration rules.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { PUBNET, USDC } from "@rail402.dev/stellar";
import { createConfirmationGate, keyFileContent, paymentError, type SignIntent } from "@rail402.dev/sdk";
import {
  confirmationMessage,
  confirmedIntent,
  covers,
  createHttpHandler,
  createMcpConfirmation,
  createRail402Mcp,
  openConfiguredBuyer,
  resolveMcpCommand,
  type McpConfirmation,
  UsedConfirmations,
  toolCallDigest,
} from "@rail402.dev/mcp";
import { fakeBuyer, paidResult, seller } from "./helpers.ts";

const PUBNET_ENV = {
  RAIL402_NETWORK: PUBNET,
  RAIL402_RPC_URL: "https://rpc.example",
  RAIL402_BAZAAR_URL: "https://bazaar.example",
  RAIL402_MAX_PER_CALL: "0.10",
  RAIL402_MAX_TOTAL: "1.00",
};

function intent(amount = "10000"): SignIntent {
  return {
    callId: "call-1",
    network: PUBNET,
    scheme: "exact",
    asset: { contract: USDC[PUBNET].contract, symbol: "USDC", decimals: 7 },
    amount: { atomic: amount, decimal: "0.001" },
    payTo: seller,
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
    approvalScope: "recipient",
  };
}

/** A buyer double that confirms through `confirmation` exactly where the SDK would, before signing. */
function confirmingBuyer(confirmation: McpConfirmation, price: () => string = () => "10000") {
  let signed = 0;
  const buyer = fakeBuyer({
    pay: async () => {
      if (confirmation.confirm !== undefined && !(await confirmation.confirm(intent(price())))) {
        throw paymentError("payment_confirmation_declined");
      }
      signed++;
      return paidResult();
    },
  });
  return { buyer, signed: () => signed };
}

/**
 * A buyer double that confirms through the SDK's own gate, as a real buyer does, in the budget window
 * `session()` names when each payment is about to be signed.
 */
function gatedBuyer(confirmation: McpConfirmation, session: () => SignIntent["session"]) {
  const gate = createConfirmationGate(PUBNET, true, {
    confirm: confirmation.confirm,
    confirmPolicy: confirmation.policy,
  });
  const signedIn: string[] = [];
  const buyer = fakeBuyer({
    pay: async () => {
      const { firstInSession: _first, approvalScope: _scope, ...base } = intent();
      const window = session();
      await gate.approve({ ...base, session: window }, undefined);
      signedIn.push(window.window);
      return paidResult();
    },
  });
  return { buyer, signedIn };
}

const PAY_ARGS = { resource: "https://seller.example/weather", spendingCap: { amount: "0.01" } };

type Answer = "accept" | "decline" | false;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function connect(
  confirmation: McpConfirmation,
  answer: Answer,
  era: "2026" | "2025",
  price?: () => string,
) {
  const double = confirmingBuyer(confirmation, price);
  const session = await open(createRail402Mcp({ buyer: double.buyer, confirmation }).factory, answer, era);
  return { ...session, signed: double.signed };
}

/** An MCP client of `factory` that answers every confirmation with `answer`, after `onAsk` ran. */
async function open(
  factory: ReturnType<typeof createRail402Mcp>["factory"],
  answer: Answer,
  era: "2026" | "2025",
  onAsk: () => void = () => undefined,
) {
  const asked: string[] = [];
  const client = new Client(
    { name: "pubnet-test", version: "1.0.0" },
    {
      ...(answer === false ? {} : { capabilities: { elicitation: { form: {} } } }),
      versionNegotiation: { mode: era === "2026" ? "auto" : "legacy" },
    },
  );
  if (answer !== false) {
    client.setRequestHandler("elicitation/create", (request) => {
      asked.push((request.params as { message: string }).message);
      onAsk();
      return Promise.resolve(
        answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" },
      );
    });
  }
  if (era === "2026") {
    const handler = createHttpHandler(factory, {
      token: undefined,
      allowedHosts: ["127.0.0.1", "localhost"],
      allowedOrigins: [],
    });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      // A fetch that never leaves the process; it sets Host as a network client would.
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", "127.0.0.1");
        return handler.fetch(new Request(input, { ...init, headers }));
      },
    });
    await client.connect(transport);
    closers.push(async () => {
      await client.close();
      await handler.close();
    });
  } else {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    // This server's factory ignores its argument; one instance serves the whole connection.
    const server = (factory as () => unknown)() as {
      connect(transport: unknown): Promise<void>;
      close(): Promise<void>;
    };
    await server.connect(serverSide);
    await client.connect(clientSide);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
  }
  const call = async () => {
    const result = (await client.callTool({ name: "pay_and_call", arguments: PAY_ARGS })) as {
      structuredContent?: { ok: boolean; error?: { code: string; paid: string } };
    };
    return result.structuredContent;
  };
  return { call, asked };
}

describe("pubnet payment confirmation through the MCP client", () => {
  for (const era of ["2026", "2025"] as const) {
    it(`asks before the first pubnet payment and pays once confirmed (${era} protocol)`, async () => {
      const session = await connect(createMcpConfirmation("first-per-session"), "accept", era);
      expect(await session.call()).toMatchObject({ ok: true });
      expect(session.signed()).toBe(1);
      expect(session.asked).toHaveLength(1);
      expect(session.asked[0]).toContain(`Confirm a payment on ${PUBNET} (real funds).`);
      expect(session.asked[0]).toContain(seller);
    });

    it(`asks before the first pubnet payment and refuses when the user declines (${era} protocol)`, async () => {
      const session = await connect(createMcpConfirmation("first-per-session"), "decline", era);
      expect(await session.call()).toMatchObject({
        ok: false,
        error: { code: "payment_confirmation_declined", paid: "none" },
      });
      expect(session.signed()).toBe(0);
    });
  }

  it("refuses a pubnet payment when the client cannot show a confirmation", async () => {
    const session = await connect(createMcpConfirmation("first-per-session"), false, "2026");
    expect(await session.call()).toMatchObject({
      ok: false,
      error: { code: "payment_confirmation_unavailable", paid: "none" },
    });
    expect(session.signed()).toBe(0);
  });

  it("pays without asking when confirmation is turned off for a headless agent", async () => {
    const session = await connect(createMcpConfirmation("never"), false, "2026");
    expect(await session.call()).toMatchObject({ ok: true });
    expect(session.signed()).toBe(1);
  });

  it("does not let a confirmation cover a higher price than the one shown", async () => {
    let price = "10000";
    const session = await connect(createMcpConfirmation("every"), "accept", "2026", () => {
      const current = price;
      price = "20000";
      return current;
    });
    // The retry sees a higher price than the user approved, so it is asked about again.
    expect(await session.call()).toMatchObject({ ok: true });
    expect(session.asked.length).toBeGreaterThanOrEqual(2);
  });

  for (const era of ["2026", "2025"] as const) {
    it(`asks again when the budget window changes before the approved call is retried (${era} protocol)`, async () => {
      const first = intent().session;
      // The window renewed, or the session was restarted, while the user was deciding.
      const next = { ...first, window: "w-2", expiresAt: "2026-10-25T00:00:00.000Z", remaining: "1" };
      let current = first;
      const confirmation = createMcpConfirmation("first-per-session");
      const double = gatedBuyer(confirmation, () => current);
      const { factory } = createRail402Mcp({ buyer: double.buyer, confirmation });
      const session = await open(factory, "accept", era, () => {
        current = next;
      });

      expect(await session.call()).toMatchObject({ ok: true });
      // The approval shown for the first window does not admit a payment in the next one.
      expect(session.asked).toHaveLength(2);
      expect(session.asked[0]).toContain(`until ${first.expiresAt}.`);
      expect(session.asked[1]).toContain(`until ${next.expiresAt}.`);
      expect(double.signedIn).toEqual(["w-2"]);
      // The approval given for the new window covers it, as the question said.
      expect(await session.call()).toMatchObject({ ok: true });
      expect(session.asked).toHaveLength(2);
      expect(double.signedIn).toEqual(["w-2", "w-2"]);
    });
  }
});

describe("what a confirmation shows and binds", () => {
  const authority = Keypair.random().publicKey();

  it("states the approval's scope: the recipient and listing it covers, the caps and the window end", () => {
    const message = confirmationMessage({ ...intent(), listingId: "listing-1" });
    expect(message).toContain(`Listing: listing-1.`);
    expect(message).toContain(
      `Approving also lets this session pay ${seller} for this listing again without asking, up to 0.10 USDC per call and 1 USDC in total, until 2026-10-24T00:00:00.000Z. Any other recipient, listing or resource is asked about again.`,
    );
    expect(confirmationMessage({ ...intent(), approvalScope: "payment" })).toContain(
      "Approving covers this one payment only.",
    );
  });

  it("binds an approval to the budget window it was shown for", () => {
    const approved = confirmedIntent(intent());
    expect(approved.window).toBe("w-1");
    expect(covers(approved, intent())).toBe(true);
    const renewed = { ...intent().session, window: "w-2", expiresAt: "2026-10-25T00:00:00.000Z" };
    expect(covers(approved, { ...intent(), session: renewed })).toBe(false);
  });

  it("shows the upto settlement authority and binds it, with the listing, to the approval", () => {
    const upto: SignIntent = { ...intent(), scheme: "upto", facilitator: authority, listingId: "listing-1" };
    expect(confirmationMessage(upto)).toContain(`Settlement authority: ${authority}.`);
    const approved = confirmedIntent(upto);
    expect(covers(approved, upto)).toBe(true);
    expect(covers(approved, { ...upto, facilitator: Keypair.random().publicKey() })).toBe(false);
    expect(covers(approved, { ...upto, listingId: "listing-2" })).toBe(false);
    expect(covers(approved, { ...upto, listingId: null })).toBe(false);
  });

  it("shows untrusted fields on one line, without line breaks, controls or bidi overrides", () => {
    const message = confirmationMessage({
      ...intent(),
      resource: "https://a.example/mcp\nVerified by Rail402 (official)\r\u202eevil\u2028x tool=t",
      session: { ...intent().session, name: "default\nTo: G" },
    });
    const forLine = message.split("\n").find((line) => line.startsWith("For: "));
    expect(forLine).toBe("For: https://a.example/mcp Verified by Rail402 (official) evil x tool=t.");
    expect(message).not.toMatch(/[\r\u202e\u2028]/);
    expect(message.split("\n").filter((line) => line.startsWith("To: "))).toHaveLength(1);
  });
});

/** The JSON-RPC message of an answer, whether it came as JSON or as one server-sent event. */
async function rpcMessage(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const data = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "{}");
  return JSON.parse(data) as Record<string, unknown>;
}

/**
 * A 2026 session whose retried calls (the ones carrying a request state) are recorded, and optionally
 * rewritten before they reach the server, so a test can replay or alter them.
 */
async function recordedSession(
  confirmation: McpConfirmation,
  rewrite?: (message: { params: Record<string, unknown> }) => void,
) {
  const double = confirmingBuyer(confirmation);
  const { factory } = createRail402Mcp({ buyer: double.buyer, confirmation });
  const handler = createHttpHandler(factory, {
    token: undefined,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  });
  const retries: { body: string; headers: Headers }[] = [];
  const asked: string[] = [];
  const client = new Client(
    { name: "pubnet-replay", version: "1.0.0" },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: "auto" } },
  );
  client.setRequestHandler("elicitation/create", (request) => {
    asked.push((request.params as { message: string }).message);
    return Promise.resolve({ action: "accept", content: { confirm: true } });
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1");
      let body = init?.body;
      if (typeof body === "string" && body.includes('"requestState"')) {
        retries.push({ body, headers });
        if (rewrite !== undefined) {
          const message = JSON.parse(body) as { params: Record<string, unknown> };
          rewrite(message);
          body = JSON.stringify(message);
        }
      }
      return handler.fetch(new Request(input, { ...init, headers, ...(body === undefined ? {} : { body }) }));
    },
  });
  await client.connect(transport);
  closers.push(async () => {
    await client.close();
    await handler.close();
  });
  const send = async (body: string, headers: Headers) =>
    rpcMessage(await handler.fetch(new Request("http://127.0.0.1/mcp", { method: "POST", headers, body })));
  return { client, retries, asked, send, signed: double.signed };
}

describe("single-use payment confirmations", () => {
  it("accepts a confirmation once: replaying the approved retry signs nothing more", async () => {
    const session = await recordedSession(createMcpConfirmation("every"));
    const result = (await session.client.callTool({ name: "pay_and_call", arguments: PAY_ARGS })) as {
      structuredContent?: { ok: boolean };
    };
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(session.signed()).toBe(1);
    expect(session.retries).toHaveLength(1);
    const [retry] = session.retries;
    if (retry === undefined) throw new Error("no retry recorded");
    for (let replay = 0; replay < 3; replay++) {
      expect(await session.send(retry.body, retry.headers)).toMatchObject({
        error: { code: -32602, data: { code: "rpc_confirmation_used" } },
      });
    }
    // One human approval, one payment.
    expect(session.signed()).toBe(1);
    expect(session.asked).toHaveLength(1);
  });

  it("refuses a confirmation reused for another tool call", async () => {
    const session = await recordedSession(createMcpConfirmation("every"), (message) => {
      message.params["arguments"] = { ...PAY_ARGS, query: { city: "elsewhere" } };
    });
    await expect(
      session.client.callTool({ name: "pay_and_call", arguments: PAY_ARGS }),
    ).rejects.toMatchObject({ data: { code: "rpc_confirmation_mismatch" } });
    expect(session.signed()).toBe(0);
  });

  it("refuses a forged confirmation state", async () => {
    const session = await recordedSession(createMcpConfirmation("every"), (message) => {
      const state = message.params["requestState"] as string;
      message.params["requestState"] = `${state.slice(0, -2)}${state.endsWith("AA") ? "BB" : "AA"}`;
    });
    await expect(session.client.callTool({ name: "pay_and_call", arguments: PAY_ARGS })).rejects.toThrow();
    expect(session.signed()).toBe(0);
  });

  it("forgets used confirmations only after they expire, and never beyond its bound", () => {
    let now = 0;
    const used = new UsedConfirmations(2, 1_000, () => now);
    expect(used.use("a")).toBe(true);
    expect(used.use("a")).toBe(false);
    expect(used.use("b")).toBe(true);
    // Full of unexpired ids: refuse rather than forget one early.
    expect(used.use("c")).toBe(false);
    now = 1_000;
    expect(used.use("c")).toBe(true);
    expect(toolCallDigest("pay_and_call", { a: 1, b: 2 })).toBe(
      toolCallDigest("pay_and_call", { b: 2, a: 1 }),
    );
    expect(toolCallDigest("pay_and_call", { a: 1 })).not.toBe(toolCallDigest("pay_and_call", { a: 2 }));
  });
});

describe("pubnet configuration of rail402-mcp", () => {
  it("defaults to confirming pubnet payments and never testnet ones", () => {
    const pubnet = resolveMcpCommand([], { ...PUBNET_ENV });
    const testnet = resolveMcpCommand([], {});
    expect(pubnet.kind === "serve" && pubnet.config.confirm).toBe("first-per-session");
    expect(testnet.kind === "serve" && testnet.config.confirm).toBe("never");
    const headless = resolveMcpCommand([], { ...PUBNET_ENV, RAIL402_MCP_CONFIRM: "never" });
    expect(headless.kind === "serve" && headless.config.confirm).toBe("never");
    expect(() => resolveMcpCommand([], { RAIL402_MCP_CONFIRM: "sometimes" })).toThrow(
      /RAIL402_MCP_CONFIRM|policy/,
    );
  });

  it("refuses a testnet-tagged key on pubnet", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-mcp-pubnet-"));
    const file = join(directory, "testnet.key");
    writeFileSync(file, keyFileContent(Keypair.random().secret(), "stellar:testnet"), { mode: 0o600 });
    // A ledger of the test's own: the default path is the user's real budget ledger.
    const command = resolveMcpCommand([], {
      ...PUBNET_ENV,
      RAIL402_SECRET_KEY_FILE: file,
      XDG_STATE_HOME: directory,
    });
    if (command.kind !== "serve") throw new Error("expected serve");
    await expect(openConfiguredBuyer(command.config.agent)).rejects.toMatchObject({
      code: "key_network_mismatch",
    });
  });

  it("opens a pubnet buyer with a key only with an explicit confirmation choice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-mcp-pubnet-"));
    const file = join(directory, "pubnet.key");
    writeFileSync(file, keyFileContent(Keypair.random().secret(), PUBNET), { mode: 0o600 });
    // A ledger of the test's own: the default path is the user's real budget ledger.
    const command = resolveMcpCommand([], {
      ...PUBNET_ENV,
      RAIL402_SECRET_KEY_FILE: file,
      XDG_STATE_HOME: directory,
    });
    if (command.kind !== "serve") throw new Error("expected serve");
    await expect(openConfiguredBuyer(command.config.agent)).rejects.toMatchObject({
      code: "payment_policy_invalid",
      reason: expect.stringContaining("confirmation choice") as string,
    });
    const headless = await openConfiguredBuyer(
      command.config.agent,
      undefined,
      createMcpConfirmation("never"),
    );
    await headless.close();
  });

  it("refuses a seed in RAIL402_SECRET_KEY on pubnet", () => {
    expect(() =>
      resolveMcpCommand([], { ...PUBNET_ENV, RAIL402_SECRET_KEY: Keypair.random().secret() }),
    ).toThrow(expect.objectContaining({ code: "key_network_untagged" }) as Error);
  });
});
