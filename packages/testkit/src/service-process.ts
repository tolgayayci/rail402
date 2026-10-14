import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

export interface ServiceProcessOptions {
  /** The service's entry module, run with `node --conditions=@rail402/source`. */
  readonly entry: string;
  /** The child's whole environment besides `PATH`, `HOST` and `PORT`. */
  readonly env: Readonly<Record<string, string>>;
  /** The port to listen on; a free one by default. */
  readonly port?: number;
}

/** One structured log line the service wrote to stdout. */
export interface LogLine {
  readonly msg: string;
  readonly [field: string]: unknown;
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** `performance.now()` at exit. */
  readonly at: number;
}

/** Service processes still alive; `stopServiceProcesses()` kills them. */
const running = new Set<ServiceProcess>();

/**
 * The service run as a real child process, observed from outside as an operator's supervisor sees
 * it: its structured logs, its exit, and signals — including `SIGKILL`, which no handler can catch.
 */
export class ServiceProcess {
  readonly process: ChildProcess;
  readonly port: number;
  readonly url: string;
  /** Every structured log line, in the order written. */
  readonly logs: LogLine[] = [];
  /** Resolves when the process has exited, however it exits, and its output has been read. */
  readonly exited: Promise<Exit>;
  private readonly options: ServiceProcessOptions;
  private stderrText = "";

  private constructor(options: ServiceProcessOptions, port: number) {
    this.options = options;
    this.port = port;
    this.url = `http://127.0.0.1:${String(port)}`;
    this.process = spawn(process.execPath, ["--conditions=@rail402/source", options.entry], {
      env: { PATH: process.env["PATH"] ?? "", ...options.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffered = "";
    this.process.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
          this.logs.push(JSON.parse(line) as LogLine);
        } catch {
          // Not a log line.
        }
      }
    });
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
    });
    // `exit` can fire while stdout still holds the last log lines; `close` fires once the pipes are
    // drained, so `logs` is complete when `exited` resolves. The time is taken at `exit`.
    let exitedAt = 0;
    this.process.once("exit", () => {
      exitedAt = performance.now();
    });
    this.exited = new Promise((resolve) => {
      this.process.once("close", (code, signal) => {
        running.delete(this);
        resolve({ code, signal, at: exitedAt === 0 ? performance.now() : exitedAt });
      });
    });
    running.add(this);
  }

  /** Starts the service; it is listening once `listening()` resolves. */
  static async start(options: ServiceProcessOptions): Promise<ServiceProcess> {
    return new ServiceProcess(options, options.port ?? (await freePort()));
  }

  /** Log messages (`msg`) in the order they were written. */
  get messages(): string[] {
    return this.logs.map((line) => line.msg);
  }

  get stderr(): string {
    return this.stderrText;
  }

  /** Resolves once the service logs `message`; rejects if it exits or `timeoutMs` passes first. */
  async waitForLog(message: string, timeoutMs = 60_000): Promise<LogLine> {
    const deadline = Date.now() + timeoutMs;
    const state = { exited: false };
    void this.exited.then(() => (state.exited = true));
    for (;;) {
      const line = this.logs.find((entry) => entry.msg === message);
      if (line !== undefined) return line;
      if (state.exited) throw new Error(`service exited before logging "${message}": ${this.stderrText}`);
      if (Date.now() >= deadline)
        throw new Error(`service did not log "${message}" in ${String(timeoutMs)} ms`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Resolves once the service accepts requests. */
  listening(timeoutMs?: number): Promise<LogLine> {
    return this.waitForLog("rail402 listening", timeoutMs);
  }

  /** Sends `signal` and waits for the process to exit. */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<Exit> {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill(signal);
    return this.exited;
  }

  /**
   * Starts the same service again on the same port, as a supervisor restarts a crashed process,
   * optionally with some variables changed. Kills this process first if it is still running.
   */
  async restart(env: Readonly<Record<string, string>> = {}): Promise<ServiceProcess> {
    await this.kill("SIGKILL");
    return ServiceProcess.start({ ...this.options, env: { ...this.options.env, ...env }, port: this.port });
  }
}

/** Kills every service process a test left running. */
export async function stopServiceProcesses(): Promise<void> {
  await Promise.all([...running].map((service) => service.kill("SIGKILL")));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
