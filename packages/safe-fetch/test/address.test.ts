import { describe, expect, it } from "vitest";
import {
  REFUSED_LOOKUP,
  checkUrl,
  ipLiteral,
  isLoopbackAddress,
  isLoopbackHost,
  isPublicAddress,
  isPublicHostname,
  nextHop,
  pinnedLookup,
  resolvePolicy,
  type EgressError,
} from "@rail402.dev/safe-fetch";

describe("address classification", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200", // a cloud metadata service inside carrier-grade NAT
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:0:7f00:1", // IPv4-translated (SIIT) loopback
    "::ffff:0:a9fe:a9fe", // IPv4-translated metadata address
    "::ffff:0:808:808", // IPv4-translated public address: refused whole
    "64:ff9b::808:808", // NAT64 of a public address: refused whole
    "64:ff9b:1::1",
    "2001::1", // Teredo
    "2001:db8::1",
    "2002:7f00:1::1", // 6to4
    "3fff::1",
    "fc00::1",
    "fd00:ec2::254", // a cloud metadata address
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "not an address",
    "",
  ])("%s is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "::ffff:8.8.8.8", "2606:4700:4700::1111"])(
    "%s is public",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it("knows loopback addresses and hosts", () => {
    for (const address of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
    for (const address of ["10.0.0.1", "169.254.169.254", "8.8.8.8", "fe80::1"]) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
    for (const host of ["localhost", "LOCALHOST.", "api.localhost", "127.0.0.1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  it("refuses local-only names", () => {
    for (const host of [
      "localhost",
      "printer.local",
      "db.internal",
      "nas.home.arpa",
      "router.lan",
      "intranet",
      "",
    ]) {
      expect(isPublicHostname(host), host).toBe(false);
    }
    expect(isPublicHostname("api.example.com.")).toBe(true);
    expect(isPublicHostname("xn--bcher-kva.example")).toBe(true);
    expect(ipLiteral("[::1]")).toBe("::1");
    expect(ipLiteral("example.com")).toBeUndefined();
  });
});

describe("checkUrl", () => {
  const policy = resolvePolicy();
  const code = (url: string, p = policy) => {
    try {
      checkUrl(url, p);
      return "ok";
    } catch (error) {
      return (error as EgressError).code;
    }
  };

  it("accepts public https URLs and returns a parsed copy", () => {
    expect(checkUrl("https://api.example.com/weather?city=Paris", policy).href).toBe(
      "https://api.example.com/weather?city=Paris",
    );
    expect(code("https://api.example.com:443/x")).toBe("ok");
  });

  it("classifies IP literals in every spelling before any lookup", () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://2130706433/",
      "https://0x7f.1/",
      "https://0177.0.0.1/",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:a9fe:a9fe]/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[fd00:ec2::254]/",
      "https://100.100.100.200/",
      "https://[64:ff9b::a9fe:a9fe]/",
      "https://[::ffff:0:a9fe:a9fe]/",
      "https://[::ffff:0:7f00:1]/",
    ]) {
      expect(code(url), url).toBe("egress_destination_not_allowed");
    }
    expect(code("https://8.8.8.8/")).toBe("ok");
  });

  it("refuses local names, schemes, ports, credentials, control characters and long URLs", () => {
    expect(code("https://localhost/")).toBe("egress_destination_not_allowed");
    expect(code("https://metadata.google.internal/")).toBe("egress_destination_not_allowed");
    expect(code("https://intranet/")).toBe("egress_destination_not_allowed");
    expect(code("http://api.example.com/")).toBe("egress_scheme_not_allowed");
    expect(code("file:///etc/passwd")).toBe("egress_scheme_not_allowed");
    expect(code("ftp://api.example.com/")).toBe("egress_scheme_not_allowed");
    expect(code("https://api.example.com:8443/")).toBe("egress_port_not_allowed");
    expect(code("https://user:pass@api.example.com/")).toBe("egress_url_invalid");
    expect(code("https://api.exa\tmple.com/")).toBe("egress_url_invalid");
    expect(code("https://api.example.com/\n")).toBe("egress_url_invalid");
    expect(code(`https://api.example.com/${"a".repeat(2_048)}`)).toBe("egress_url_invalid");
    expect(code("/relative")).toBe("egress_url_invalid");
  });

  it("allows http on port 80 only when enabled, and loopback only when enabled", () => {
    const http = resolvePolicy({ schemes: ["https:", "http:"] });
    expect(http.ports).toEqual([443, 80]);
    expect(code("http://api.example.com/", http)).toBe("ok");
    expect(code("http://localhost/", http)).toBe("egress_destination_not_allowed");
    const loopback = resolvePolicy({ schemes: ["http:"], ports: [8080], allowPrivateNetwork: "loopback" });
    expect(code("http://localhost:8080/", loopback)).toBe("ok");
    expect(code("http://127.0.0.1:8080/", loopback)).toBe("ok");
    expect(code("http://[::1]:8080/", loopback)).toBe("ok");
    expect(code("http://10.0.0.1:8080/", loopback)).toBe("egress_destination_not_allowed");
    expect(code("http://169.254.169.254:8080/", loopback)).toBe("egress_destination_not_allowed");
    expect(code("http://printer.local:8080/", loopback)).toBe("egress_destination_not_allowed");
  });

  it("validates the policy itself", () => {
    expect(() => resolvePolicy({ schemes: ["ftp:" as "http:"] })).toThrow(TypeError);
    expect(() => resolvePolicy({ ports: [0] })).toThrow(TypeError);
    expect(() => resolvePolicy({ allowPrivateNetwork: "all" as "loopback" })).toThrow(TypeError);
    expect(() => resolvePolicy({ limits: { responseBodyBytes: -1 } })).toThrow(TypeError);
    expect(() => resolvePolicy({ timeouts: { totalMs: 1.5 } })).toThrow(TypeError);
    expect(resolvePolicy().userAgent).toMatch(/^rail402\/\d+\.\d+\.\d+ \(\+https:\/\/rail402\.dev\)$/);
    expect(resolvePolicy().maxSocketsPerHost).toBe(4);
    expect(resolvePolicy({ maxSocketsPerHost: 32 }).maxSocketsPerHost).toBe(32);
    expect(() => resolvePolicy({ maxSocketsPerHost: 0 })).toThrow(TypeError);
    expect(() => resolvePolicy({ maxSocketsPerHost: 2.5 })).toThrow(TypeError);
    expect(resolvePolicy()).toMatchObject({
      keepAlive: true,
      maxTotalSockets: 256,
      idleSocketMs: 15_000,
      maxFreeSocketsPerHost: 2,
    });
    expect(() => resolvePolicy({ maxTotalSockets: 0 })).toThrow(TypeError);
    expect(() => resolvePolicy({ idleSocketMs: 0 })).toThrow(TypeError);
    expect(() => resolvePolicy({ keepAlive: "yes" as unknown as boolean })).toThrow(TypeError);
  });
});

