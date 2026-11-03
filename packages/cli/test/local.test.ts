import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { PUBNET, TESTNET, USDC } from "@rail402.dev/stellar";
import { EXIT, parseCommandLine, resolveContext } from "@rail402.dev/cli";
import { KEY_FILE_TAG, KeyHolder, parseKeyFile } from "@rail402.dev/sdk";
import { askOnTerminal, readSecret } from "../src/secret-input.ts";
import { cli, sandboxHome, type CliRun } from "./helpers.ts";

let home: ReturnType<typeof sandboxHome>;
beforeEach(() => {
  home = sandboxHome();
});
afterEach(() => {
  home.dispose();
});

/** Characters that act on a terminal: controls other than LF, line separators and bidi overrides. */
const TERMINAL_CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

/** Nothing a command prints may contain a seed. */
function expectNoSeed(result: CliRun, seed: string): void {
  expect(result.stdout).not.toContain(seed);
  expect(result.stderr).not.toContain(seed);
  expect(`${result.stdout}${result.stderr}`).not.toMatch(/S[A-Z2-7]{55}/);
}

const configFile = (body: unknown): string => {
  const directory = join(home.env.XDG_CONFIG_HOME, "rail402");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "config.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};

describe("configuration", () => {
  const context = (argv: string[], env: Record<string, string | undefined> = {}) =>
    resolveContext(parseCommandLine(argv), { ...home.env, ...env });

  it("takes flags over the environment over the config file", () => {
    configFile({
      bazaarUrl: "https://file.example",
      rpcUrl: "https://rpc-file.example",
      maxPerCall: "0.02 USDC",
    });
    const fromFile = context(["search", "q"]);
    expect(fromFile.agent).toMatchObject({
      bazaarUrl: "https://file.example",
      rpcUrl: "https://rpc-file.example",
    });
    expect(fromFile.agent.policy.assets?.[0]).toMatchObject({ perCall: "0.02" });
    // The facilitator defaults to the Bazaar: one Rail402 serves both.
    expect(fromFile.facilitatorUrl).toBe("https://file.example");
    const fromEnv = context(["search", "q"], { RAIL402_BAZAAR_URL: "https://env.example" });
    expect(fromEnv.agent.bazaarUrl).toBe("https://env.example");
    const fromFlag = context(["search", "q", "--bazaar-url", "https://flag.example/"], {
      RAIL402_BAZAAR_URL: "https://env.example",
    });
    expect(fromFlag.agent.bazaarUrl).toBe("https://flag.example");
    expect(fromFlag.friendbotUrl).toBe("https://friendbot.stellar.org");
  });

  it("links to the Rail402 Explorer by default, and to stellar.expert when configured", () => {
    expect(context(["pay", "https://api.example/x"]).agent.explorer).toBe("rail402");
    expect(context(["tx", "a".repeat(64)], { RAIL402_EXPLORER: "stellar.expert" }).agent.explorer).toBe(
      "stellar.expert",
    );
    configFile({ explorer: "stellar.expert" });
    expect(context(["tx", "a".repeat(64)]).agent.explorer).toBe("stellar.expert");
  });

  it("refuses a config file holding a secret, unknown fields and bad JSON", async () => {
    const seed = Keypair.random().secret();
    for (const body of [{ secret: "x" }, { keyFile: seed }, { network: `stellar:testnet ${seed}` }]) {
      configFile(body);
      const result = await cli(["search", "q", "--json"], home.env);
      expect(result.status).toBe(EXIT.usage);
      expect(result.json().error).toMatchObject({ code: "cli_config_invalid" });
      expectNoSeed(result, seed);
    }
    configFile({ colour: "blue" });
    expect((await cli(["search", "q", "--json"], home.env)).json().error).toMatchObject({
      code: "cli_config_invalid",
    });
    configFile("{");
    expect((await cli(["search", "q", "--json"], home.env)).json().error?.["reason"]).toBe(
      "The configuration file is not valid JSON.",
    );
    const missing = await cli(["search", "q", "--json", "--config", join(home.dir, "none.json")], home.env);
    expect(missing.json().error).toMatchObject({ code: "cli_config_invalid" });
  });

  it("removes RAIL402_SECRET_KEY from the environment once read", () => {
    const seed = Keypair.random().secret();
    const env: Record<string, string | undefined> = { ...home.env, RAIL402_SECRET_KEY: seed };
    const resolved = resolveContext(parseCommandLine(["session", "show"]), env);
    expect(env["RAIL402_SECRET_KEY"]).toBeUndefined();
    expect(resolved.keySource).toBe("env");
  });

  it("has no Friendbot on pubnet, needs explicit endpoints there, and refuses local switches", async () => {
    const pubnet = context([
      "search",
      "q",
      "--network",
      "stellar:pubnet",
      "--rpc-url",
      "https://rpc.example",
      "--bazaar-url",
      "https://bazaar.example",
    ]);
    expect(pubnet.friendbotUrl).toBeUndefined();
    const implicit = await cli(["search", "q", "--network", "stellar:pubnet", "--json"], home.env);
    expect(implicit.json().error).toMatchObject({ code: "payment_policy_invalid" });
    const http = await cli(
      [
        "search",
        "q",
        "--network",
        "stellar:pubnet",
        "--rpc-url",
        "https://r.example",
        "--bazaar-url",
        "https://b.example",
        "--allow-http",
        "--json",
      ],
      home.env,
    );
    expect(http.json().error).toMatchObject({
      code: "payment_policy_invalid",
      details: { setting: "RAIL402_ALLOW_HTTP" },
    });
  });

  it("parses --timeout and RAIL402_OUTPUT strictly", async () => {
    expect(context(["search", "q", "--timeout", "5m"]).timeoutMs).toBe(300_000);
    expect(context(["search", "q", "--timeout", "30"]).timeoutMs).toBe(30_000);
    expect((await cli(["search", "q", "--timeout", "0", "--json"], home.env)).json().error).toMatchObject({
      code: "cli_usage_invalid",
    });
    const output = await cli(["search", "q"], { ...home.env, RAIL402_OUTPUT: "yaml" });
    expect(output.stderr).toContain("cli_config_invalid");
  });
});

describe("keys", () => {
  it("creates a 0600 key file in a 0700 directory, prints only public data, never overwrites", async () => {
    const created = await cli(["keys", "new", "--json"], home.env);
    expect(created.status).toBe(0);
    const { address, keyFile } = created.json().result as { address: string; keyFile: string };
    expect(keyFile).toBe(join(home.env.XDG_CONFIG_HOME, "rail402", "keys", "stellar-testnet.key"));
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(home.env.XDG_CONFIG_HOME, "rail402", "keys")).mode & 0o777).toBe(0o700);
    const content = readFileSync(keyFile, "utf8");
    expect(content.startsWith(`${KEY_FILE_TAG}${TESTNET}\n`)).toBe(true);
    const seed = parseKeyFile(content).secret;
    expect(Keypair.fromSecret(seed).publicKey()).toBe(address);
    expectNoSeed(created, seed);

    const again = await cli(["keys", "new"], home.env);
    expect(again.status).toBe(EXIT.usage);
    expect(again.stderr).toContain("key_exists");
    expect(readFileSync(keyFile, "utf8")).toBe(content);

    // The default key is found without any flag or variable.
    const shown = await cli(["keys", "show", "--json"], home.env);
    expect(shown.json().result).toEqual({
      address,
      keyFile,
      source: "default key file",
      network: TESTNET,
      keyNetwork: TESTNET,
    });
    expectNoSeed(shown, seed);
    const path = await cli(["keys", "path", "--name", "other"], home.env);
    expect(path.stdout.trim()).toBe(join(home.env.XDG_CONFIG_HOME, "rail402", "keys", "other.key"));
  });

  it("imports a seed from stdin into a named key, and refuses invalid input without echoing it", async () => {
    const keypair = Keypair.random();
    const imported = await cli(["keys", "import", "--name", "buyer", "--json"], home.env, {
      readSecret: () => Promise.resolve(keypair.secret()),
    });
    expect(imported.json().result).toMatchObject({ address: keypair.publicKey() });
    expectNoSeed(imported, keypair.secret());

    // Change the last character, the checksum's, to one it is not.
    const last = keypair.secret().slice(-1);
    const broken = `${keypair.secret().slice(0, -1)}${last === "A" ? "B" : "A"}`;
    const refused = await cli(["keys", "import", "--name", "broken", "--json"], home.env, {
      readSecret: () => Promise.resolve(broken),
    });
    expect(refused.status).toBe(EXIT.usage);
    expect(refused.json().error).toMatchObject({ code: "key_invalid" });
    expect(refused.stdout).not.toContain(broken);

    const invalidName = await cli(["keys", "new", "--name", "../x"], home.env);
    expect(invalidName.stderr).toContain("A key name is 1-64");
  });

  it("takes a key file the Playground exported, after the documented step", async () => {
    // A browser saves the download, a key file tagged for testnet, readable by others (0644 or 0664).
    const download = join(home.dir, "rail402-testnet-gabc1234.key");
    const keypair = Keypair.random();
    writeFileSync(download, `${KEY_FILE_TAG}${TESTNET}\n${keypair.secret()}\n`, { mode: 0o644 });
    chmodSync(download, 0o644);
    await expect(KeyHolder.fromFile(download)).rejects.toMatchObject({ code: "key_file_insecure" });

    // Either `rail402 keys import < <file>`, which writes the network's default key 0600 …
    const stdin = new PassThrough();
    const imported = cli(["keys", "import", "--json"], home.env, {
      readSecret: () => readSecret(stdin, new PassThrough()),
    });
    stdin.end(readFileSync(download));
    const result = (await imported).json().result as { keyFile: string; address: string };
    expect(result.address).toBe(keypair.publicKey());
    expect(statSync(result.keyFile).mode & 0o777).toBe(0o600);
    expect((await KeyHolder.fromFile(result.keyFile)).address).toBe(keypair.publicKey());

    // A testnet download never becomes a pubnet key through import.
    const pubnetStdin = new PassThrough();
    const toPubnet = cli(
      [
        "keys",
        "import",
        "--name",
        "mainnet",
        "--json",
        "--network",
        PUBNET,
        "--rpc-url",
        "https://rpc.example",
        "--bazaar-url",
        "https://bazaar.example",
      ],
      home.env,
      { readSecret: () => readSecret(pubnetStdin, new PassThrough()) },
    );
    pubnetStdin.end(readFileSync(download));
    const refusedImport = await toPubnet;
    expect(refusedImport.json().error).toMatchObject({ code: "key_network_mismatch" });
    expectNoSeed(refusedImport, keypair.secret());

    // … or `chmod 600 <file>` before pointing RAIL402_SECRET_KEY_FILE at it.
    chmodSync(download, 0o600);
    expect((await KeyHolder.fromFile(download)).address).toBe(keypair.publicKey());
  });

  it("refuses a key file other users can read", async () => {
    const file = join(home.dir, "loose.key");
    const seed = Keypair.random().secret();
    writeFileSync(file, seed, { mode: 0o644 });
    const result = await cli(["keys", "show", "--key-file", file, "--json"], home.env);
    expect(result.json().error).toMatchObject({ code: "key_file_insecure" });
    expectNoSeed(result, seed);
  });

  it("shows a key given in the environment by its address only", async () => {
    const keypair = Keypair.random();
    const result = await cli(["keys", "show"], { ...home.env, RAIL402_SECRET_KEY: keypair.secret() });
    expect(result.stdout).toContain(keypair.publicKey());
    expect(result.stdout).toContain("RAIL402_SECRET_KEY");
    expectNoSeed(result, keypair.secret());
  });
});

