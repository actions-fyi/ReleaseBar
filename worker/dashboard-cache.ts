import {
  GitHubRateLimitError,
  type OwnerRepoCount,
  slugOwner,
  validRepoSlug,
} from "../shared/dashboard.ts";
import type { ApiQuota, DashboardPayload, DashboardProfile, Project } from "../src/types.ts";
import { sha256Base64Url } from "./crypto.ts";
import { dashboardTotals } from "./build-progress.ts";
import {
  type DashboardRequest,
  dashboardStorageTtlSeconds,
  manualRefreshCooldownPrefix,
  manualRefreshCooldownSeconds,
  maxDisplayStaleMs,
  type OwnerMetadataSnapshot,
  repoLimit,
} from "./config.ts";
import { safeIso } from "./owner-metadata-write.ts";

import { readCacheEntry, readCacheText, writeCacheEntry, writeCacheText } from "./store/cache.ts";
import { ownerMetadataKey } from "./store/owner-metadata.ts";
import {
  ensureProfileSnapshot,
  profileSnapshotStorageKey,
  readProfileSnapshot,
  writeProfileSnapshot,
} from "./store/profile-snapshots.ts";
import { deleteProfile, profileKey, readProfile, writeStoredProfile } from "./store/profiles.ts";

export function withCacheState(
  payload: DashboardPayload,
  state: NonNullable<DashboardPayload["cache"]>["state"],
  message?: string,
): DashboardPayload {
  const cacheMessage = message ?? payload.cache?.message;
  return {
    ...payload,
    cache: {
      state,
      stale: state !== "fresh",
      capped: payload.cache?.capped ?? false,
      repoLimit: payload.cache ? payload.cache.repoLimit : repoLimit,
      generatedAt: payload.generatedAt,
      countsUpdatedAt: payload.cache?.countsUpdatedAt ?? null,
      projectCountsUpdatedAt: payload.cache?.projectCountsUpdatedAt ?? {},
      releasesUpdatedAt: payload.cache?.releasesUpdatedAt ?? null,
      ciUpdatedAt: payload.cache?.ciUpdatedAt ?? null,
      ...(payload.cache?.quota ? { quota: payload.cache.quota } : {}),
      ...(payload.cache?.progress ? { progress: payload.cache.progress } : {}),
      ...(cacheMessage ? { message: cacheMessage } : {}),
    },
  };
}

export function quotaForDashboard(dashboard: DashboardRequest, env: Env): ApiQuota {
  return {
    source: dashboard.quotaSource ?? (dashboard.token || env.GITHUB_TOKEN ? "shared" : "anonymous"),
    account: dashboard.quotaAccount ?? null,
    remaining: null,
    limit: null,
    resetAt: null,
    resource: null,
  };
}

export function optionsFromUrl(url: URL) {
  return {
    includeForks: url.searchParams.get("forks") === "true",
    includeArchived: url.searchParams.get("archived") === "true",
    includeUnreleased: url.searchParams.get("unreleased") !== "false",
  };
}

