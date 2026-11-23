import { type OwnerRepoCount, slugOwner, validOwnerSlug } from "../shared/dashboard.ts";
import type { Project } from "../src/types.ts";
import { type OwnerMetadataSnapshot } from "./config.ts";
import { normalizeOwnerMetadataSnapshot } from "./dashboard-cache.ts";
import { readStoredOwnerMetadata, readStoredOwnerMetadataOf } from "./store/owner-metadata.ts";
import { safeIso } from "./time.ts";

// The owner's snapshot, validated. Null when there is none. Rejects when the database can't be
// reached, so that a caller hiding private repositories does not take "unknown" for "public".
export async function readOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  const normalizedOwner = slugOwner(owner);
  return normalizeOwnerMetadataSnapshot(
    normalizedOwner,
    await readStoredOwnerMetadata(env, normalizedOwner),
  );
}

// The snapshots of the owners, validated, by the owner's slug: null for an owner that has none.
// One query, however many owners. Rejects when the database can't be reached, as
// `readOwnerMetadata` does.
export async function readOwnerMetadataOf(
  env: Env,
  owners: string[],
): Promise<Map<string, OwnerMetadataSnapshot | null>> {
  const stored = await readStoredOwnerMetadataOf(env, owners);
  return new Map(
    [...stored].map(([owner, snapshot]) => [
      owner,
      normalizeOwnerMetadataSnapshot(owner, snapshot),
    ]),
  );
}

export type PublicCacheBarrier = "clear" | "blocked" | "unknown";

export async function repositoryPublicCacheBarrier(
  env: Env,
  fullName: string,
): Promise<PublicCacheBarrier> {
  const normalized = fullName.toLowerCase();
  const owner = normalized.split("/")[0];
  if (!owner) return "blocked";
  try {
    const snapshot = await readOwnerMetadata(env, owner);
    return snapshot?.removedRepos[normalized] || snapshot?.privateRepos[normalized]
      ? "blocked"
      : "clear";
  } catch {
    return "unknown";
  }
}

export async function privateRepositoryNames(
  env: Env,
  fullNames: string[],
): Promise<Set<string> | null> {
  const normalized = [...new Set(fullNames.map((fullName) => fullName.toLowerCase()))];
  const owners = [
    ...new Set(
      normalized
        .map((fullName) => fullName.split("/")[0] ?? "")
        .filter((owner) => validOwnerSlug(owner)),
    ),
  ];
  try {
    const byOwner = await readOwnerMetadataOf(env, owners);
    return new Set(
      normalized.filter((fullName) => {
        const owner = fullName.split("/")[0] ?? "";
        return Boolean(byOwner.get(owner)?.privateRepos[fullName]);
      }),
    );
  } catch {
    return null;
  }
}

export function mergeProjectMetadata(project: Project, metadata: Project): Project {
  return {
    ...project,
    owner: metadata.owner,
    name: metadata.name,
    fullName: metadata.fullName,
    description: metadata.description,
    url: metadata.url,
    defaultBranch: metadata.defaultBranch,
    language: metadata.language,
    topics: metadata.topics,
    stars: metadata.stars,
    forks: metadata.forks,
    issuesUrl: metadata.issuesUrl,
    pullRequestsUrl: metadata.pullRequestsUrl,
    archived: metadata.archived,
    fork: metadata.fork,
    pushedAt: metadata.pushedAt,
    updatedAt: metadata.updatedAt,
  };
}

export function projectWithoutReleaseData(project: Project): Project {
  return {
    ...project,
    openIssues: null,
    openPullRequests: null,
    latestCommitSha: null,
    latestCommitDate: null,
    version: "repo search",
    releaseName: null,
    releaseUrl: `${project.url}/releases`,
    releaseDate: null,
    commitsSinceRelease: null,
    compareUrl: null,
    ciState: "unknown",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "hot",
  };
}

export function mergeProjectCountFields(
  project: Project,
  counts: Project | OwnerRepoCount,
): Project {
  return {
    ...project,
    openIssues: counts.openIssues ?? project.openIssues,
    openPullRequests: counts.openPullRequests ?? project.openPullRequests,
    archived: counts.archived,
    fork: counts.fork,
    pushedAt: counts.pushedAt,
    updatedAt: counts.updatedAt,
  };
}