describe("sessions in the shared ledger", () => {
  it("starts, lists and ends a named session, and shows the default one", async () => {
    await cli(["keys", "new"], home.env);
    const start = await cli(
      ["session", "start", "--name", "trip", "--max-total", "0.5", "--ttl", "2h", "--json"],
      home.env,
    );
    expect(start.status).toBe(0);
    expect(start.json().result).toMatchObject({
      session: "trip",
      autoRenew: false,
      assets: [{ asset: "USDC", sessionCap: "0.5", spent: "0", remaining: "0.5" }],
    });
    const twice = await cli(["session", "start", "--name", "trip"], home.env);
    expect(twice.status).toBe(EXIT.usage);
    expect(twice.stderr).toContain("add --force");
    expect((await cli(["session", "start", "--name", "trip", "--force"], home.env)).status).toBe(0);

    const shown = await cli(["session", "show", "--name", "trip", "--json"], home.env);
    expect(shown.json().result).toMatchObject({ session: "trip" });
    expect((await cli(["session", "show", "--json"], home.env)).json().result).toMatchObject({
      session: "default",
      autoRenew: true,
    });

    const list = await cli(["session", "list", "--json"], home.env);
    const windows = (list.json().result as { windows: { name: string; status: string }[] }).windows;
    expect(windows.map((window) => [window.name, window.status]).sort()).toEqual([
      ["default", "open"],
      ["trip", "ended"],
      ["trip", "open"],
    ]);
    const ended = await cli(["session", "end", "--name", "trip"], home.env);
    expect(ended.stdout).toContain('Ended session "trip"');
    expect((await cli(["session", "end", "--name", "trip"], home.env)).status).toBe(EXIT.usage);
    expect(statSync(join(home.env.XDG_STATE_HOME, "rail402", "ledger.sqlite")).isFile()).toBe(true);
  });

  it("needs a key", async () => {
    const result = await cli(["session", "show", "--json"], home.env);
    expect(result.status).toBe(EXIT.usage);
    expect(result.json().error).toMatchObject({ code: "payment_signer_unavailable" });
    const pay = await cli(["pay", "https://api.example/x", "--max", "0.01", "--json"], home.env);
    expect(pay.json().error).toMatchObject({ code: "payment_signer_unavailable", paid: "none" });
  });
});