export function hydrationOptionsFromUrl(
  url: URL,
): Pick<DashboardRequest, "hydrateSort" | "hydrateDirection"> {
  const sort = url.searchParams.get("sort");
  return {
    hydrateSort: sort === "issues" || sort === "prs" ? sort : null,
    hydrateDirection: url.searchParams.get("dir") === "asc" ? "asc" : "desc",
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isGitHubRateLimit(error: unknown): boolean {
  if (error instanceof GitHubRateLimitError) return true;
  return /rate limit|secondary rate|api rate limit exceeded|shared api quota|quota .*exhausted/i.test(
    errorMessage(error),
  );
}

export function retryAfterSeconds(error: unknown): number | null {
  return error instanceof GitHubRateLimitError ? error.retryAfterSeconds : null;
}

export function retryAfterHeaders(error: unknown): Record<string, string> {
  const seconds = retryAfterSeconds(error);
  return seconds === null
    ? { "cache-control": "no-store" }
    : { "cache-control": "no-store", "retry-after": String(seconds) };
}

export function dashboardErrorMessage(error: unknown): string {
  if (isGitHubRateLimit(error)) {
    return "GitHub shared API quota is exhausted. Connect GitHub and install the app for this account to use dedicated quota, or try again after the shared quota resets.";
  }

  const message = errorMessage(error);
  const githubMatch = message.match(/^GitHub API (\d+) for ([^:]+):/);
  if (githubMatch) {
    return `GitHub API ${githubMatch[1]} while loading ${githubMatch[2]}.`;
  }
  return message;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function errorStatus(error: unknown): number {
  const message = errorMessage(error);
  const githubStatus = message.match(/^GitHub API (\d+)/)?.[1];
  if (githubStatus === "404") return 404;
  return isGitHubRateLimit(error) ? 429 : 502;
}

export { ownerMetadataKey };
export { deleteProfile, profileKey, readProfile };
export { ensureProfileSnapshot, profileSnapshotStorageKey, readProfileSnapshot };

export function dashboardWithVisibleProjects(payload: DashboardPayload): DashboardPayload {
  if (payload.options?.includeArchived) return payload;
  const projects = payload.projects.filter((project) => !project.archived);
  if (projects.length === payload.projects.length) return payload;
  return {
    ...payload,
    totals: dashboardTotals(projects),
    projects,
  };
}

export async function readCachedRaw(env: Env, key: string): Promise<DashboardPayload | null> {
  return readCacheEntry<DashboardPayload>(env, key, `dashboard ${key}`);
}

export async function readCached(env: Env, key: string): Promise<DashboardPayload | null> {
  const payload = await readCachedRaw(env, key);
  return payload ? dashboardWithVisibleProjects(payload) : null;
}

export function cacheAgeMs(payload: DashboardPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export function canDisplayCached(payload: DashboardPayload | null): payload is DashboardPayload {
  return cacheAgeMs(payload) <= maxDisplayStaleMs;
}

export function canDisplayOwnerMetadata(snapshot: OwnerMetadataSnapshot): boolean {
  return Date.now() - safeIso(snapshot.metadataUpdatedAt) <= maxDisplayStaleMs;
}

export function canDisplayOwnerProjectMetadata(
  snapshot: OwnerMetadataSnapshot,
  fullName: string,
): boolean {
  return (
    Date.now() - safeIso(snapshot.projectMetadataUpdatedAt[fullName.toLowerCase()]) <=
    maxDisplayStaleMs
  );
}

export function canDisplayOwnerProjectCounts(
  snapshot: OwnerMetadataSnapshot,
  fullName: string,
): boolean {
  return (
    Date.now() - safeIso(snapshot.projectCountsUpdatedAt[fullName.toLowerCase()]) <=
    maxDisplayStaleMs
  );
}

export function canDisplayOwnerCounts(snapshot: OwnerMetadataSnapshot): boolean {
  return Date.now() - safeIso(snapshot.countsUpdatedAt) <= maxDisplayStaleMs;
}

export async function manualRefreshCooldownKey(key: string): Promise<string> {
  return `${manualRefreshCooldownPrefix}${(await sha256Base64Url(key)).slice(0, 32)}`;
}

export async function manualRefreshCooldownActive(env: Env, key: string): Promise<boolean> {
  return Boolean(await readCacheText(env, await manualRefreshCooldownKey(key)));
}

export async function markManualRefreshCooldown(env: Env, key: string): Promise<void> {
  await writeCacheText(
    env,
    await manualRefreshCooldownKey(key),
    new Date().toISOString(),
    manualRefreshCooldownSeconds,
  );
}

// Stores the profile, with a snapshot of it for the refresh targets remembered from now on.
export async function writeProfile(env: Env, profile: DashboardProfile): Promise<void> {
  await Promise.all([writeStoredProfile(env, profile), writeProfileSnapshot(env, profile)]);
}

export async function writeCached(
  env: Env,
  key: string,
  payload: DashboardPayload,
  ttlSeconds = dashboardStorageTtlSeconds,
): Promise<void> {
  await writeCacheEntry(env, key, payload, ttlSeconds);
}

export function normalizeOwnerObservationMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && safeIso(entry[1]) > 0,
      )
      .map(([repo, observedAt]) => [repo.toLowerCase(), observedAt]),
  );
}

export function isOwnerRepoCount(value: unknown): value is OwnerRepoCount {
  const count = value as OwnerRepoCount | null;
  return Boolean(
    count &&
    validRepoSlug(count.fullName.toLowerCase()) &&
    Number.isFinite(count.openIssues) &&
    Number.isFinite(count.openPullRequests) &&
    typeof count.archived === "boolean" &&
    typeof count.fork === "boolean" &&
    typeof count.private === "boolean",
  );
}

export function normalizeOwnerCountOverlays(
  value: unknown,
  projects: Project[],
  projectCountsUpdatedAt: Record<string, string>,
): Record<string, OwnerRepoCount> {
  const overlays =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).flatMap(([fullName, count]) =>
            isOwnerRepoCount(count)
              ? [[fullName.toLowerCase(), { ...count, fullName: count.fullName.toLowerCase() }]]
              : [],
          ),
        )
      : {};
  for (const project of projects) {
    const fullName = project.fullName.toLowerCase();
    if (
      overlays[fullName] ||
      !projectCountsUpdatedAt[fullName] ||
      project.openIssues === null ||
      project.openPullRequests === null
    ) {
      continue;
    }
    overlays[fullName] = {
      fullName,
      openIssues: project.openIssues,
      openPullRequests: project.openPullRequests,
      archived: project.archived,
      fork: project.fork === true,
      private: false,
      pushedAt: project.pushedAt,
      updatedAt: project.updatedAt,
    };
  }
  return overlays;
}

