import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createApp, type AppOptions, type PlaygroundApp } from "../src/app.ts";
import { loadConfig, type PlaygroundConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";

/** A public G… address used as the lab's payTo in tests. */
export const PAY_TO = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

/** A configuration from environment variables, with a public origin and payTo filled in. */
export function testConfig(env: Record<string, string | undefined> = {}): PlaygroundConfig {
  return loadConfig(
    { PUBLIC_URL: "https://playground.example", PLAYGROUND_PAY_TO: PAY_TO, ...env },
    { version: "0.3.0" },
  );
}

/** Log lines written by a test logger, parsed. */
export class LogLines {
  readonly raw: string[] = [];
  readonly stream = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      this.raw.push(
        ...chunk
          .toString("utf8")
          .split("\n")
          .filter((line) => line !== ""),
      );
      done();
    },
  });

  get lines(): Record<string, unknown>[] {
    return this.raw.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  text(): string {
    return this.raw.join("\n");
  }
}

/** A built page in a temporary directory: index.html and one hashed asset. */
export function fakeWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "playground-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Rail402 Playground</title>");
  writeFileSync(join(root, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(root, "favicon.svg"), "<svg/>");
  return root;
}

export interface TestApp extends PlaygroundApp {
  readonly logs: LogLines;
  request(path: string, init?: RequestInit): Promise<Response>;
}

/** The app under test, logging at trace level into memory. */
export function testApp(
  config: PlaygroundConfig,
  options: Partial<Omit<AppOptions, "config" | "log">> = {},
): TestApp {
  const logs = new LogLines();
  const log = createLogger({ level: "trace", version: config.version }, logs.stream);
  const playground = createApp({ config, log, webRoot: fakeWebRoot(), ...options });
  return {
    ...playground,
    logs,
    request: async (path, init) => playground.app.request(path, init),
  };
}
