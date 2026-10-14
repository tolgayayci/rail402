/**
 * The code-panel snippets of each scenario. The sources live in `src/snippets/`, where they are
 * type-checked against the real packages; the page imports them as text and fills `{{…}}` from the
 * configuration and the visitor's cap.
 */
import type { JsonValue, ScenarioId } from "../engine/events.ts";
import type { PublicConfig } from "../engine/types.ts";
import type { CodeTab } from "./CodePanel.tsx";
import cliPay from "../../../src/snippets/cli-pay.txt?raw";
import cliSell from "../../../src/snippets/cli-sell.txt?raw";
import cliUpto from "../../../src/snippets/cli-upto.txt?raw";
import mcpConfig from "../../../src/snippets/mcp-config.json?raw";
import mcpTools from "../../../src/snippets/mcp-tools.ts?raw";
import payUrlCli from "../../../src/snippets/pay-url-cli.txt?raw";
import payUrlHttp from "../../../src/snippets/pay-url-http.txt?raw";
import payUrlMcp from "../../../src/snippets/pay-url-mcp.ts?raw";
import payUrlSdk from "../../../src/snippets/pay-url-sdk.ts?raw";
import sdkPay from "../../../src/snippets/sdk-pay.ts?raw";
import sdkUpto from "../../../src/snippets/sdk-upto.ts?raw";
import sellerInstall from "../../../src/snippets/seller-install.txt?raw";
import sellerRoute from "../../../src/snippets/seller-route.ts?raw";
import sellerServer from "../../../src/snippets/seller-server.ts?raw";

export const SNIPPET_SOURCES = Object.freeze({
  cliPay,
  cliSell,
  cliUpto,
  mcpConfig,
  mcpTools,
  payUrlCli,
  payUrlHttp,
  payUrlMcp,
  payUrlSdk,
  sdkPay,
  sdkUpto,
  sellerInstall,
  sellerRoute,
  sellerServer,
});

export interface SnippetValues {
  readonly cap: string;
  readonly config: PublicConfig;
  /**
   * The URL the Pay page pays, as typed, linked or listed: untrusted text. Only an http(s) URL that
   * parses is shown, and only escaped for where it goes; anything else shows a placeholder.
   */
  readonly url?: string;
}

/** What a snippet shows for a URL that cannot be shown safely. */
export const URL_PLACEHOLDER = "https://…";

/**
 * The URL as the parser normalizes it, when the text is one absolute http(s) URL and holds no
 * whitespace or control characters (the parser would silently drop some of them); else undefined.
 */