describe("account onboarding on pubnet", () => {
  const pubnet = [
    "--network",
    "stellar:pubnet",
    "--rpc-url",
    "https://rpc.example",
    "--bazaar-url",
    "https://bazaar.example",
  ];

  it("needs --yes and refuses the testnet exchange", async () => {
    const env = { ...home.env, RAIL402_MAX_PER_CALL: "0.1 USDC", RAIL402_MAX_TOTAL: "1 USDC" };
    const confirm = await cli(["account", "setup", ...pubnet, "--json"], env);
    expect(confirm.status).toBe(EXIT.usage);
    expect(confirm.json().error?.["reason"]).toContain("add --yes");
    const usdc = await cli(["account", "setup", "--usdc", "5", "--yes", ...pubnet, "--json"], env);
    expect(usdc.json().error).toMatchObject({ code: "cli_command_not_supported_on_network" });
  });
});

describe("seller validate", () => {
  const payTo = Keypair.random().publicKey();
  const required = (bazaar: unknown) => ({
    x402Version: 2,
    resource: { url: "https://api.example.com/search", description: "Search", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: TESTNET,
        asset: USDC[TESTNET].contract,
        amount: "1000",
        payTo,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    ...(bazaar === undefined ? {} : { extensions: { bazaar } }),
  });

  it("previews the listing of a saved PAYMENT-REQUIRED, as JSON or base64", async () => {
    const bazaar = declareDiscoveryExtension({
      input: { q: "x" },
      inputSchema: { properties: { q: { type: "string", description: "Query" } } },
      output: { example: { results: [] } },
    })["bazaar"];
    const file = join(home.dir, "required.json");
    writeFileSync(file, JSON.stringify(required(bazaar)));
    const result = await cli(["seller", "validate", file, "--method", "GET", "--json"], home.env);
    expect(result.status).toBe(0);
    expect(result.json().result).toMatchObject({
      catalogable: true,
      preview: { resource: "https://api.example.com/search", method: "GET", payTo, amount: "1000" },
    });
    const encoded = join(home.dir, "required.b64");
    writeFileSync(encoded, Buffer.from(JSON.stringify(required(bazaar))).toString("base64"));
    expect((await cli(["seller", "validate", encoded, "--method", "GET"], home.env)).stdout).toContain(
      "catalog: would be listed",
    );
  });

  it("exits 3 when the catalog would not list it, and 2 for a file that is not a PaymentRequired", async () => {
    const file = join(home.dir, "bare.json");
    writeFileSync(file, JSON.stringify(required(undefined)));
    const result = await cli(["seller", "validate", file, "--json"], home.env);
    expect(result.status).toBe(EXIT.refused);
    expect(result.json().result).toMatchObject({ catalogable: false, code: "seller_discovery_missing" });
    writeFileSync(file, JSON.stringify({ x402Version: 1 }));
    expect((await cli(["seller", "validate", file], home.env)).status).toBe(EXIT.usage);
  });

  it("judges a loopback resource as the hosted catalog does unless --discovery-allow-loopback", async () => {
    const bazaar = declareDiscoveryExtension({
      input: { q: "x" },
      inputSchema: { properties: { q: { type: "string", description: "Query" } } },
      output: { example: { results: [] } },
    })["bazaar"];
    const file = join(home.dir, "local.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...required(bazaar),
        resource: { url: "http://localhost:4021/search", description: "Search" },
      }),
    );
    const args = ["seller", "validate", file, "--method", "GET", "--allow-http", "--allow-private-network"];
    const hosted = await cli([...args, "--json"], home.env);
    expect(hosted.status).toBe(EXIT.refused);
    expect(hosted.json().result).toMatchObject({
      catalogable: false,
      code: "bazaar_resource_unsafe",
      reason: 'Host "localhost" is not a public host.',
    });
    const local = await cli([...args, "--discovery-allow-loopback", "--json"], home.env);
    expect(local.status).toBe(EXIT.ok);
    expect(local.json().result).toMatchObject({ catalogable: true });
  });
});