export function mergeProjectIssuePullCounts(
  project: Project,
  counts: Project | OwnerRepoCount,
): Project {
  return {
    ...project,
    openIssues: counts.openIssues ?? project.openIssues,
    openPullRequests: counts.openPullRequests ?? project.openPullRequests,
  };
}

export function ownerSnapshotWithCounts(
  snapshot: OwnerMetadataSnapshot,
  counts: OwnerRepoCount[],
  updatedAt: string,
  complete: boolean,
): OwnerMetadataSnapshot {
  if (safeIso(updatedAt) < safeIso(snapshot.countsAttemptedAt)) {
    return snapshot;
  }
  const byName = new Map(counts.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const publicNames = new Set(
    counts.filter((repo) => !repo.private).map((repo) => repo.fullName.toLowerCase()),
  );
  const privateNames = counts
    .filter((repo) => repo.private)
    .map((repo) => repo.fullName.toLowerCase());
  const newerMetadataNames = new Set(
    Object.entries(snapshot.projectMetadataUpdatedAt)
      .filter(([, metadataUpdatedAt]) => safeIso(metadataUpdatedAt) > safeIso(updatedAt))
      .map(([fullName]) => fullName),
  );
  const removedRepos = { ...snapshot.removedRepos };
  const projectCountsUpdatedAt = { ...snapshot.projectCountsUpdatedAt };
  const countOverlays = { ...snapshot.countOverlays };
  for (const fullName of publicNames) {
    if (snapshot.privateRepos[fullName]) continue;
    if (safeIso(updatedAt) > safeIso(removedRepos[fullName])) {
      delete removedRepos[fullName];
    }
  }
  for (const fullName of privateNames) {
    if (newerMetadataNames.has(fullName)) continue;
    if (safeIso(updatedAt) >= safeIso(removedRepos[fullName])) {
      removedRepos[fullName] = updatedAt;
    }
    delete countOverlays[fullName];
  }
  if (complete) {
    for (const fullName of Object.keys(countOverlays)) {
      if (!publicNames.has(fullName) && !newerMetadataNames.has(fullName)) {
        delete countOverlays[fullName];
      }
    }
  }
  for (const count of counts) {
    const fullName = count.fullName.toLowerCase();
    if (count.private || newerMetadataNames.has(fullName)) continue;
    countOverlays[fullName] = { ...count, fullName };
    if (safeIso(updatedAt) >= safeIso(projectCountsUpdatedAt[fullName])) {
      projectCountsUpdatedAt[fullName] = updatedAt;
    }
  }
  return {
    ...snapshot,
    countsUpdatedAt: complete ? updatedAt : snapshot.countsUpdatedAt,
    countsAttemptedAt: updatedAt,
    knownRepos: complete
      ? [
          ...new Set([
            ...publicNames,
            ...(snapshot.knownRepos ?? []).filter((fullName) => newerMetadataNames.has(fullName)),
            ...snapshot.projects
              .map((project) => project.fullName.toLowerCase())
              .filter((fullName) => newerMetadataNames.has(fullName)),
          ]),
        ]
      : (snapshot.knownRepos ?? null),
    removedRepos,
    countOverlays,
    projects: snapshot.projects.flatMap((project) => {
      const fullName = project.fullName.toLowerCase();
      if (snapshot.privateRepos[fullName]) return [];
      const count = byName.get(fullName);
      const preserveNewerMetadata = newerMetadataNames.has(fullName);
      if (!count) return complete && !preserveNewerMetadata ? [] : [project];
      if (count.private) return preserveNewerMetadata ? [project] : [];
      return [
        {
          ...project,
          openIssues: count.openIssues,
          openPullRequests: count.openPullRequests,
          archived: preserveNewerMetadata ? project.archived : count.archived,
          fork: preserveNewerMetadata ? project.fork : count.fork,
          pushedAt: preserveNewerMetadata ? project.pushedAt : count.pushedAt,
          updatedAt: preserveNewerMetadata ? project.updatedAt : count.updatedAt,
        },
      ];
    }),
    projectCountsUpdatedAt,
  };
}
