/**
 * Pure license-classification logic, extracted so it can be unit-tested without
 * installing anything. This is security-relevant code: it is the only thing standing
 * between the repo and an AGPL dependency, which the licence policy forbids.
 * Treat changes here the way you would treat changes to payment validation.
 */

/** Verdict ranking, worst first — drives exit status and report ordering. */
export const VERDICT = { BLOCKED: 0, UNKNOWN: 1, REVIEW: 2, ACKNOWLEDGED: 3, ALLOWED: 4 };

/**
 * Split an SPDX expression into its atomic license ids.
 *
 * We deliberately do NOT implement full SPDX boolean logic. `(MIT OR GPL-3.0)` is genuinely a
 * choice the project must make and record, so any compound expression lands in REVIEW and a human
 * decides — exactly what the policy asks for ("dual licenses ... flag for human review").
 *
 * @param {string} expression
 * @returns {string[]}
 */
export function atomsOf(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} expression
 * @returns {boolean}
 */
export function isCompound(expression) {
  return /\s(?:OR|AND|WITH)\s/i.test(expression) || expression.includes("(");
}

/**
 * Classify a single SPDX atom.
 *
 * Ordering is load-bearing: the explicit `review` list is consulted before `blockPrefixes`, so
 * `LGPL-3.0-only` (weak copyleft, review) is not swallowed by the `GPL-` prefix (fatal).
 * There is a unit test pinning exactly that.
 *
 * @param {string} atom
 * @param {{allow:string[],review:string[],block:string[],reviewPrefixes:string[],blockPrefixes:string[]}} policy
 * @returns {"BLOCKED"|"REVIEW"|"ALLOWED"|"UNKNOWN"}
 */
export function classifyAtom(atom, policy) {
  if (policy.block.includes(atom)) return "BLOCKED";
  if (policy.review.includes(atom)) return "REVIEW";
  if (policy.allow.includes(atom)) return "ALLOWED";
  if (policy.reviewPrefixes.some(p => atom.startsWith(p))) return "REVIEW";
  if (policy.blockPrefixes.some(p => atom.startsWith(p))) return "BLOCKED";
  return "UNKNOWN";
}

/**
 * Classify a package, honouring human acknowledgements for review-class licenses only.
 *
 * @param {{name:string,version:string,license:string}} pkg
 * @param {object} policy
 * @returns {{verdict:keyof typeof VERDICT, detail:string}}
 */
export function classify(pkg, policy) {
  const expression = pkg.license;
  if (!expression || /^(UNKNOWN|UNLICENSED)$/i.test(expression)) {
    return { verdict: "BLOCKED", detail: "no license declared" };
  }

  const results = atomsOf(expression).map(a => classifyAtom(a, policy));

  // Worst atom wins. A blocked atom is fatal even inside a dual license: we will not silently
  // rely on the permissive half of `(MIT OR AGPL-3.0)` without a human saying so explicitly.
  let verdict;
  if (results.includes("BLOCKED")) verdict = "BLOCKED";
  else if (results.includes("UNKNOWN")) verdict = "UNKNOWN";
  else if (results.includes("REVIEW") || isCompound(expression)) verdict = "REVIEW";
  else verdict = "ALLOWED";

  const ack =
    policy.acknowledged?.[`${pkg.name}@${pkg.version}`] ?? policy.acknowledged?.[pkg.name];

  // A blocked license can NEVER be acknowledged away (the block list is absolute).
  if (verdict === "BLOCKED") {
    return {
      verdict: "BLOCKED",
      detail: ack
        ? "acknowledgement IGNORED — blocked licenses can never be acknowledged"
        : results.includes("BLOCKED") && isCompound(expression)
          ? "compound expression contains a blocked license"
          : "",
    };
  }

  if (verdict === "REVIEW" && ack) {
    return { verdict: "ACKNOWLEDGED", detail: typeof ack === "string" ? ack : (ack.reason ?? "") };
  }

  const detail =
    verdict === "REVIEW" && isCompound(expression) && !results.includes("REVIEW")
      ? "compound SPDX expression — pick one and acknowledge it"
      : "";

  return { verdict, detail };
}