describe("seller check", () => {
  const payTo = Keypair.random().publicKey();
  const bazaar = declareDiscoveryExtension({
    input: { topic: "craft" },
    inputSchema: { properties: { topic: { type: "string", description: "Topic of the quote" } } },
    output: { example: { quote: "Measure twice." } },
  })["bazaar"];
  const servers: Server[] = [];
  let origin = "";
  let flags: string[] = [];

  /**
   * A seller whose 402 names `resource` (with {origin} replaced by its own origin) as the paid URL;
   * `option` replaces fields of its one payment option.
   */
  function sellerAnswering(resource: string, option: Record<string, string> = {}): Server {
    return createServer((request, response) => {
      const self = `http://${request.headers.host ?? ""}`;
      const header = encodePaymentRequiredHeader({
        x402Version: 2,
        resource: {
          url: resource.replace("{origin}", self),
          description: "Quotes",
          mimeType: "application/json",
        },
        accepts: [
          {
            scheme: "exact",
            network: TESTNET,
            asset: USDC[TESTNET].contract,
            amount: "1000",
            payTo,
            maxTimeoutSeconds: 60,
            extra: { areFeesSponsored: true },
            ...option,
          },
        ],
        extensions: { bazaar },
      });
      response.writeHead(402, { "payment-required": header }).end();
    });
  }

  async function listen(server: Server): Promise<string> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  beforeAll(async () => {
    // A fee-sponsoring facilitator with the bazaar extension, and an RPC that answers every call with
    // an error, so nothing leaves this machine.
    const facilitator = createServer((request, response) => {
      if (request.url === "/supported") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: { areFeesSponsored: true } }],
            extensions: ["bazaar"],
            signers: {},
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const rpc = createServer((request, response) => {
      request.resume();
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "unavailable" } }));
    });
    origin = await listen(sellerAnswering("{origin}/quote"));
    flags = [
      "--facilitator-url",
      await listen(facilitator),
      "--rpc-url",
      await listen(rpc),
      "--allow-http",
      "--allow-private-network",
      // The 402s here carry discovery metadata without the method, which stock middleware adds.
      "--method",
      "GET",
    ];
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reports that the catalog refuses a local seller it was allowed to reach, and exits 3", async () => {
    const result = await cli(
      ["seller", "check", `${origin}/quote?topic=craft`, ...flags, "--json"],
      home.env,
    );
    expect(result.status).toBe(EXIT.refused);
    expect(result.json().result).toMatchObject({
      ok: false,
      status: 402,
      findings: [],
      validation: {
        catalogable: false,
        code: "bazaar_resource_unsafe",
        reason: 'Host "127.0.0.1" is not a public host.',
      },
    });
    const human = await cli(["seller", "check", `${origin}/quote?topic=craft`, ...flags], home.env);
    expect(human.status).toBe(EXIT.refused);
    expect(human.stdout).toContain(
      'catalog: would not be listed: bazaar_resource_unsafe: Host "127.0.0.1" is not a public host.',
    );
    expect(human.stdout).toContain("--discovery-allow-loopback");
    expect(human.stdout).toMatch(/result: +problems found/);
    expect(human.stdout).not.toContain("would list it");
  });

  it("prints the 402's payTo and asset without terminal controls, and JSON unchanged", async () => {
    const hostilePayTo = `${payTo}\u001b]52;c;djIz\u0007\r`;
    const hostileAsset = `${USDC[TESTNET].contract}\u001b[31m\u009b2J\u202e`;
    const hostile = await listen(
      sellerAnswering("{origin}/quote", { payTo: hostilePayTo, asset: hostileAsset }),
    );
    const human = await cli(["seller", "check", `${hostile}/quote?topic=craft`, ...flags], home.env);
    expect(human.stdout).toContain(
      `payTo ${payTo}]52;c;djIz  cannot receive ${USDC[TESTNET].contract}[31m2J`,
    );
    expect(human.stdout).not.toMatch(TERMINAL_CONTROL);
    const json = await cli(["seller", "check", `${hostile}/quote?topic=craft`, ...flags, "--json"], home.env);
    expect(json.json().result).toMatchObject({
      receivable: [{ payTo: hostilePayTo, asset: hostileAsset }],
      findings: [{ code: "seller_asset_not_receivable", details: { payTo: hostilePayTo } }],
    });
    const [finding] = (json.json().result as { findings: { reason: string }[] }).findings;
    expect(finding?.reason).not.toMatch(TERMINAL_CONTROL);
  });

  it("refuses localhost and private hosts named by the 402", async () => {
    for (const [resource, host] of [
      ["http://localhost:4021/quote", "localhost"],
      ["http://10.1.2.3/quote", "10.1.2.3"],
      ["http://192.168.0.7/quote", "192.168.0.7"],
    ] as const) {
      const url = await listen(sellerAnswering(resource));
      const result = await cli(["seller", "check", `${url}/quote`, ...flags, "--json"], home.env);
      expect(result.status, resource).toBe(EXIT.refused);
      expect(result.json().result, resource).toMatchObject({
        ok: false,
        validation: { code: "bazaar_resource_unsafe", reason: `Host "${host}" is not a public host.` },
      });
    }
  });

  it("lists a public host, and judges loopback as a DISCOVERY_ALLOW_LOOPBACK catalog when asked", async () => {
    const publicSeller = await listen(sellerAnswering("https://quotes.example.com/quote"));
    const listed = await cli(["seller", "check", `${publicSeller}/quote`, ...flags, "--json"], home.env);
    expect(listed.status).toBe(EXIT.ok);
    expect(listed.json().result).toMatchObject({
      ok: true,
      validation: { catalogable: true, preview: { resource: "https://quotes.example.com/quote" } },
    });

    const local = ["seller", "check", `${origin}/quote?topic=craft`, ...flags, "--discovery-allow-loopback"];
    const loopback = await cli([...local, "--json"], home.env);
    expect(loopback.status).toBe(EXIT.ok);
    expect(loopback.json().result).toMatchObject({ ok: true, validation: { catalogable: true } });
    expect((await cli(local, home.env)).stdout).toContain("DISCOVERY_ALLOW_LOOPBACK=true");

    // A private address is never listed, not even by a catalog that lists loopback.
    const privateSeller = await listen(sellerAnswering("http://10.1.2.3/quote"));
    const refused = await cli(
      ["seller", "check", `${privateSeller}/quote`, ...flags, "--discovery-allow-loopback", "--json"],
      home.env,
    );
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.json().result).toMatchObject({ validation: { code: "bazaar_resource_unsafe" } });
  });

  it("refuses --discovery-allow-loopback on pubnet", async () => {
    const result = await cli(
      [
        "seller",
        "check",
        "https://quotes.example.com/quote",
        "--network",
        "stellar:pubnet",
        "--rpc-url",
        "https://rpc.example",
        "--bazaar-url",
        "https://bazaar.example",
        "--discovery-allow-loopback",
        "--json",
      ],
      { ...home.env, RAIL402_MAX_PER_CALL: "0.1 USDC", RAIL402_MAX_TOTAL: "1 USDC" },
    );
    expect(result.status).toBe(EXIT.usage);
    expect(result.json().error?.["reason"]).toContain("testnet");
  });
});

