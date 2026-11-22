import type { Project, RepoDetailReleaseSummary } from "./types.js";

type DraftProject = Pick<
  Project,
  | "owner"
  | "name"
  | "defaultBranch"
  | "latestCommitSha"
  | "version"
  | "compareUrl"
  | "commitsSinceRelease"
>;
type DraftSummary = Pick<RepoDetailReleaseSummary, "state" | "text">;

// A plain MAJOR.MINOR.PATCH tag with an optional "v": matches "v1.4.2", rejects "v1.4.2-beta.1".
// https://regex101.com/?regex=%5E%28v%3F%29%28%5Cd%2B%29%5C.%28%5Cd%2B%29%5C.%28%5Cd%2B%29%24&testString=v1.4.2
const plainSemverTag = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

const PATCH_INCREMENT = 1;

export function nextPatchTag(tag: string): string | null {
  const match = plainSemverTag.exec(tag);
  if (!match) return null;
  const [, prefix, major, minor, patch] = match;
  return `${prefix}${major}.${minor}.${Number(patch) + PATCH_INCREMENT}`;
}

// GitHub's new-release form prefilled from query parameters. Nothing is written: the person reviews and publishes on GitHub.
export function releaseDraftUrl(
  project: DraftProject,
  summary: DraftSummary | null | undefined,
): string | null {
  if (summary?.state !== "ready" || !summary.text || !project.commitsSinceRelease) return null;
  const url = new URL(
    `https://github.com/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}/releases/new`,
  );
  const tag = nextPatchTag(project.version);
  if (tag) {
    url.searchParams.set("tag", tag);
    url.searchParams.set("title", tag);
  }
  url.searchParams.set("target", project.latestCommitSha ?? project.defaultBranch);
  const changelog = project.compareUrl ? `\n\n**Full Changelog**: ${project.compareUrl}` : "";
  url.searchParams.set("body", `${summary.text}${changelog}`);
  return url.toString();
}