export function snippetUrl(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (text === "" || /[\s\u0000-\u001f\u007f-\u009f]/.test(text) || !URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.href;
}

/** A string as one single-quoted POSIX shell word: nothing inside it is expanded or executed. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A string's content inside a double-quoted JSON or TypeScript string literal. */
function stringContent(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/**
 * Fills a snippet's placeholders. Unknown placeholders stay as they are. `{{url}}` sits inside a
 * double-quoted string literal (TypeScript, JSON) or stands alone in an HTTP sketch; `{{urlShell}}`
 * is a whole shell word.
 */
export function fillSnippet(source: string, values: SnippetValues): string {
  const { config } = values;
  const url = values.url === undefined ? undefined : (snippetUrl(values.url) ?? URL_PLACEHOLDER);
  const fills: Readonly<Record<string, string>> = {
    cap: values.cap,
    asset: config.asset.symbol,
    sessionTotal: config.caps.sessionTotal,
    demoSeller: config.urls.demoSeller.replace(/\/+$/, ""),
    facilitator: config.urls.facilitator.replace(/\/+$/, ""),
    public: config.urls.public.replace(/\/+$/, ""),
    ...(url === undefined ? {} : { url: stringContent(url), urlShell: shellWord(url) }),
  };
  return dropHeader(source).replace(/\{\{(\w+)\}\}/g, (whole, name: string) => fills[name] ?? whole);
}

/** Leading `//` comment lines describe the file for maintainers; the page does not show them. */
function dropHeader(source: string): string {
  const lines = source.split("\n");
  let index = 0;
  while (index < lines.length && /^\/\/(?!.*@step:)/.test(lines[index] ?? "")) index += 1;
  return lines.slice(index).join("\n");
}

/** The code tabs of a scenario, in the order the panel shows them. */
export function scenarioTabs(scenario: ScenarioId, values: SnippetValues): readonly CodeTab[] {
  const tab = (id: string, label: string, source: string): CodeTab => ({
    id,
    label,
    source: fillSnippet(source, values),
  });
  switch (scenario) {
    case "pay":
      return [tab("sdk", "SDK", sdkPay), tab("cli", "CLI", cliPay)];
    case "upto":
      return [tab("sdk", "SDK", sdkUpto), tab("cli", "CLI", cliUpto)];
    case "agent":
      return [tab("tools", "Tool calls", mcpTools), tab("mcp", "MCP config", mcpConfig)];
    case "sell":
      return [
        {
          id: "seller",
          label: "Seller code",
          source: `${fillSnippet(sellerRoute, values)}\n\n${fillSnippet(sellerServer, values)}`,
        },
        tab("cli", "CLI", cliSell),
      ];
  }
}

/**
 * What the Pay page pays, for its code tabs: a URL with a method and an optional JSON body, or a
 * Bazaar listing with the visitor's parameters (path and query values, or tool arguments).
 */
export type PaySnippetRequest =
  | {
      readonly kind: "url";
      readonly method: string;
      readonly body?: JsonValue;
    }
  | {
      readonly kind: "listing";
      readonly listingId: string;
      readonly type: "http" | "mcp";
      readonly toolName: string | null;
      readonly pathParams: readonly string[];
      readonly params: Readonly<Record<string, JsonValue>>;
    };

/** A value as a TypeScript or JSON literal: JSON text is both, with every string escaped. */
function literal(value: JsonValue): string {
  return JSON.stringify(value);
}

/** Listing parameters split as a call takes them: path values, query values, or tool arguments. */
function listingCall(request: Extract<PaySnippetRequest, { kind: "listing" }>): {
  readonly pathParams: Record<string, string>;
  readonly query: Record<string, string | number | boolean>;
  readonly arguments: Record<string, JsonValue> | undefined;
} {
  if (request.type === "mcp") return { pathParams: {}, query: {}, arguments: { ...request.params } };
  const pathParams: Record<string, string> = {};
  const query: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(request.params)) {
    if (request.pathParams.includes(name))
      pathParams[name] = typeof value === "string" ? value : JSON.stringify(value);
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      query[name] = value;
  }
  return { pathParams, query, arguments: undefined };
}

/** A listing's URL with its path parameters filled in, as the buyer would call it. */
function expandedUrl(
  resource: string,
  pathParams: Readonly<Record<string, string>>,
  query: Readonly<Record<string, string | number | boolean>>,
): string {
  const url = snippetUrl(resource);
  if (url === undefined) return URL_PLACEHOLDER;
  const target = new URL(url);
  target.pathname = target.pathname
    .split("/")
    .map((segment) => {
      const name = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(segment)?.[1];
      return name === undefined ? segment : encodeURIComponent(pathParams[name] ?? `:${name}`);
    })
    .join("/");
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, String(value));
  return target.href;
}

/**
 * The code tabs of the Pay page: the same request from the SDK, the CLI, an agent's tool call and as
 * raw HTTP. A plain GET of a URL fills the snippet sources as they are; a method and body, or a
 * listing and its parameters, are written into the same snippets. A tab that cannot express the
 * request (raw HTTP for an MCP tool) is left out.
 */