describe("secret input", () => {
  it("reads one seed from a pipe", async () => {
    const stream = new PassThrough();
    const reading = readSecret(stream, new PassThrough());
    stream.end("SEED123\n");
    await expect(reading).resolves.toBe("SEED123");
    const two = new PassThrough();
    const refused = readSecret(two, new PassThrough());
    two.end("A B\n");
    await expect(refused).rejects.toMatchObject({ code: "cli_usage_invalid" });
    const tagged = new PassThrough();
    const readingTagged = readSecret(tagged, new PassThrough());
    tagged.end(`${KEY_FILE_TAG}${TESTNET}\nSEED123\n`);
    await expect(readingTagged).resolves.toBe(`${KEY_FILE_TAG}${TESTNET}\nSEED123`);
    const three = new PassThrough();
    const refusedThree = readSecret(three, new PassThrough());
    three.end("# a\n# b\nSEED123\n");
    await expect(refusedThree).rejects.toMatchObject({ code: "cli_usage_invalid" });
    const long = new PassThrough();
    const tooLong = readSecret(long, new PassThrough());
    long.end("x".repeat(2_000));
    await expect(tooLong).rejects.toMatchObject({ code: "cli_usage_invalid" });
  });

  it("reads a hidden line on a terminal, with backspace and cancel", async () => {
    const modes: boolean[] = [];
    const terminal = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (mode: boolean) => modes.push(mode),
    });
    const prompt = new PassThrough();
    const reading = readSecret(terminal, prompt);
    terminal.write("SEEX\u007fD\r");
    await expect(reading).resolves.toBe("SEED");
    expect(modes).toEqual([true, false]);
    expect(String(prompt.read())).toContain("input hidden");

    const cancelled = readSecret(terminal, new PassThrough());
    terminal.write("S\u0003");
    await expect(cancelled).rejects.toMatchObject({ code: "cli_usage_invalid" });
  });

  it("asks a yes/no question on a terminal: only y or yes approves", async () => {
    const terminal = () => Object.assign(new PassThrough(), { isTTY: true });
    const answer = async (typed: string | undefined) => {
      const stdin = terminal();
      const prompt = terminal();
      const asking = askOnTerminal(stdin, prompt, "Pay? [y/N] ");
      if (typed === undefined) stdin.end();
      else stdin.write(typed);
      const result = await asking;
      return { result, question: String(prompt.read()) };
    };
    for (const typed of ["y\n", "yes\n", " YES \n", "Y\r\n"]) expect((await answer(typed)).result).toBe(true);
    for (const typed of ["n\n", "\n", "yess\n", "sure\n", "x".repeat(80)]) {
      expect((await answer(typed)).result, JSON.stringify(typed)).toBe(false);
    }
    // Input closed before a line: no.
    expect((await answer(undefined)).result).toBe(false);
    expect((await answer("y\n")).question).toBe("Pay? [y/N] ");
    // Without a terminal on both sides nothing is asked, so a script never hangs.
    await expect(askOnTerminal(new PassThrough(), terminal(), "?")).resolves.toBeUndefined();
    await expect(askOnTerminal(terminal(), new PassThrough(), "?")).resolves.toBeUndefined();
  });
});
