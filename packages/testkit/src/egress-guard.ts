/**
 * Refuses, and records, every network request this process makes to a set of hosts: `fetch`, every
 * TCP or TLS connection (`net.Socket#connect`, which undici, `node:http` and `node:https` all use) and
 * DNS lookups. A test installs it to prove that code paths never depend on a service, here Rail402's
 * own hosted endpoints: a request to a refused host fails as if the host were unreachable, and the
 * test asserts afterwards that none was attempted.
 */
import dns from "node:dns";
import net from "node:net";

/** `rail402.dev` and every host under it. */
export const RAIL402_HOSTS = (host: string): boolean => /(^|\.)rail402\.dev\.?$/i.test(host);

export interface EgressGuard {
  /** Every refused attempt, as `<kind> <host>`, in order. */
  readonly attempts: readonly string[];
  /** Puts back what the guard replaced. */
  restore(): void;
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

/** The host a `Socket#connect` call is for, in any of its call forms. */
function connectHost(args: readonly unknown[]): string | undefined {
  // `net.connect` passes its normalized arguments as one array.
  const first: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "object" && first !== null) {
    const { host, servername } = first as { host?: unknown; servername?: unknown };
    if (typeof host === "string") return host;
    if (typeof servername === "string") return servername;
    return undefined;
  }
  return typeof args[1] === "string" ? args[1] : undefined;
}

function refusal(host: string): Error {
  return Object.assign(new Error(`egress guard: connection to ${host} refused`), { code: "ECONNREFUSED" });
}

/** Installs the guard for hosts `refused` matches; call `restore()` when done. */
export function guardEgress(refused: (host: string) => boolean = RAIL402_HOSTS): EgressGuard {
  const attempts: string[] = [];
  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored onto its own prototype
  const originalConnect = net.Socket.prototype.connect as unknown as Connect;
  const originalLookup = dns.lookup;
  const originalPromiseLookup = dns.promises.lookup;

  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (refused(url.hostname)) {
      attempts.push(`fetch ${url.hostname}`);
      return Promise.reject(new TypeError("fetch failed", { cause: refusal(url.hostname) }));
    }
    return originalFetch(input, init);
  };

  const connect: Connect = function (this: net.Socket, ...args) {
    const host = connectHost(args);
    if (host !== undefined && refused(host)) {
      attempts.push(`connect ${host}`);
      process.nextTick(() => this.destroy(refusal(host)));
      return this;
    }
    return originalConnect.apply(this, args);
  };
  (net.Socket.prototype as unknown as { connect: Connect }).connect = connect;

  const lookup = ((hostname: string, ...rest: unknown[]) => {
    if (refused(hostname)) {
      attempts.push(`lookup ${hostname}`);
      const callback = rest.at(-1);
      if (typeof callback === "function") {
        const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        process.nextTick(() => {
          (callback as (error: Error) => void)(error);
        });
      }
      return undefined;
    }
    return (originalLookup as (...args: unknown[]) => unknown)(hostname, ...rest);
  }) as typeof dns.lookup;
  dns.lookup = lookup;
  dns.promises.lookup = ((hostname: string, ...rest: unknown[]) => {
    if (refused(hostname)) {
      attempts.push(`lookup ${hostname}`);
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }),
      );
    }
    return (originalPromiseLookup as (...args: unknown[]) => unknown)(hostname, ...rest);
  }) as typeof dns.promises.lookup;

  return {
    attempts,
    restore() {
      globalThis.fetch = originalFetch;
      (net.Socket.prototype as unknown as { connect: Connect }).connect = originalConnect;
      dns.lookup = originalLookup;
      dns.promises.lookup = originalPromiseLookup;
    },
  };
}
