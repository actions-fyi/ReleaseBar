import { slugOwner, validRepoSlug } from "../shared/dashboard.ts";
import type { ActivityRange, RefreshTarget } from "../src/types.ts";
import { mapConcurrent } from "./concurrency.ts";
import { randomNonce } from "./crypto.ts";
import {
  type GitHubWebhookFanoutJob,
  type GitHubWebhookJob,
  type StoredWebhookPending,
  type WebhookTargetAction,
} from "./runtime.ts";
import { repoActivityCacheKey } from "./activity-data.ts";
import {
  repoAudienceCacheKey,
  repoAudienceUserReposKey,
  trustProfileCacheKey,
} from "./audience-data.ts";
import { deleteProgress, markHotCacheStale } from "./build-progress.ts";
import {
  activitySummaryPromptVersion,
  discoverCacheSchemaVersion,
  githubWebhookCoalescingBatchSize,
  githubWebhookPendingLimit,
  githubWebhookPendingLimitBytes,
  releaseSummaryPromptVersion,
  repoAudienceRanges,
  webhookPriorityTargetLimit,
  webhookRecentTargetMs,
  webhookTargetBatchSize,
  webhookTargetConcurrency,
} from "./config.ts";
import { isRefreshTarget } from "./refresh-targets.ts";
import { repoDetailCacheKey } from "./release-summary.ts";
import { ownerActivityCacheKey, repoDetailAuxCachePrefix } from "./repo-github.ts";
import { socialRepoCacheKey } from "./social-card.ts";
import { deleteCacheEntries, deleteCacheEntry } from "./store/cache.ts";
import { indexedRefreshTargetPage, indexedRefreshTargets } from "./store/refresh-targets.ts";
import { safeIso } from "./time.ts";

function webhookHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = `sha256=${webhookHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  )}`;
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return difference === 0;
}

export function webhookRepo(payload: Record<string, unknown>): {
  fullName: string;
  owner: string;
  archived: boolean | null;
  private: boolean | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
} | null {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return null;
  const repo = repository as Record<string, unknown>;
  const fullName = typeof repo.full_name === "string" ? repo.full_name.toLowerCase() : "";
  if (!validRepoSlug(fullName)) return null;
  return {
    fullName,
    owner: fullName.split("/")[0],
    archived: typeof repo.archived === "boolean" ? repo.archived : null,
    private:
      typeof repo.private === "boolean"
        ? repo.private
        : repo.visibility === "private"
          ? true
          : repo.visibility === "public"
            ? false
            : null,
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : null,
    pushedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : null,
    updatedAt: typeof repo.updated_at === "string" ? repo.updated_at : null,
  };
}

export function compactGitHubWebhookPayload(
  event: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  const repository =
    payload.repository && typeof payload.repository === "object"
      ? (payload.repository as Record<string, unknown>)
      : null;
  if (repository) {
    compact.repository =
      event === "repository" && payload.action === "privatized"
        ? {
            full_name: repository.full_name,
            private: repository.private,
            updated_at: repository.updated_at,
          }
        : {
            full_name: repository.full_name,
            archived: repository.archived,
            private: repository.private,
            visibility: repository.visibility,
            default_branch: repository.default_branch,
            pushed_at: repository.pushed_at,
            updated_at: repository.updated_at,
          };
  }
  if (typeof payload.action === "string") compact.action = payload.action;
  if (event === "push") {
    compact.ref = payload.ref;
    compact.after = payload.after;
    compact.deleted = payload.deleted;
    const headCommit =
      payload.head_commit && typeof payload.head_commit === "object"
        ? (payload.head_commit as Record<string, unknown>)
        : null;
    if (headCommit) compact.head_commit = { timestamp: headCommit.timestamp };
  }
  if (event === "release") {
    const release =
      payload.release && typeof payload.release === "object"
        ? (payload.release as Record<string, unknown>)
        : null;
    if (release) {
      compact.release = {
        tag_name: release.tag_name,
        name: release.name,
        html_url: release.html_url,
        published_at: release.published_at,
        draft: release.draft,
      };
    }
  }
  return compact;
}

export function releaseWebhookAffectsDashboard(payload: Record<string, unknown>): boolean {
  const release =
    payload.release && typeof payload.release === "object"
      ? (payload.release as Record<string, unknown>)
      : null;
  const action = String(payload.action ?? "");
  if (!release || (release.draft === true && action !== "unpublished")) return false;
  return Boolean(action);
}