describe("pinnedLookup", () => {
  const run = (
    answer: readonly { address: string; family: 4 | 6 }[],
    options: { all?: boolean; family?: number } = {},
  ) =>
    new Promise<{ error: NodeJS.ErrnoException | null; result: unknown }>((resolve) => {
      const lookup = pinnedLookup(isPublicAddress, () => Promise.resolve(answer));
      lookup("api.example.com", options, (error, address, family) => {
        resolve({ error, result: options.all === true ? address : { address, family } });
      });
    });

  it("returns validated addresses, all of them when asked", async () => {
    const answer = [
      { address: "8.8.8.8", family: 4 as const },
      { address: "2606:4700:4700::1111", family: 6 as const },
    ];
    expect((await run(answer)).result).toEqual({ address: "8.8.8.8", family: 4 });
    expect((await run(answer, { all: true })).result).toEqual(answer);
    expect((await run(answer, { family: 6 })).result).toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });

  it("refuses an empty answer and a mixed one, without naming the address", async () => {
    for (const answer of [
      [],
      [{ address: "10.0.0.1", family: 4 as const }],
      [
        { address: "8.8.8.8", family: 4 as const },
        { address: "169.254.169.254", family: 4 as const },
      ],
      // An IPv4-translated AAAA answer reaches its embedded IPv4 address.
      [{ address: "::ffff:0:a9fe:a9fe", family: 6 as const }],
      // A private address of the family that was not asked for still refuses the whole answer.
      [
        { address: "8.8.8.8", family: 4 as const },
        { address: "fd00::1", family: 6 as const },
      ],
    ]) {
      const { error } = await run(answer, { family: 4 });
      expect(error?.code).toBe(REFUSED_LOOKUP);
      expect(error?.message).not.toMatch(/10\.0\.0\.1|169\.254|fd00/);
    }
  });

  it("reports resolver failures as DNS errors", async () => {
    const lookup = pinnedLookup(isPublicAddress, () => Promise.reject(new Error("SERVFAIL")));
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("api.example.com", {}, (failure) => {
        resolve(failure);
      });
    });
    expect(error?.code).toBe("ENOTFOUND");
  });
});

describe("nextHop", () => {
  const policy = resolvePolicy({ schemes: ["https:", "http:"] });
  const from = new URL("https://api.example.com/a/b");

  it("follows same-origin Locations and applies fetch's method rules", () => {
    expect(nextHop(from, 302, "../c", "GET", policy)).toMatchObject({ method: "GET", dropBody: false });
    expect(nextHop(from, 302, "../c", "GET", policy).url.href).toBe("https://api.example.com/c");
    expect(nextHop(from, 303, "/c", "POST", policy)).toMatchObject({ method: "GET", dropBody: true });
    expect(nextHop(from, 303, "/c", "HEAD", policy)).toMatchObject({ method: "HEAD", dropBody: false });
    expect(nextHop(from, 301, "/c", "POST", policy)).toMatchObject({ method: "GET", dropBody: true });
    expect(nextHop(from, 307, "/c", "POST", policy)).toMatchObject({ method: "POST", dropBody: false });
    expect(nextHop(from, 308, "/c", "PUT", policy)).toMatchObject({ method: "PUT", dropBody: false });
  });

  it("allows only the http to https upgrade as a scheme change", () => {
    const http = new URL("http://api.example.com/a");
    expect(nextHop(http, 301, "https://api.example.com/a", "GET", policy).url.protocol).toBe("https:");
    expect(() => nextHop(from, 301, "http://api.example.com/a", "GET", policy)).toThrow(/another origin/);
  });

  it("refuses other origins, ports and private destinations", () => {
    for (const location of [
      "https://evil.example.com/",
      "https://api.example.com:8443/",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost/",
      "//evil.example.com/x",
    ]) {
      let failure: EgressError | undefined;
      try {
        nextHop(from, 302, location, "GET", policy);
      } catch (error) {
        failure = error as EgressError;
      }
      expect(failure?.code, location).toBe("egress_redirect_not_allowed");
      expect(failure?.stage).toBe("redirect");
    }
  });
});
