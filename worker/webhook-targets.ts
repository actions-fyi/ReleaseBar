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
  refreshTargetIndexVersion,
  refreshTargetSourceLimit,
  releaseSummaryPromptVersion,
  repoAudienceRanges,
  webhookPriorityTargetLimit,
  webhookRecentTargetMs,
  webhookTargetBatchSize,
  webhookTargetConcurrency,
  webhookTargetPageSize,
} from "./config.ts";
import { safeIso } from "./owner-metadata-write.ts";
import {
  currentDashboardCacheKey,
  isRefreshTarget,
  persistRefreshTargetWithIndexes,
  readRefreshTarget,
} from "./refresh-targets.ts";
import { repoDetailCacheKey } from "./release-summary.ts";
import { ownerActivityCacheKey, repoDetailAuxCachePrefix } from "./repo-github.ts";
import { webhookHex } from "./request-lock.ts";
import { socialRepoCacheKey } from "./social-card.ts";
import { deleteCacheEntries, deleteCacheEntry } from "./store/cache.ts";
import {
  indexedRefreshTargetPage,
  indexedRefreshTargets,
  listRefreshTargetKeyIndex,
  listStoredRefreshTargets,
  markRefreshTargetIndexReady,
  refreshTargetIndexReady,
} from "./store/refresh-targets.ts";

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
  next: Pick<GitHubWebhookFanoutJob, "source" | "cursor" | "backfillFailed"> | null;
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

export async function indexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<WebhookTargetPage> {
  const { targets, nextCursor } = await durableIndexedWebhookTargets(env, source, value, cursor);
  return {
    targets,
    next: nextCursor
      ? { source, cursor: nextCursor, backfillFailed: undefined }
      : source === "owner"
        ? { source: "repo", cursor: undefined, backfillFailed: undefined }
        : { source: "kv-owner", cursor: undefined, backfillFailed: undefined },
  };
}