export function githubWebhookCoalescingKey(job: GitHubWebhookJob): string {
  const repo = webhookRepo(job.payload);
  if (!repo) return `delivery:${job.delivery}`;
  const action = String(job.payload.action ?? "");
  if (
    (job.event === "issues" &&
      ["opened", "reopened", "closed", "deleted", "transferred"].includes(action)) ||
    (job.event === "pull_request" && ["opened", "reopened", "closed", "deleted"].includes(action))
  ) {
    return `counts:${repo.fullName}`;
  }
  if (
    (job.event === "push" &&
      job.payload.deleted !== true &&
      (!repo.defaultBranch || job.payload.ref === `refs/heads/${repo.defaultBranch}`)) ||
    (job.event === "release" && releaseWebhookAffectsDashboard(job.payload))
  ) {
    return `release:${repo.fullName}`;
  }
  return `delivery:${job.delivery}`;
}

export function mergePendingWebhook(
  pending: StoredWebhookPending[],
  job: GitHubWebhookJob,
): StoredWebhookPending[] {
  const key = githubWebhookCoalescingKey(job);
  const existingIndex = pending.findIndex((entry) => entry.key === key);
  const next: StoredWebhookPending = {
    key,
    revision: randomNonce(),
    job,
    deliveries:
      existingIndex >= 0
        ? [...new Set([...pending[existingIndex].deliveries, job.delivery])]
        : [job.delivery],
  };
  if (existingIndex < 0) return [...pending, next];
  return pending.map((entry, index) => (index === existingIndex ? next : entry));
}

export function pendingWebhookFits(pending: StoredWebhookPending[]): boolean {
  return (
    pending.length <= githubWebhookPendingLimit &&
    new TextEncoder().encode(JSON.stringify(pending)).byteLength <= githubWebhookPendingLimitBytes
  );
}

export function pendingWebhookBatch(
  pending: StoredWebhookPending[],
  leaderDelivery: string,
): StoredWebhookPending[] {
  const sorted = [...pending].sort(
    (left, right) => safeIso(left.job.createdAt) - safeIso(right.job.createdAt),
  );
  const leader = sorted.find((entry) => entry.deliveries.includes(leaderDelivery));
  const others = sorted.filter((entry) => entry !== leader);
  // Finish with the leader so any earlier failure leaves its queue delivery retryable.
  return [
    ...others.slice(0, Math.max(0, githubWebhookCoalescingBatchSize - (leader ? 1 : 0))),
    ...(leader ? [leader] : []),
  ];
}

export type WebhookTargetPage = {
  targets: RefreshTarget[];
  next: Pick<GitHubWebhookFanoutJob, "source" | "cursor"> | null;
  prioritized?: boolean;
};

export function compareWebhookTargets(left: RefreshTarget, right: RefreshTarget): number {
  return (
    safeIso(right.lastSeenAt) - safeIso(left.lastSeenAt) ||
    right.priority - left.priority ||
    left.key.localeCompare(right.key)
  );
}

export function freshestWebhookTargets(targets: RefreshTarget[]): RefreshTarget[] {
  const freshest = new Map<string, RefreshTarget>();
  for (const target of targets) {
    const current = freshest.get(target.key);
    if (!current || compareWebhookTargets(target, current) < 0) {
      freshest.set(target.key, target);
    }
  }
  return [...freshest.values()];
}

export function webhookTargetMatches(
  target: RefreshTarget,
  owner: string,
  fullName: string,
): boolean {
  return target.owners.includes(owner) || target.repos.includes(fullName) || target.owner === owner;
}

export function webhookTargetIndexedByOwner(target: RefreshTarget, owner: string): boolean {
  return (
    slugOwner(target.owner) === owner ||
    target.owners.some((targetOwner) => slugOwner(targetOwner) === owner)
  );
}

// A page of the targets listed under one source, with what follows it: the next page of the
// source, then the repository's targets after the owner's, then nothing.
export async function indexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<WebhookTargetPage> {
  const page = await indexedRefreshTargetPage(env, { kind: source, value }, cursor);
  return {
    targets: freshestWebhookTargets(page.targets.filter(isRefreshTarget)),
    next: page.nextCursor
      ? { source, cursor: page.nextCursor }
      : source === "owner"
        ? { source: "repo", cursor: undefined }
        : null,
  };
}

// The targets a webhook refreshes first: the most recently seen ones that show the owner or the
// repository.
export async function prioritizedIndexedWebhookTargets(
  env: Env,
  owner: string,
  fullName: string,
  includeReleaseDataOnly: boolean,
): Promise<WebhookTargetPage> {
  const stored = await indexedRefreshTargets(env, [
    { kind: "owner", value: owner },
    { kind: "repo", value: fullName },
  ]);
  const targets = freshestWebhookTargets(
    stored
      .flat()
      .filter(isRefreshTarget)
      .filter((target) => webhookTargetMatches(target, owner, fullName))
      .filter((target) => !includeReleaseDataOnly || target.includeReleaseData),
  )
    .sort(compareWebhookTargets)
    .slice(0, webhookPriorityTargetLimit);
  return {
    targets,
    next: { source: "owner", cursor: undefined },
    prioritized: true,
  };
}

