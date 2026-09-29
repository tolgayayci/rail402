import {
  baseAccount,
  matchesFilter,
  type ListFilter,
  type Listing,
  type PaymentOption,
} from "@rail402.dev/bazaar";

/** A token the catalog can price: its symbol, decimals, and whether it is pegged to the US dollar. */
export interface KnownAsset {
  readonly network: string;
  readonly contract: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly usd: boolean;
}

/** Price ceiling: in US dollars (any USD-pegged asset) or in units of one named asset. */
export interface PriceCeiling {
  readonly value: string;
  readonly unit: "usd" | "asset";
  /**
   * The asset symbol a ceiling in asset units was written in ("under 2 XLM"). Only options in that
   * asset satisfy it; without it, the ceiling applies in the units of whatever asset each option uses.
   */
  readonly symbol?: string;
}

export interface SearchFilter extends Omit<ListFilter, "limit" | "offset"> {
  /** Asset contract (C…) or symbol (USDC). */
  readonly asset?: string;
  readonly maxPrice?: PriceCeiling;
}

export class AssetRegistry {
  private readonly byContract = new Map<string, KnownAsset>();

  constructor(assets: readonly KnownAsset[]) {
    for (const asset of assets) this.byContract.set(`${asset.network}|${asset.contract}`, asset);
  }

  lookup(network: string, contract: string): KnownAsset | undefined {
    return this.byContract.get(`${network}|${contract}`);
  }

  symbols(): Set<string> {
    return new Set([...this.byContract.values()].map((asset) => asset.symbol.toUpperCase()));
  }
}

/**
 * Whether a listing satisfies every hard constraint. The discovery filters and the asset and price
 * constraints must all hold for one and the same payment option; unknown assets never satisfy a
 * price or symbol constraint (fail closed).
 */
export function satisfies(listing: Listing, filter: SearchFilter, assets: AssetRegistry): boolean {
  if (!matchesFilter(listing, { ...filter, payTo: undefined, scheme: undefined, network: undefined }))
    return false;
  return listing.content.accepts.some((option) => optionSatisfies(option, filter, assets));
}

export function optionSatisfies(option: PaymentOption, filter: SearchFilter, assets: AssetRegistry): boolean {
  if (filter.scheme !== undefined && option.scheme !== filter.scheme) return false;
  if (filter.network !== undefined && option.network !== filter.network) return false;
  if (
    filter.payTo !== undefined &&
    option.payTo !== filter.payTo &&
    baseAccount(option.payTo) !== filter.payTo
  ) {
    return false;
  }
  const known = assets.lookup(option.network, option.asset);
  if (filter.asset !== undefined) {
    const wanted = filter.asset.toUpperCase();
    const matches =
      option.asset === filter.asset || (known !== undefined && known.symbol.toUpperCase() === wanted);
    if (!matches) return false;
  }
  if (filter.maxPrice !== undefined) {
    if (known === undefined) return false;
    if (filter.maxPrice.unit === "usd" && !known.usd) return false;
    const symbol = filter.maxPrice.symbol;
    if (symbol !== undefined && known.symbol.toUpperCase() !== symbol.toUpperCase()) return false;
    const ceiling = toBaseUnits(filter.maxPrice.value, known.decimals);
    if (ceiling === undefined || !/^\d+$/.test(option.amount) || BigInt(option.amount) > ceiling)
      return false;
  }
  return true;
}

/** Exact conversion of a decimal string to base units; fractions below one unit round down. */
export function toBaseUnits(value: string, decimals: number): bigint | undefined {
  const match = /^(\d{1,30})(?:\.(\d{1,38}))?$/.exec(value);
  if (match === null) return undefined;
  const [, whole = "0", fraction = ""] = match;
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
}

/** A constraint recognised in the query text, and the filter field it sets. */
export interface Recognised {
  readonly field: "network" | "type" | "maxPrice" | "asset";
  readonly label: string;
}

export interface ParsedQuery {
  /** The query with recognised constraint phrases removed; what is ranked. */
  readonly text: string;
  readonly filter: SearchFilter;
  /** Constraints taken from the query, echoed to the caller when they are applied. */
  readonly recognised: readonly Recognised[];
}

/** Letters or digits must not continue a match: `\b` fails after "¢" and before "$". */
const END = String.raw`(?![\p{L}\p{N}])`;
const START = String.raw`(?<![\p{L}\p{N}])`;