export function payTabs(
  values: SnippetValues & { readonly url: string; readonly request?: PaySnippetRequest },
): readonly CodeTab[] {
  const request = values.request;
  const sdk = fillSnippet(payUrlSdk, values);
  const cli = fillSnippet(payUrlCli, values);
  const mcp = fillSnippet(payUrlMcp, values);
  const http = fillSnippet(payUrlHttp, values);
  const cap = { amount: values.cap, asset: values.config.asset.symbol };
  const url = snippetUrl(values.url) ?? URL_PLACEHOLDER;
  const plain =
    request === undefined ||
    (request.kind === "url" && request.method === "GET" && request.body === undefined);
  if (plain) {
    return [
      { id: "sdk", label: "SDK", source: sdk },
      { id: "cli", label: "CLI", source: cli },
      { id: "mcp", label: "MCP", source: mcp },
      { id: "http", label: "HTTP", source: http },
    ];
  }
  const sdkCall = /buyer\.pay\(\n {2}\{ kind: "http", url: "(?:[^"\\\n]|\\.)*" \},/;
  const cliLine = /^rail402 pay .*$/m;
  const mcpCall = /pay_and_call\(\{[\s\S]*?\}\);/;
  const mcpInput = (input: Record<string, JsonValue>): string =>
    `pay_and_call({\n${Object.entries({ ...input, spendingCap: cap })
      .map(([key, value]) => `  ${key}: ${literal(value)},`)
      .join("\n")}\n});`;

  if (request.kind === "url") {
    const target: Record<string, JsonValue> = { kind: "http", url, method: request.method };
    if (request.body !== undefined) target["body"] = request.body;
    const data = request.body === undefined ? "" : ` --data ${shellWord(JSON.stringify(request.body))}`;
    const bodyLines =
      request.body === undefined ? "" : `content-type: application/json\n\n${JSON.stringify(request.body)}\n`;
    return [
      { id: "sdk", label: "SDK", source: sdk.replace(sdkCall, `buyer.pay(\n  ${literal(target)},`) },
      {
        id: "cli",
        label: "CLI",
        source: cli.replace(
          cliLine,
          `rail402 pay ${shellWord(url)} --method ${request.method}${data} --max ${values.cap}`,
        ),
      },
      {
        id: "mcp",
        label: "MCP",
        source: mcp.replace(
          mcpCall,
          mcpInput({
            resource: url,
            method: request.method,
            ...(request.body === undefined ? {} : { body: request.body }),
          }),
        ),
      },
      {
        id: "http",
        label: "HTTP",
        source: [
          "# 1. ask, unpaid",
          `${request.method} ${url}`,
          `${bodyLines}# ← 402 Payment Required, PAYMENT-REQUIRED: the price, payTo, network and expiry`,
          "",
          "# 2. sign one authorization within your cap, then ask again with it",
          `${request.method} ${url}`,
          "PAYMENT-SIGNATURE: <the signed payment>",
          `${bodyLines}# ← 200 OK, PAYMENT-RESPONSE: the settlement transaction hash`,
          "",
        ].join("\n"),
      },
    ];
  }

  const call = listingCall(request);
  const callInput: Record<string, JsonValue> =
    call.arguments !== undefined
      ? { arguments: call.arguments }
      : {
          ...(Object.keys(call.pathParams).length === 0 ? {} : { pathParams: call.pathParams }),
          ...(Object.keys(call.query).length === 0 ? {} : { query: call.query }),
        };
  const concrete = request.type === "mcp" ? url : expandedUrl(values.url, call.pathParams, call.query);
  const cliCommand =
    request.type === "mcp"
      ? `rail402 pay ${shellWord(url)} --tool ${shellWord(request.toolName ?? "tool")} --args ${shellWord(JSON.stringify(call.arguments ?? {}))} --max ${values.cap}`
      : `rail402 pay ${shellWord(concrete)} --max ${values.cap}`;
  const tabs: CodeTab[] = [
    {
      id: "sdk",
      label: "SDK",
      source: sdk.replace(
        sdkCall,
        `buyer.payListing(\n  ${literal(request.listingId)},\n  ${literal(callInput)},`,
      ),
    },
    { id: "cli", label: "CLI", source: cli.replace(cliLine, cliCommand) },
    {
      id: "mcp",
      label: "MCP",
      source: mcp.replace(mcpCall, mcpInput({ listingId: request.listingId, ...callInput })),
    },
  ];
  if (request.type === "http") {
    tabs.push({
      id: "http",
      label: "HTTP",
      source: fillSnippet(payUrlHttp, { ...values, url: concrete }),
    });
  }
  return tabs;
}
