import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { TESTNET, USDC } from "@rail402.dev/stellar";
import { EXIT, parseCommandLine, resolveContext } from "@rail402.dev/cli";
import { KeyHolder } from "@rail402.dev/sdk";
import { readSecret } from "../src/secret-input.ts";
import { cli, sandboxHome, type CliRun } from "./helpers.ts";

let home: ReturnType<typeof sandboxHome>;
beforeEach(() => {
  home = sandboxHome();
});
afterEach(() => {
  home.dispose();
});

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
    const seed = readFileSync(keyFile, "utf8").trim();
    expect(Keypair.fromSecret(seed).publicKey()).toBe(address);
    expectNoSeed(created, seed);

    const again = await cli(["keys", "new"], home.env);
    expect(again.status).toBe(EXIT.usage);
    expect(again.stderr).toContain("key_exists");
    expect(readFileSync(keyFile, "utf8").trim()).toBe(seed);

    // The default key is found without any flag or variable.
    const shown = await cli(["keys", "show", "--json"], home.env);
    expect(shown.json().result).toEqual({ address, keyFile, source: "default key file", network: TESTNET });
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
    // A browser saves the download as the seed on one line, readable by others (0644 or 0664).
    const download = join(home.dir, "rail402-testnet-gabc1234.key");
    const keypair = Keypair.random();
    writeFileSync(download, `${keypair.secret()}\n`, { mode: 0o644 });
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
});
