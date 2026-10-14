/**
 * `pnpm dev`: the Playground server (restarted on change) behind Vite's dev server, which serves the
 * page with hot reload and forwards the server's routes to it.
 *
 * The page's origin is `http://127.0.0.1:<PLAYGROUND_DEV_PORT>` (default 5173), and the server is
 * started with that origin as PUBLIC_URL unless one is given, so its same-origin checks and the lab
 * sellers' resource URLs match the page. The server listens on `PLAYGROUND_SERVER_PORT` (default
 * 8787). Every other variable is passed to the server as is (see the configuration reference). Without
 * `PLAYGROUND_PAY_TO`, the lab sellers are turned off.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const devPort = port(process.env["PLAYGROUND_DEV_PORT"], 5173);
const serverPort = port(process.env["PLAYGROUND_SERVER_PORT"], 8787);
const origin = `http://127.0.0.1:${devPort}`;
const serverUrl = `http://127.0.0.1:${serverPort}`;

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(serverPort),
  HOST: "127.0.0.1",
  PUBLIC_URL: process.env["PUBLIC_URL"] ?? origin,
  ...(process.env["PLAYGROUND_PAY_TO"] === undefined && process.env["LAB_ENABLED"] === undefined
    ? { LAB_ENABLED: "false" }
    : {}),
};
if (env["PUBLIC_URL"] !== origin) {
  process.stderr.write(
    `PUBLIC_URL is ${env["PUBLIC_URL"]}, not the page's origin ${origin}: the server will refuse the page's calls.\n`,
  );
}

const server = spawn(process.execPath, ["--conditions=@rail402/source", "--watch", "src/main.ts"], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});

process.env["PLAYGROUND_DEV_SERVER"] = serverUrl;
const vite = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  mode: "development",
  server: { host: "127.0.0.1", port: devPort, strictPort: true },
});
await vite.listen();
process.stdout.write(`\nPlayground: ${origin}/  (server ${serverUrl})\n\n`);

let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  void vite.close().finally(() => process.exit(code));
};
server.on("exit", (code) => {
  stop(code ?? 1);
});
process.on("SIGINT", () => {
  stop(0);
});
process.on("SIGTERM", () => {
  stop(0);
});

function port(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`not a TCP port: ${value}`);
  }
  return parsed;
}