// Constraints need an explicit trigger: "on testnet", "mainnet only", "mcp tools", "paid in USDC",
// "under $0.01", or a clause of its own ("…, testnet"). A bare mention inside a sentence ("mainnet
// readiness", "convert openapi to an mcp server", "USDC price oracle") stays in the ranked text,
// because a wrong hard filter silently hides every right answer.
const TESTNET = String.raw`(?:testnet|test\s+net(?:work)?)`;
const PUBNET = String.raw`(?:mainnet|main\s+net(?:work)?|pubnet|public\s+network|real\s+network|production\s+network)`;
const STELLAR = String.raw`(?:(?:the|el|dem)\s+)?(?:stellar\s+)?`;
const ON = String.raw`(?:only\s+)?(?:on|over|via|in|using|solo\s+en|en|nur\s+im|im|auf)\s+`;
/** Words that negate the constraint after them: "not on testnet", "excluding mainnet". */
const NEGATION = String.raw`(?:not|never|excluding|except|without)`;
/** A phrase must not follow a negation to count as a positive constraint. */
const UNNEGATED = String.raw`(?<!${NEGATION}\s+)`;
const networkPatterns = (word: string, other: string) => [
  new RegExp(`${START}${UNNEGATED}${ON}${STELLAR}${word}(?:\\s+only)?${END}`, "giu"),
  new RegExp(`${START}${UNNEGATED}${STELLAR}${word}\\s+only${END}`, "giu"),
  // Stellar has two networks: "not on mainnet" means testnet.
  new RegExp(`${START}${NEGATION}\\s+(?:on\\s+)?${STELLAR}${other}${END}`, "giu"),
];
/** Both networks named together ("testnet vs mainnet"): a comparison, not a constraint. */
const BOTH_NETWORKS = new RegExp(
  `${START}(?:${TESTNET}\\s+(?:vs\\.?|versus|and|or|to|&)\\s+(?:on\\s+)?${STELLAR}${PUBNET}|${PUBNET}\\s+(?:vs\\.?|versus|and|or|to|&)\\s+(?:on\\s+)?${STELLAR}${TESTNET})${END}`,
  "iu",
);
const NETWORK_PATTERNS: readonly [RegExp, string][] = [
  ...networkPatterns(TESTNET, PUBNET).map((pattern): [RegExp, string] => [pattern, "stellar:testnet"]),
  ...networkPatterns(PUBNET, TESTNET).map((pattern): [RegExp, string] => [pattern, "stellar:pubnet"]),
];
const NETWORK_CLAUSES: readonly [RegExp, string][] = [
  [TESTNET, PUBNET, "stellar:testnet"] as const,
  [PUBNET, TESTNET, "stellar:pubnet"] as const,
].map(([word, other, network]) => [
  new RegExp(
    `^(?:only\\s+|just\\s+)?(?:on\\s+)?${STELLAR}${word}(?:\\s+only)?(?:\\s+not\\s+(?:on\\s+)?${STELLAR}${other})?$`,
    "iu",
  ),
  network,
]);
const TYPE_PATTERNS: readonly [RegExp, string][] = [
  [new RegExp(`${START}(?:as\\s+an?\\s+)?mcp\\s+tools?${END}`, "giu"), "mcp"],
  [new RegExp(`${START}as\\s+an?\\s+mcp(?:\\s+server)?${END}`, "giu"), "mcp"],
  [new RegExp(`${START}(?:http|rest)\\s+(?:apis?|endpoints?)(?:\\s+only)?${END}`, "giu"), "http"],
  [new RegExp(`${START}(?:over|via)\\s+(?:plain\\s+)?(?:http|https|rest)${END}`, "giu"), "http"],
];
const TYPE_CLAUSES: readonly [RegExp, string][] = [
  [/^(?:as\s+an?\s+)?mcp(?:\s+(?:tool|server))?(?:\s+only)?$/iu, "mcp"],
  [/^(?:(?:plain|over|via)\s+)?(?:http|rest)(?:\s+api)?(?:\s+only)?$/iu, "http"],
];
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`;
const CEILING = String.raw`(?:under|below|less\s+than|cheaper\s+than|at\s+most|no\s+more\s+than|max(?:imum)?|up\s+to)`;
const UNIT = String.raw`(cents?|¢|usd|dollars?|\p{L}{2,12})`;
const PRICE = new RegExp(`${START}${CEILING}\\s*(\\$\\s*)?${NUMBER}\\s*${UNIT}?${END}`, "giu");
/** "$0.002 or less", "2 XLM or below". */
const NEGATED_PRICE = new RegExp(
  `${START}${NEGATION}\\s+${CEILING}\\s*(\\$\\s*)?${NUMBER}\\s*${UNIT}?${END}`,
  "giu",
);
const TRAILING_PRICE = new RegExp(
  `${START}(\\$\\s*)?${NUMBER}\\s*${UNIT}?\\s+or\\s+(?:less|below|under|cheaper)${END}`,
  "giu",
);
/** "under a tenth of a cent", "at most half a dollar". */
const WORD_PRICE = new RegExp(
  `${START}${CEILING}\\s+(a\\s+tenth\\s+of\\s+a|a\\s+quarter\\s+of\\s+a|half\\s+a|a|one)\\s+(cent|penny|dollar)${END}`,
  "giu",
);
const WORD_AMOUNTS: Readonly<Record<string, string>> = {
  a: "1",
  one: "1",
  "half a": "0.5",
  "a quarter of a": "0.25",
  "a tenth of a": "0.1",
};
const ASSET_TRIGGER = String.raw`(?:(?:paid|priced|payable|pay(?:ing)?|settled?)\s+(?:in|with)|accept(?:s|ing)?|takes?|taking)`;
/** Ceilings that also read as a transfer limit ("send up to 100 USDC", "max 500 USDC per transfer"). */
const AMOUNT_CEILING = /^(?:up\s+to|max(?:imum)?|at\s+most)\b/iu;
const TRANSFER_VERB =
  /(?:^|\s)(?:send|sends|sending|transfer|transfers|transferring|remit|remits|withdraw|withdraws|deposit|deposits|pay\s+out|payouts?|bridge|bridges|move|moves|lend|borrow)(?:\s+\S+){0,2}\s*$/iu;
const TRANSFER_TAIL = /^\s+(?:to\s|per\s+(?:transfer|transaction|tx|payment|withdrawal|deposit|day|month))/iu;
/** "accepts XLM payments" describes what a service does, not what it is paid in. */
const CAPABILITY_TAIL = String.raw`(?!\s+(?:payments?|deposits?|transfers?|donations?|tips?|invoices?)${END})`;

/**
 * Deterministic extraction of hard constraints from natural language: network ("on testnet",
 * "mainnet only"), resource type ("mcp tools", "over http"), asset ("paid in USDC", "takes XLM")
 * and price ceilings ("under 1¢", "below $0.05", "$0.002 or less", "at most 2 XLM", "under a tenth
 * of a cent"). A comma-separated clause that is nothing but a constraint ("…, testnet", "…, usdc")
 * counts too. Anything not recognised stays in the ranked text. Explicit request parameters take
 * precedence.
 */
export function parseQuery(query: string, symbols: ReadonlySet<string>): ParsedQuery {
  const filter: { -readonly [K in keyof SearchFilter]: SearchFilter[K] } = {};
  const recognised: Recognised[] = [];
  const setNetwork = (network: string) => {
    filter.network = network;
    recognised.push({ field: "network", label: `network=${network}` });
  };
  const setType = (type: string) => {
    filter.type = type;
    recognised.push({ field: "type", label: `type=${type}` });
  };
  const setAsset = (symbol: string) => {
    filter.asset = symbol;
    recognised.push({ field: "asset", label: `asset=${symbol}` });
  };

  // Clauses that consist of a constraint alone.
  // A comma followed by a digit is a thousands separator ("1,000 usdc"), not a clause break.
  const clauses = query.split(/\s*(?:,(?!\d)|[;|]|\s[-–—]\s)\s*/u);
  const kept = clauses.filter((clause) => {
    const bare = clause.trim().replace(/[.!?]+$/u, "");
    if (filter.network === undefined) {
      const hit = NETWORK_CLAUSES.find(([pattern]) => pattern.test(bare));
      if (hit !== undefined) {
        setNetwork(hit[1]);
        return false;
      }
    }
    if (filter.type === undefined) {
      const hit = TYPE_CLAUSES.find(([pattern]) => pattern.test(bare));
      if (hit !== undefined) {
        setType(hit[1]);
        return false;
      }
    }
    const symbol = /^(?:only\s+)?(?:(?:paid|pay)\s+in\s+|in\s+)?(\p{L}{2,12})(?:\s+only)?$/iu.exec(bare)?.[1];
    if (filter.asset === undefined && symbol !== undefined && symbols.has(symbol.toUpperCase())) {
      setAsset(symbol.toUpperCase());
      return false;
    }
    return true;
  });
  let text = ` ${kept.join(", ")} `;
  // `search` ignores and preserves lastIndex, unlike `test` on these shared global patterns.
  const found = (pattern: RegExp) => text.search(pattern) !== -1;

  if (!BOTH_NETWORKS.test(text)) {
    const hits = NETWORK_PATTERNS.filter(([pattern]) => found(pattern));
    const networks = new Set(hits.map(([, network]) => network));
    // Phrases naming both networks cancel out: a wrong network filter hides every right answer.
    if (filter.network !== undefined || networks.size === 1) {
      for (const [pattern, network] of hits) {
        if (filter.network !== undefined && filter.network !== network) continue;
        if (filter.network === undefined) setNetwork(network);
        text = text.replace(pattern, " ");
      }
    }
  }
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (filter.type !== undefined && filter.type !== type) continue;
    if (!found(pattern)) continue;
    if (filter.type === undefined) setType(type);
    text = text.replace(pattern, " ");
  }

  // A negated price or asset ("not under $1", "not paid in USDC") cannot be a filter; it is not ranked either.
  text = text.replace(NEGATED_PRICE, (_match: string, _dollar: string, _number: string, unit?: string) => {
    const lower = unit?.toLowerCase() ?? "";
    const currency = /^(?:cents?|¢|usd|dollars?)$/u.test(lower) || symbols.has(lower.toUpperCase());
    // "not under $5 weather": the unit group took an ordinary word; it stays in the ranked text.
    return unit === undefined || currency ? " " : ` ${unit} `;
  });
  for (const symbol of symbols) {
    text = text.replace(
      new RegExp(`${START}${NEGATION}\\s+(?:${ASSET_TRIGGER}\\s+|in\\s+)?${escape(symbol)}${END}`, "giu"),
      " ",
    );
  }

  const price = (
    match: string,
    dollar: string | undefined,
    number: string,
    unit: string | undefined,
    offset: number,
    whole: string,
  ) => {
    if (filter.maxPrice !== undefined) return match;
    if (
      AMOUNT_CEILING.test(match.trim()) &&
      (TRANSFER_VERB.test(whole.slice(0, offset)) || TRANSFER_TAIL.test(whole.slice(offset + match.length)))
    ) {
      // A transfer limit, not the price of the call.
      return match;
    }
    const amount = number.replace(/,/g, "").replace(/^\./, "0.");
    const lower = unit?.toLowerCase();
    const cents = lower === "cent" || lower === "cents" || lower === "¢";
    const dollarWord = lower === "usd" || lower === "dollar" || lower === "dollars";
    const symbol = unit !== undefined && symbols.has(unit.toUpperCase()) ? unit.toUpperCase() : undefined;
    let giveBack = "";
    if (cents && dollar === undefined) {
      filter.maxPrice = { value: divideBy100(amount), unit: "usd" };
      recognised.push({ field: "maxPrice", label: `maxPrice=${filter.maxPrice.value} USD` });
    } else if (symbol !== undefined && dollar === undefined) {
      filter.maxPrice = { value: amount, unit: "asset", symbol };
      recognised.push({ field: "maxPrice", label: `maxPrice=${amount} ${symbol}` });
      if (filter.asset === undefined) setAsset(symbol);
    } else if (dollar !== undefined || dollarWord) {
      filter.maxPrice = { value: amount, unit: "usd" };
      recognised.push({ field: "maxPrice", label: `maxPrice=${amount} USD` });
      // "under $5 weather": the unit group took an ordinary word; it stays in the ranked text.
      if (unit !== undefined && !dollarWord) giveBack = unit;
    } else {
      // No currency marker: "up to 100 requests per second" is not a price.
      return match;
    }
    return ` ${giveBack} `;
  };
  text = text.replace(
    WORD_PRICE,
    (match: string, words: string, unit: string, offset: number, whole: string) => {
      const amount = WORD_AMOUNTS[words.toLowerCase().replace(/\s+/g, " ")] ?? "1";
      return price(
        match,
        undefined,
        amount,
        unit.toLowerCase() === "dollar" ? "dollars" : "cents",
        offset,
        whole,
      );
    },
  );
  text = text.replace(PRICE, price);
  text = text.replace(TRAILING_PRICE, price);

  // A bare "in" counts only when no currency precedes it: "price of XLM in USDC" is a conversion.
  const currencies = [...symbols].map(escape).join("|");
  const bareIn = String.raw`(?<!(?:${currencies === "" ? "usd" : `${currencies}|usd`}|eur|xlm|btc|eth|dollars?|euros?|lumens?|price|prices|rate|rates|value|worth|convert(?:ed)?|swap(?:ped)?)\s+)in`;
  for (const symbol of symbols) {
    const pattern = new RegExp(
      `${START}${UNNEGATED}(?:${ASSET_TRIGGER}|${bareIn})\\s+${escape(symbol)}${END}${CAPABILITY_TAIL}`,
      "giu",
    );
    if (!found(pattern)) continue;
    if (filter.asset === undefined) setAsset(symbol);
    if (filter.asset === symbol) text = text.replace(pattern, " ");
  }
  return {
    text: text
      .replace(/\s+/g, " ")
      .replace(/(?:\s*,\s*)+$/u, "")
      .replace(/^(?:\s*,\s*)+/u, "")
      .replace(/\s+,/g, ",")
      .trim(),
    filter,
    recognised,
  };
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function divideBy100(amount: string): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  const cents = whole.padStart(3, "0");
  const dollars = cents.slice(0, -2).replace(/^0+(?=\d)/, "");
  return `${dollars}.${cents.slice(-2)}${fraction}`;
}
