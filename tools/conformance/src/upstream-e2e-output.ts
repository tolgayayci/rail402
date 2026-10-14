/** Reading what the upstream e2e suite and the local facilitator printed, and where its checkout came from. */

/**
 * Why the suite's Bazaar discovery validation does not apply to a hosted service. The suite builds the
 * resource URL it expects for every HTTP route as `http://localhost:<port><path>` (e2e/extensions/bazaar.ts)
 * and its sellers listen there; a hosted catalog refuses loopback origins by design, so those listings
 * can never exist on it. The local run, whose catalog allows loopback for the suite, validates it.
 */
export const HOSTED_BAZAAR_NOT_APPLICABLE =
  "not applicable to a hosted service: the suite expects its HTTP listings at http://localhost:<port> URLs it builds itself, and a hosted catalog refuses loopback origins by design (bazaar_resource_unsafe); the local run validates the suite's Bazaar";

/** The resources the suite's discovery validation listed as missing (the bullets after "Missing:"). */
export function missingResources(output: string): string[] {
  const start = output.search(/Missing: \d+/);
  if (start === -1) return [];
  const missing: string[] = [];
  for (const line of output.slice(start).split("\n").slice(1)) {
    const match = /^\s*• (.+)$/.exec(line);
    if (match === null) break;
    missing.push((match[1] ?? "").trim());
  }
  return missing;
}

/**
 * The catalog's outcome counters the local facilitator kept when the suite stopped it (Prometheus text
 * lines of `rail402_catalog_outcomes_total`), keyed by their label values joined with `/`.
 */
export function catalogOutcomes(text: string): Record<string, number> {
  const outcomes: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^rail402_catalog_outcomes_total\{(.*)\} (\d+)/.exec(line);
    if (match === null) continue;
    const labels = [...(match[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((label) => label[2]).join("/");
    outcomes[labels] = Number(match[2]);
  }
  return outcomes;
}

/**
 * The release tag to cite for a checkout at `version` of `@x402/stellar`, from the tags pointing at its
 * commit: upstream tags every package at a release, so the Stellar package's own tag is preferred, then
 * any other package tag of that version, then the first tag.
 */
export function releaseTagFor(tags: readonly string[], version: string): string | undefined {
  const own = `npm-@x402/stellar@v${version}`;
  if (tags.includes(own)) return own;
  return tags.find((tag) => tag.endsWith(`@v${version}`)) ?? tags[0];
}

/** `owner/name` of a GitHub remote URL (https or ssh), if it is one. */
export function githubRepository(url: string): string | undefined {
  return /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}
