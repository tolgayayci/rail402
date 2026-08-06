/**
 * The MCP seller's resource block, checked at boot.
 *
 * ## The trap this exists to close
 *
 * `@x402/mcp`'s `createToolResourceUrl` defaults a paid tool's resource URL to `mcp://tool/<name>`,
 * and `createPaymentWrapper` accepts that happily. It is a reasonable-looking identifier and it is
 * unusable as a catalog key, for a reason nothing in the seller's editor will tell them: `mcp:` is
 * not a WHATWG "special" scheme, so
 *
 * ```js
 * new URL("mcp://tool/get_weather").origin   // => "null"   (the STRING "null")
 * new URL("mcp://alice.example/tool/x").origin // => "null" — the host is dropped entirely
 * ```
 *
 * The Bazaar spec keys a resource on origin + path, so every seller in the world offering a
 * `get_weather` tool would canonicalise to the same key `null/get_weather`. First writer wins it
 * permanently. Our facilitator refuses to catalog it for exactly that reason — but a seller only
 * finds that out from an `EXTENSION-RESPONSES` header on a payment that has already happened.
 *
 * So the check moves to boot: call this when you configure the tool, and a misconfigured seller
 * learns in their own logs, before a buyer is involved and before anyone has spent anything. Same
 * discipline as `preflight` and the trustline check — a startup failure instead of a runtime one.
 *
 * ## What to use instead
 *
 * The http(s) URL of the MCP **endpoint** — the address an agent connects to. The tool name is not
 * part of the URL; it is the second half of the identity, carried in `input.toolName`, because one
 * MCP endpoint multiplexes many tools and the spec keys them on the pair.
 */

export interface McpToolResourceConfig {
  /** The http(s) URL of the MCP endpoint an agent connects to, e.g. `https://api.example.com/mcp`. */
  url: string;
  /** The tool this resource block describes. Used only to make the error message specific. */
  toolName: string;
  /** What the tool does. The primary thing Bazaar search ranks an MCP resource on. */
  description: string;
  mimeType?: string;
  /** Human-readable name of the service hosting the tool. */
  serviceName?: string;
  /** Short topical tags for discovery search. */
  tags?: string[];
  /** Absolute http(s) URL to a service icon. */
  iconUrl?: string;
}

export interface McpToolResource {
  url: string;
  description: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/**
 * Build the `resource` block for a paid MCP tool, refusing an address the catalog cannot key on.
 *
 * Drop the result into `createPaymentWrapper`'s `resource` field. Throws rather than warning: a
 * warning at boot is a warning nobody reads, and the failure it prevents is silent — the tool works,
 * payments settle, and the listing simply never appears.
 *
 * @throws Error when `url` is not an absolute http(s) URL
 */
export function mcpToolResource(config: McpToolResourceConfig): McpToolResource {
  const { url, toolName } = config;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `MCP tool "${toolName}" declares resource.url ${JSON.stringify(url)}, which is not an absolute URL. ` +
        `Use the http(s) URL of the MCP endpoint an agent connects to, e.g. "https://api.example.com/mcp".`,
    );
  }

  if (parsed.protocol === "mcp:") {
    throw new Error(
      `MCP tool "${toolName}" declares resource.url ${JSON.stringify(url)}. This is the @x402/mcp ` +
        `default, and it cannot be catalogued: "mcp:" is not a WHATWG special scheme, so its origin ` +
        `parses as the string "null" and the Bazaar's origin+path key would collapse to ` +
        `${JSON.stringify(`${parsed.origin}${parsed.pathname}`)} — a key shared with every other seller ` +
        `offering a tool of this name. The host is dropped too, so it cannot be salvaged by putting ` +
        `your domain in it.\n` +
        `Use the http(s) URL of your MCP ENDPOINT instead — e.g. "https://api.example.com/mcp" — and ` +
        `leave the tool name in the discovery extension's input.toolName. MCP resources are keyed on ` +
        `the pair (endpoint URL, toolName), which is what lets one endpoint publish many tools.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP tool "${toolName}" declares resource.url ${JSON.stringify(url)}, whose scheme ` +
        `"${parsed.protocol}" is not http(s). The Bazaar keys a resource on its origin and path, and ` +
        `an agent has to be able to connect to it.`,
    );
  }

  if (!config.description?.trim()) {
    throw new Error(
      `MCP tool "${toolName}" has no resource description. For an MCP resource this is the primary ` +
        `text search ranks on — without it the tool is effectively undiscoverable.`,
    );
  }

  return {
    url,
    description: config.description,
    ...(config.mimeType === undefined ? {} : { mimeType: config.mimeType }),
    ...(config.serviceName === undefined ? {} : { serviceName: config.serviceName }),
    ...(config.tags === undefined ? {} : { tags: config.tags }),
    ...(config.iconUrl === undefined ? {} : { iconUrl: config.iconUrl }),
  };
}
