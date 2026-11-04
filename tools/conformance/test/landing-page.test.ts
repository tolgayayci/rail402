// @vitest-environment happy-dom
/**
 * The landing page (rail402.dev): one external script and no inline code or styles, every file from its own
 * origin, the same design system files as the status page, links that point at pages and packages that
 * exist, and an animation that writes text only and starts from the frame the HTML already shows.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const root = join(import.meta.dirname, "../../..");
const site = join(root, "deploy/landing/site");
const pages = ["index.html", "404.html"].map(
  (name) => [name, readFileSync(join(site, name), "utf8")] as const,
);
const html = pages[0]?.[1] ?? "";
const script = readFileSync(join(site, "landing.js"), "utf8");
const policyOf = (page: string): string =>
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page)?.[1] ?? "";
const hrefs = [...html.matchAll(/\shref="(https:[^"]+)"/g)].map((match) => match[1] ?? "");

/** The parts of the simulated DOM the test reads; the project compiles without the DOM library. */
interface Node {
  readonly textContent: string | null;
  readonly className: string;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<Node>;
}
const { document } = globalThis as unknown as {
  readonly document: {
    readonly body: { innerHTML: string };
    querySelectorAll(selector: string): ArrayLike<Node>;
  };
};
const all = (selector: string): Node[] => Array.from(document.querySelectorAll(selector));
type Frame = (tick: number, qi: number, t: number, still: boolean) => Record<string, string | number>;

describe("the landing page", () => {
  it("runs only its own script file, with no inline code or styles", () => {
    for (const [name, page] of pages) {
      const policy = policyOf(page);
      expect(policy, name).toMatch(
        /^default-src 'self'; script-src '(self|none)'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'$/,
      );
      expect(page, name).not.toMatch(/<style\b|\sstyle\s*=|\son[a-z]+\s*=/i);
      for (const [, attrs, body] of page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        expect(body?.trim(), name).toBe("");
        expect(attrs, name).toMatch(/^ src="landing\.js" defer$/);
      }
    }
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("serves every file it names, and the design system the status page serves", () => {
    for (const [name, page] of pages) {
      for (const [, path] of page.matchAll(/\s(?:href|src)="(\/?[^"#:]+)"/g)) {
        const file = (path ?? "").replace(/^\//, "") || "index.html";
        expect(existsSync(join(site, file)), `${name}: ${path}`).toBe(true);
      }
    }
    const status = join(root, "deploy/status/site/design");
    const files = (dir: string): string[] =>
      readdirSync(join(status, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name === "README.md"
            ? []
            : [join(dir, entry.name)],
      );
    const shared = files(".");
    expect(shared).toEqual(expect.arrayContaining(["tokens.css", "rail402.css"]));
    for (const file of shared) {
      expect(readFileSync(join(site, "design", file)).equals(readFileSync(join(status, file))), file).toBe(
        true,
      );
    }
    for (const sheet of ["design/tokens.css", "design/rail402.css"]) {
      const css = readFileSync(join(site, sheet), "utf8");
      for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) {
        expect(existsSync(join(site, dirname(sheet), url ?? "")), url).toBe(true);
      }
    }
  });

  it("links only to Rail402's own hosts and the public pages it names", () => {
    const allowed =
      /^https:\/\/((docs|playground|explorer|testnet|mainnet|status)\.)?rail402\.dev(\/|$)|^https:\/\/github\.com\/(tolgayayci\/rail402|x402-foundation\/x402\/pull\/3859)$|^https:\/\/www\.npmjs\.com\/package\/@rail402\.dev\/[a-z-]+$|^https:\/\/stellar\.expert\/explorer\/testnet\/contract\/C[A-Z2-7]{55}$/;
    expect(hrefs.length).toBeGreaterThan(30);
    for (const href of hrefs) expect(href).toMatch(allowed);
  });

  it("points every docs link at a page in docs/", () => {
    const docs = hrefs.filter((href) => href.startsWith("https://docs.rail402.dev/"));
    expect(docs.length).toBeGreaterThan(10);
    for (const href of docs) {
      const path = new URL(href).pathname.replace(/^\/|\/$/g, "");
      const candidates = [`${path}.mdx`, `${path}.md`, `${path}/index.mdx`].map((file) =>
        join(root, "docs", file),
      );
      expect(
        candidates.some((file) => existsSync(file)),
        href,
      ).toBe(true);
    }
  });

  it("names only packages this repository publishes, and the code count its reference lists", () => {
    const published = new Set(
      readdirSync(join(root, "packages")).flatMap((dir) => {
        const file = join(root, "packages", dir, "package.json");
        if (!existsSync(file)) return [];
        const pkg = JSON.parse(readFileSync(file, "utf8")) as { name: string; private?: boolean };
        return pkg.private ? [] : [pkg.name];
      }),
    );
    const also = /<div class="door also">[\s\S]*?<p>([^<]+)<\/p>/.exec(html)?.[1] ?? "";
    const named = new Set([
      ...also.split("·").map((name) => `@rail402.dev/${name.trim()}`),
      ...[...html.matchAll(/@rail402\.dev\/([a-z-]+)/g)].map((match) => `@rail402.dev/${match[1] ?? ""}`),
      ...[...script.matchAll(/^const PACKAGES = \[([^\]]+)\]/gm)].flatMap((match) =>
        [...(match[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((name) => `@rail402.dev/${name[1] ?? ""}`),
      ),
    ]);
    expect(named.size).toBeGreaterThanOrEqual(12);
    for (const name of named) expect(published, name).toContain(name);
    const reference = readFileSync(join(root, "docs/reference/error-codes.mdx"), "utf8");
    const codes = new Set([...reference.matchAll(/^\| `([a-z0-9_]+)`/gm)].map((match) => match[1]));
    expect(html).toContain(`<b>${codes.size}</b>`);
  });

  describe("its animation", () => {
    let frame: Frame;
    beforeAll(() => {
      vi.useFakeTimers();
      const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? "";
      document.body.innerHTML = body;
      frame = runInThisContext(`(function () {\n${script}\nreturn frame;\n})()`) as Frame;
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    it("starts from the final frame the HTML is written with", () => {
      const still = frame(0, 0, 1_000, true);
      const texts = all("[data-text]");
      expect(texts.length).toBeGreaterThan(15);
      // Compared as rendered: the HTML may wrap a long value across lines.
      const rendered = (text: string | null): string => (text ?? "").replace(/\s+/g, " ");
      for (const el of texts)
        expect(rendered(el.textContent), el.getAttribute("data-text") ?? "").toBe(
          rendered(String(still[el.getAttribute("data-text") ?? ""])),
        );
      for (const el of all("[data-cls]"))
        expect(el.className, el.getAttribute("data-cls") ?? "").toBe(
          String(still[el.getAttribute("data-cls") ?? ""]),
        );
    });

    it("types a query, then shows two real listings as text", () => {
      vi.advanceTimersByTime(55 * 3);
      expect(all("[data-text=typed]")[0]?.textContent).toBe("wea");
      expect(all("[data-results] .res")).toHaveLength(0);
      vi.advanceTimersByTime(55 * 40);
      const rows = all("[data-results] .res");
      expect(rows.map((row) => row.querySelectorAll("b")[0]?.textContent)).toEqual([
        "Weather forecast for a city",
        "Current weather for a city",
      ]);
      expect(all("[data-results] img, [data-results] script")).toHaveLength(0);
    });
  });
});
