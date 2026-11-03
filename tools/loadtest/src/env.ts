/** A connection string without its user name and password, for a recorded configuration. */
export function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "<not a URL>";
  }
}

/** The arguments of a run as recorded: database URLs without credentials, paths relative to `root`. */
export function recordedArgs(args: Readonly<Record<string, unknown>>, root: string): Record<string, unknown> {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      if (key === "seed" || key === "store") return [key, withoutCredentials(value)];
      return [key, value.startsWith(prefix) ? value.slice(prefix.length) : value];
    }),
  );
}

/** The settings of an env file that shape load, never a secret or a URL with credentials. */
export function publicEnv(text: string): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const [, key = "", value = ""] = match;
    if (/SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL/.test(key)) continue;
    if (
      /^(SEARCH_|BAZAAR_|RATE_LIMIT|NETWORKS$|STORE$|BODY_LIMIT|TESTNET_BAZAAR_|PUBNET_BAZAAR_)/.test(key)
    ) {
      kept[key] = value;
    }
  }
  return kept;
}