// The targets a webhook for `fullName` refreshes, a page at a time. Without `source`, the
// prioritized targets; then the owner's targets in key order, then the repository's that the
// owner's pages did not hold.
export async function webhookTargetPage(
  env: Env,
  owner: string,
  fullName: string,
  source?: GitHubWebhookFanoutJob["source"],
  cursor?: string,
  priorityIncludeReleaseDataOnly = false,
): Promise<WebhookTargetPage> {
  if (source === undefined) {
    return prioritizedIndexedWebhookTargets(env, owner, fullName, priorityIncludeReleaseDataOnly);
  }
  const page = await indexedWebhookTargets(
    env,
    source,
    source === "owner" ? owner : fullName,
    cursor,
  );
  return {
    ...page,
    targets: page.targets.filter(
      (target) =>
        webhookTargetMatches(target, owner, fullName) &&
        (source !== "repo" || !webhookTargetIndexedByOwner(target, owner)),
    ),
  };
}

export async function mapWebhookTargets<T>(
  targets: RefreshTarget[],
  operation: (target: RefreshTarget) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < targets.length; index += webhookTargetBatchSize) {
    results.push(
      ...(await mapConcurrent(
        targets.slice(index, index + webhookTargetBatchSize),
        webhookTargetConcurrency,
        operation,
      )),
    );
  }
  return results;
}

export function webhookTargetsForAction(
  targets: RefreshTarget[],
  action: WebhookTargetAction,
  now = Date.now(),
): RefreshTarget[] {
  const recentCutoff = now - webhookRecentTargetMs;
  return freshestWebhookTargets(
    targets
      .filter((target) => !action.includeReleaseDataOnly || target.includeReleaseData)
      .filter((target) => !action.recentTargetsOnly || safeIso(target.lastSeenAt) >= recentCutoff),
  ).sort(compareWebhookTargets);
}

export async function invalidateRepoProjectCache(env: Env, fullName: string): Promise<void> {
  await Promise.all(
    [true, false].flatMap((includeUnreleased) =>
      [true, false].map((includeReleaseData) =>
        deleteCacheEntry(
          env,
          `repo:v2:${fullName}:${includeUnreleased ? "unreleased" : "released"}:${includeReleaseData ? "release" : "metadata"}`,
        ),
      ),
    ),
  );
}

export async function invalidateRepoDetailCaches(env: Env, fullName: string): Promise<void> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;
  await Promise.all([
    deleteCacheEntry(env, repoDetailCacheKey(owner, repo)),
    deleteCacheEntries(env, repoDetailAuxCachePrefix(fullName)),
  ]);
}

export async function invalidatePublicRepoCaches(env: Env, fullName: string): Promise<void> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return;
  await Promise.all([
    invalidateRepoProjectCache(env, fullName),
    invalidateRepoDetailCaches(env, fullName),
    deleteCacheEntry(env, socialRepoCacheKey(owner, repo)),
    ...(["day", "week", "month"] as ActivityRange[]).map((range) =>
      deleteCacheEntry(env, repoActivityCacheKey(owner, repo, range)),
    ),
    ...repoAudienceRanges.map((range) =>
      deleteCacheEntry(env, repoAudienceCacheKey(owner, repo, range)),
    ),
    deleteCacheEntry(env, repoAudienceUserReposKey(owner)),
    deleteCacheEntry(env, trustProfileCacheKey(owner)),
    ...(["day", "week", "month"] as ActivityRange[]).map((range) =>
      deleteCacheEntry(env, ownerActivityCacheKey(owner, range)),
    ),
    deleteCacheEntries(env, "repo-audience:v5:"),
    deleteCacheEntries(env, "owner-activity:v"),
    deleteCacheEntries(env, "owner-activity-summary:"),
    deleteCacheEntries(
      env,
      `owner-activity-summary:v${activitySummaryPromptVersion}:${slugOwner(owner)}:`,
    ),
    deleteCacheEntries(
      env,
      `repo-activity-summary:v${activitySummaryPromptVersion}:${fullName.toLowerCase()}:`,
    ),
    deleteCacheEntries(
      env,
      `release-summary:v${releaseSummaryPromptVersion}:${fullName.toLowerCase()}:`,
    ),
    deleteCacheEntries(env, `discover:v${discoverCacheSchemaVersion}:`),
  ]);
}

export async function invalidateDashboardTargets(
  env: Env,
  targets: RefreshTarget[],
): Promise<void> {
  await markHotCacheStale(env);
  await mapWebhookTargets(targets, async (target) => {
    await Promise.all([deleteCacheEntry(env, target.key), deleteProgress(env, target.key)]);
  });
}