export function normalizeOwnerMetadataSnapshot(
  owner: string,
  value: unknown,
): OwnerMetadataSnapshot | null {
  const snapshot = value as OwnerMetadataSnapshot | null;
  if (snapshot?.owner !== slugOwner(owner) || !Array.isArray(snapshot.projects)) return null;
  const hasMetadataClocks =
    snapshot.projectMetadataUpdatedAt &&
    typeof snapshot.projectMetadataUpdatedAt === "object" &&
    !Array.isArray(snapshot.projectMetadataUpdatedAt);
  const hasCountClocks =
    snapshot.projectCountsUpdatedAt &&
    typeof snapshot.projectCountsUpdatedAt === "object" &&
    !Array.isArray(snapshot.projectCountsUpdatedAt);
  const countsUpdatedAt = snapshot.countsUpdatedAt;
  const projectCountsUpdatedAt = hasCountClocks
    ? normalizeOwnerObservationMap(snapshot.projectCountsUpdatedAt)
    : Object.fromEntries(
        countsUpdatedAt
          ? snapshot.projects.map((project) => [project.fullName.toLowerCase(), countsUpdatedAt])
          : [],
      );
  return {
    ...snapshot,
    countsAttemptedAt: snapshot.countsAttemptedAt ?? snapshot.countsUpdatedAt ?? null,
    releaseDataComplete: snapshot.releaseDataComplete === true,
    knownRepos: Array.isArray(snapshot.knownRepos)
      ? snapshot.knownRepos.map((repo) => repo.toLowerCase())
      : null,
    privateRepos: normalizeOwnerObservationMap(snapshot.privateRepos),
    removedRepos: normalizeOwnerObservationMap(snapshot.removedRepos),
    projectMetadataUpdatedAt: hasMetadataClocks
      ? normalizeOwnerObservationMap(snapshot.projectMetadataUpdatedAt)
      : Object.fromEntries(
          snapshot.projects.map((project) => [
            project.fullName.toLowerCase(),
            snapshot.metadataUpdatedAt,
          ]),
        ),
    projectCountsUpdatedAt,
    countOverlays: normalizeOwnerCountOverlays(
      snapshot.countOverlays,
      snapshot.projects,
      projectCountsUpdatedAt,
    ),
  };
}

export function newestOwnerTimestamp(...values: Array<string | null | undefined>): string | null {
  let newest: string | null = null;
  for (const value of values) {
    if (value && safeIso(value) >= safeIso(newest)) newest = value;
  }
  return newest;
}

export function ownerSnapshotIsNewer(
  candidate: OwnerMetadataSnapshot,
  current: OwnerMetadataSnapshot,
): boolean {
  for (const field of ["countsUpdatedAt", "metadataUpdatedAt", "generatedAt"] as const) {
    const candidateTime = safeIso(candidate[field]);
    const currentTime = safeIso(current[field]);
    if (candidateTime !== currentTime) return candidateTime > currentTime;
  }
  return true;
}