export async function kvIndexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<{ targets: RefreshTarget[]; nextCursor?: string }> {
  const page = await listRefreshTargetKeyIndex(env, { kind: source, value }, cursor);
  const indexed = await mapConcurrent(page.entries, 16, async (indexedValue) => {
    const targetKey =
      typeof indexedValue === "string"
        ? indexedValue
        : isRefreshTarget(indexedValue)
          ? indexedValue.key
          : null;
    return targetKey ? readRefreshTarget(env, targetKey) : null;
  });
  return {
    targets: freshestWebhookTargets(
      indexed.filter((target): target is RefreshTarget => target !== null),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function currentWebhookTargets(
  env: Env,
  targets: RefreshTarget[],
): Promise<RefreshTarget[]> {
  const current = await mapConcurrent(targets, 16, (target) => readRefreshTarget(env, target.key));
  return freshestWebhookTargets([
    ...current.filter((target): target is RefreshTarget => target !== null),
    ...targets,
  ]);
}

export async function durableIndexedWebhookTargets(
  env: Env,
  source: "owner" | "repo",
  value: string,
  cursor?: string,
): Promise<{ targets: RefreshTarget[]; nextCursor?: string }> {
  const stored = await indexedRefreshTargetPage(env, { kind: source, value }, cursor);
  const indexed = freshestWebhookTargets(stored.targets.filter(isRefreshTarget));
  return {
    targets: await currentWebhookTargets(env, indexed),
    nextCursor: stored.nextCursor ?? undefined,
  };
}

export async function prioritizedIndexedWebhookTargets(
  env: Env,
  owner: string,
  fullName: string,
  includeReleaseDataOnly: boolean,
): Promise<WebhookTargetPage> {
  const read = async (source: "owner" | "repo", value: string): Promise<RefreshTarget[]> => {
    const stored = await indexedRefreshTargets(env, { kind: source, value });
    return stored.filter(isRefreshTarget);
  };
  const [ownerTargets, repoTargets] = await Promise.all([
    read("owner", owner),
    read("repo", fullName),
  ]);
  const selected = freshestWebhookTargets(
    [...ownerTargets, ...repoTargets]
      .filter((target) => webhookTargetMatches(target, owner, fullName))
      .filter((target) => !includeReleaseDataOnly || target.includeReleaseData),
  )
    .sort(compareWebhookTargets)
    .slice(0, webhookPriorityTargetLimit);
  const targets = freshestWebhookTargets(await currentWebhookTargets(env, selected))
    .filter((target) => webhookTargetMatches(target, owner, fullName))
    .filter((target) => !includeReleaseDataOnly || target.includeReleaseData)
    .sort(compareWebhookTargets);
  return {
    targets,
    next: { source: "owner", cursor: undefined, backfillFailed: undefined },
    prioritized: true,
  };
}

export async function legacyWebhookTargets(
  env: Env,
  owner: string,
  fullName: string,
  cursor?: string,
  backfillFailed = false,
): Promise<WebhookTargetPage> {
  const page = await listStoredRefreshTargets(env, "any-version", webhookTargetPageSize, cursor);
  const validTargets = page.targets.filter(
    (target) => isRefreshTarget(target) && currentDashboardCacheKey(target.key),
  );
  const backfillResults = await mapConcurrent(
    validTargets.filter((target) => target.indexVersion !== refreshTargetIndexVersion),
    4,
    (target) => persistRefreshTargetWithIndexes(env, target),
  );
  const pageBackfillFailed = backfillResults.some(
    (result) => result.persisted && result.target.indexVersion !== refreshTargetIndexVersion,
  );
  const failed = backfillFailed || pageBackfillFailed;
  if (page.complete && !failed) {
    await markRefreshTargetIndexReady(env);
  }
  return {
    targets: validTargets.filter((target) => webhookTargetMatches(target, owner, fullName)),
    next: page.complete
      ? null
      : { source: "legacy", cursor: page.nextCursor, backfillFailed: failed },
  };
}

export async function legacyOwnerWebhookSeedTargets(
  env: Env,
  owner: string,
  fullName: string,
): Promise<RefreshTarget[]> {
  const page = await listStoredRefreshTargets(
    env,
    { owner },
    refreshTargetSourceLimit,
    undefined,
    8,
  );
  return freshestWebhookTargets(
    page.targets.filter(
      (target) => isRefreshTarget(target) && webhookTargetMatches(target, owner, fullName),
    ),
  )
    .sort(compareWebhookTargets)
    .slice(0, webhookPriorityTargetLimit);
}

export async function webhookTargetPage(
  env: Env,
  owner: string,
  fullName: string,
  source?: GitHubWebhookFanoutJob["source"],
  cursor?: string,
  backfillFailed?: boolean,
  priorityIncludeReleaseDataOnly = false,
): Promise<WebhookTargetPage> {
  const indexReady = await refreshTargetIndexReady(env);
  const selectedSource = source ?? (indexReady ? "indexed" : "legacy");
  if (selectedSource === "legacy") {
    if (source === undefined && priorityIncludeReleaseDataOnly) {
      return {
        targets: [],
        next: { source: "legacy", cursor: undefined, backfillFailed: undefined },
        prioritized: true,
      };
    }
    const page = await legacyWebhookTargets(env, owner, fullName, cursor, backfillFailed);
    return page;
  }
  if (selectedSource === "indexed") {
    if (source === undefined) {
      return prioritizedIndexedWebhookTargets(env, owner, fullName, priorityIncludeReleaseDataOnly);
    }
    const page = await indexedWebhookTargets(env, "owner", owner, cursor);
    return {
      ...page,
      targets: page.targets.filter((target) => webhookTargetMatches(target, owner, fullName)),
    };
  }
  if (selectedSource === "kv-owner" || selectedSource === "kv-repo") {
    const kvSource = selectedSource === "kv-owner" ? "owner" : "repo";
    const value = kvSource === "owner" ? owner : fullName;
    const page = await kvIndexedWebhookTargets(env, kvSource, value, cursor);
    return {
      targets: page.targets.filter(
        (target) =>
          target.indexVersion !== refreshTargetIndexVersion &&
          webhookTargetMatches(target, owner, fullName) &&
          (kvSource !== "repo" || !webhookTargetIndexedByOwner(target, owner)),
      ),
      next: page.nextCursor
        ? { source: selectedSource, cursor: page.nextCursor, backfillFailed: undefined }
        : selectedSource === "kv-owner"
          ? { source: "kv-repo", cursor: undefined, backfillFailed: undefined }
          : null,
    };
  }
  if (source === undefined && priorityIncludeReleaseDataOnly) {
    return {
      targets: [],
      next: { source: "owner", cursor: undefined, backfillFailed: undefined },
      prioritized: true,
    };
  }
  const value = selectedSource === "owner" ? owner : fullName;
  const page = await indexedWebhookTargets(env, selectedSource, value, cursor);
  const result: WebhookTargetPage = {
    ...page,
    targets: page.targets.filter(
      (target) =>
        webhookTargetMatches(target, owner, fullName) &&
        (selectedSource !== "repo" || !webhookTargetIndexedByOwner(target, owner)),
    ),
  };
  return result;
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
    deleteCachePrefix(env, repoDetailAuxCachePrefix(fullName)),
  ]);
}

export function deleteCachePrefix(env: Env, prefix: string): Promise<void> {
  return deleteCacheEntries(env, prefix);
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
    deleteCachePrefix(env, "repo-audience:v5:"),
    deleteCachePrefix(env, "owner-activity:v"),
    deleteCachePrefix(env, "owner-activity-summary:"),
    deleteCachePrefix(
      env,
      `owner-activity-summary:v${activitySummaryPromptVersion}:${slugOwner(owner)}:`,
    ),
    deleteCachePrefix(
      env,
      `repo-activity-summary:v${activitySummaryPromptVersion}:${fullName.toLowerCase()}:`,
    ),
    deleteCachePrefix(
      env,
      `release-summary:v${releaseSummaryPromptVersion}:${fullName.toLowerCase()}:`,
    ),
    deleteCachePrefix(env, `discover:v${discoverCacheSchemaVersion}:`),
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
