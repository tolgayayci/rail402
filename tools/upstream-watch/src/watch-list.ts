/**
 * The watch list: every upstream file, package and URL Rail402 is pinned to, and the Rail402
 * components each one affects. `tools/upstream-watch/watch.json` is the only copy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const WATCH_FILE = fileURLToPath(new URL("../watch.json", import.meta.url));

const sha = z.string().regex(/^[0-9a-f]{40}$/, "a full 40-character hex SHA");
const version = z.string().regex(/^\d+\.\d+\.\d+$/, "an exact x.y.z version");
const repoPath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "a relative path inside the repository",
  );
const componentId = z.string().regex(/^[a-z][a-z0-9-]*$/);
const affects = z.array(componentId).min(1);

const watchedFile = z.strictObject({
  path: repoPath,
  /** The last upstream commit that touched the file when it was pinned. */
  pinnedCommit: sha,
  /** The file's git blob SHA at `pinnedCommit`; a different blob on the branch is drift. */
  pinnedBlob: sha,
  affects,
  note: z.string().min(1),
});

const pendingFile = z.strictObject({
  path: repoPath,
  affects,
  note: z.string().min(1),
});

const sourcePath = z.strictObject({
  path: repoPath,
  affects,
  note: z.string().min(1),
});

const watchedPackage = z.strictObject({
  name: z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/),
  pinned: version,
  /** `latest`: the npm latest tag. `same-major`: the newest stable release with the pinned major. */
  follow: z.enum(["latest", "same-major"]),
  /** The upstream git tag of a release, `{version}` replaced; links the issue to the release commit. */
  releaseTag: z.string().includes("{version}").optional(),
  affects,
  note: z.string().min(1).optional(),
});

export const URL_NORMALIZERS = ["text", "json-sorted", "x402-supported-stellar"] as const;

const watchedUrl = z.strictObject({
  url: z
    .url({ protocol: /^https$/ })
    .refine((url) => new URL(url).username === "" && new URL(url).password === "", "no credentials"),
  normalize: z.enum(URL_NORMALIZERS),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  affects,
  note: z.string().min(1),
});

const component = z.strictObject({
  title: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  tests: z.array(z.string().min(1)).min(1),
  docs: z.array(z.string().min(1)).min(1),
});

export const watchListSchema = z
  .strictObject({
    $comment: z.string().optional(),
    schemaVersion: z.literal(1),
    upstream: z.strictObject({
      repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
      branch: z.string().regex(/^[A-Za-z0-9._/-]+$/),
      baselineRef: z.string().min(1),
      baselineCommit: sha,
    }),
    files: z.array(watchedFile).min(1),
    pending: z.array(pendingFile),
    paths: z.array(sourcePath),
    packages: z.array(watchedPackage).min(1),
    urls: z.array(watchedUrl),
    components: z.record(componentId, component),
  })
  .superRefine((list, context) => {
    const issue = (message: string) => {
      context.addIssue({ code: "custom", message });
    };
    const seen = new Set<string>();
    for (const entry of [...list.files, ...list.pending, ...list.paths, ...list.packages, ...list.urls]) {
      const id = "url" in entry ? entry.url : "name" in entry ? entry.name : entry.path;
      if (seen.has(id)) issue(`${id} is listed twice`);
      seen.add(id);
      for (const ref of entry.affects) {
        if (!(ref in list.components)) issue(`${id} affects an unknown component "${ref}"`);
      }
    }
  });

export type WatchList = z.infer<typeof watchListSchema>;
export type WatchedFile = WatchList["files"][number];
export type WatchedPackage = WatchList["packages"][number];
export type WatchedUrl = WatchList["urls"][number];
export type Component = WatchList["components"][string];

export function parseWatchList(value: unknown): WatchList {
  const parsed = watchListSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(`invalid watch list:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

export function loadWatchList(file = WATCH_FILE): WatchList {
  return parseWatchList(JSON.parse(readFileSync(file, "utf8")));
}
