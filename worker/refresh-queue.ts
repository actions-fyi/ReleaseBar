import {
  fetchOwnerRepoCounts,
  type OwnerRepoCount,
  slugOwner,
  validOwnerSlug,
} from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../src/types.ts";
import { mapConcurrent } from "./concurrency.ts";
import {
  auditGitHubFetch,
  githubGraphqlOwnerReleaseOperation,
  graphqlBackoffActive,
  sharedQuotaCooldown,
} from "./github-audit.ts";
import { appTokenConfigured } from "./auth-oauth.ts";
import {
  type InstallationRegistry,
  installationRegistryFor,
  sourceInstallationRegistryCovers,
  sourceInstallationToken,
} from "./auth-tokens.ts";
import { markHotCacheStale } from "./build-progress.ts";
import {
  githubGraphqlOwnerCountsOperation,
  githubGraphqlRepoDetailsOperation,
  refreshJobReservationTtlMs,
  refreshQueueDeliveryDelaySeconds,
  schedulerBatchLimit,
  schedulerCountConcurrency,
  schedulerCountOwnerLimit,
  schedulerCountRefreshMs,
  schedulerRecentViewMs,
  schedulerSharedDormantAfterMs,
  schedulerSharedDormantRefreshMs,
  schedulerTargetPageLimit,
  type OwnerMetadataMutation,
  type StoredRefreshDirty,
} from "./config.ts";
import { canDisplayCached, errorMessage, readCached } from "./dashboard-cache.ts";
import { readOwnerMetadata } from "./owner-metadata-read.ts";
import {
  mutateOwnerMetadataSnapshot,
  mutateOwnerMetadataSnapshots,
  safeIso,
} from "./owner-metadata-write.ts";
import { readOwnerCountTimes } from "./store/owner-metadata.ts";
import {
  auditScheduler,
  auditSyncEvent,
  deleteExpiredRefreshData,
  indexRefreshJobs,
  jitterMs,
  listRefreshJobs,
  listRefreshTargets,
  localRefreshJobReservationStore,
  readRefreshTarget,
  recordLocalRefreshDirty,
  refreshJob,
  refreshJobActive,
  takeLocalRefreshDirty,
  writeRefreshJobs,
} from "./refresh-targets.ts";
import { invalidateDashboardTargets } from "./webhook-targets.ts";
import type { BackgroundContext } from "./runtime.ts";
import { sendQueueMessage } from "./store/queue.ts";
import { releaseCoordinatedJob, reserveCoordinatedJob } from "./store/build-coordinator.ts";
import {
  readOwnerCountCursor,
  readSchedulerState,
  writeOwnerCountCursor,
  writeSchedulerState,
} from "./store/scheduler-state.ts";

export function refreshQueueMessage(job: RefreshJob): RefreshJob {
  const { target: _target, ...message } = job;
  return message;
}

export async function reserveRefreshJob(
  env: Env,
  targetKey: string,
  jobId: string,
  dirtyOnConflict?: StoredRefreshDirty,
  // The jobs the fallback looks for an active one in. A caller that reserves for many targets
  // reads them once.
  listJobs: () => Promise<RefreshJob[]> = () => listRefreshJobs(env),
): Promise<boolean> {
  const reserveFallback = async (): Promise<boolean> => {
    const reservations = localRefreshJobReservationStore(env);
    const now = Date.now();
    const local = reservations.get(targetKey);
    if (local && local.jobId !== jobId && local.expiresAt > now) {
      if (dirtyOnConflict) recordLocalRefreshDirty(env, targetKey, dirtyOnConflict);
      return false;
    }
    reservations.set(targetKey, {
      jobId,
      expiresAt: now + refreshJobReservationTtlMs,
    });
    try {
      const active = (await listJobs()).find(
        (job) => job.targetKey === targetKey && job.id !== jobId && refreshJobActive(job),
      );
      if (!active) return true;
      if (reservations.get(targetKey)?.jobId === jobId) {
        reservations.delete(targetKey);
      }
      if (dirtyOnConflict) recordLocalRefreshDirty(env, targetKey, dirtyOnConflict);
      return false;
    } catch (error) {
      if (reservations.get(targetKey)?.jobId === jobId) {
        reservations.delete(targetKey);
      }
      throw error;
    }
  };
  try {
    return await reserveCoordinatedJob(env, targetKey, jobId, dirtyOnConflict);
  } catch (error) {
    await auditSyncEvent(env, {
      event: "job_reservation_fallback",
      targetKey,
      jobId,
      status: "fallback",
      reason: errorMessage(error),
    }).catch(() => undefined);
  }
  return reserveFallback();
}

export async function releaseRefreshJobReservation(
  env: Env,
  targetKey: string,
  jobId: string,
  consumeDirty = false,
): Promise<StoredRefreshDirty | null> {
  const reservations = localRefreshJobReservationStore(env);
  let localDirty: StoredRefreshDirty | null = null;
  if (reservations.get(targetKey)?.jobId === jobId) {
    reservations.delete(targetKey);
    if (consumeDirty) {
      localDirty = takeLocalRefreshDirty(env, targetKey);
    }
  }
  try {
    const dirty = await releaseCoordinatedJob(env, targetKey, jobId, consumeDirty);
    return dirty ?? localDirty;
  } catch (error) {
    await auditSyncEvent(env, {
      event: "job_reservation_release_failed",
      targetKey,
      jobId,
      status: "failed",
      reason: errorMessage(error),
    }).catch(() => undefined);
  }
  return localDirty;
}

export type RefreshJobRequest = { target: RefreshTarget; reason: string };

// Enqueues a refresh job for each target that is not in backoff and whose reservation is free:
// null for the others, in the order of `requests`.
//
// The jobs are stored in batches, so D1 gets a query per `refreshJobBatchRows` jobs, not per
// job. For each job the order is as for one: reserved, stored, audited, sent to the queue. A job
// that could not be stored or sent is stored as failed and its reservation released; the others
// are enqueued all the same, and the first error is thrown once they are.
export async function enqueueRefreshJobs(
  env: Env,
  _context: BackgroundContext,
  requests: RefreshJobRequest[],
  options: { delaySeconds?: number; concurrency?: number } = {},
): Promise<Array<RefreshJob | null>> {
  const delaySeconds = options.delaySeconds ?? refreshQueueDeliveryDelaySeconds;
  const concurrency = options.concurrency ?? 1;
  const errors: unknown[] = [];
  const failed = new Map<string, { job: RefreshJob; error: unknown }>();
  let listedJobs: Promise<RefreshJob[]> | undefined;
  const listJobs = (): Promise<RefreshJob[]> => (listedJobs ??= listRefreshJobs(env));

  const reserved = await mapConcurrent(requests, concurrency, async ({ target, reason }) => {
    if (
      reason !== "manual-refresh" &&
      !reason.startsWith("webhook:") &&
      refreshTargetBackoffActive(target)
    ) {
      await auditSyncEvent(env, {
        event: "job_enqueue_skip",
        targetKey: target.key,
        status: "backoff",
        reason,
        detail: `nextDueAt=${target.nextDueAt} failureCount=${target.failureCount}`,
      });
      return null;
    }
    const job = refreshJob(target, reason);
    const dirtyOnConflict = reason.startsWith("webhook:")
      ? { observedAt: new Date().toISOString(), reason }
      : undefined;
    try {
      if (await reserveRefreshJob(env, target.key, job.id, dirtyOnConflict, listJobs)) return job;
    } catch (error) {
      errors.push(error);
      return null;
    }
    await auditSyncEvent(env, {
      event: "job_enqueue_skip",
      targetKey: target.key,
      status: "reserved",
      reason,
    });
    return null;
  });

  const jobs = reserved.filter((job): job is RefreshJob => job !== null);
  for (const failure of await indexRefreshJobs(env, jobs)) {
    failed.set(failure.job.id, failure);
  }
  await mapConcurrent(
    jobs.filter((job) => !failed.has(job.id)),
    concurrency,
    async (job) => {
      try {
        await auditScheduler(env, {
          event: "job_enqueue",
          targetKey: job.targetKey,
          jobId: job.id,
          reason: job.reason,
        });
        await sendQueueMessage(env, refreshQueueMessage(job), { delaySeconds });
      } catch (error) {
        failed.set(job.id, { job, error });
      }
    },
  );

  if (failed.size > 0) {
    const now = new Date().toISOString();
    await writeRefreshJobs(
      env,
      [...failed.values()].map(({ job, error }) => ({
        ...job,
        status: "failed" as const,
        finishedAt: now,
        updatedAt: now,
        error: errorMessage(error),
      })),
    ).catch(() => undefined);
    await mapConcurrent([...failed.values()], Math.max(concurrency, 4), ({ job }) =>
      releaseRefreshJobReservation(env, job.targetKey, job.id).catch(() => undefined),
    );
    errors.push(...[...failed.values()].map(({ error }) => error));
  }
  if (errors.length > 0) throw errors[0];
  return reserved;
}

export async function enqueueRefreshJob(
  env: Env,
  context: BackgroundContext,
  target: RefreshTarget,
  reason: string,
  delaySeconds = refreshQueueDeliveryDelaySeconds,
): Promise<RefreshJob | null> {
  const [job] = await enqueueRefreshJobs(env, context, [{ target, reason }], {
    delaySeconds,
  });
  return job ?? null;
}

export async function finishRefreshJobReservation(
  env: Env,
  context: BackgroundContext,
  job: RefreshJob,
): Promise<void> {
  const dirty = await releaseRefreshJobReservation(env, job.targetKey, job.id, true);
  if (!dirty) return;
  const target = job.target ?? (await readRefreshTarget(env, job.targetKey));
  if (!target) {
    await auditSyncEvent(env, {
      event: "job_followup_failed",
      targetKey: job.targetKey,
      jobId: job.id,
      status: "failed",
      reason: "target missing",
      detail: `webhookReason=${dirty.reason}`,
    });
    return;
  }
  await invalidateDashboardTargets(env, [target]);
  const followup = await enqueueRefreshJob(env, context, target, `${dirty.reason}:follow-up`, 0);
  await auditSyncEvent(env, {
    event: followup ? "job_followup_enqueue" : "job_followup_defer",
    targetKey: target.key,
    jobId: followup?.id ?? job.id,
    status: followup ? "queued" : "reserved",
    reason: dirty.reason,
  });
}

export function refreshTargetDue(
  target: RefreshTarget,
  cached: DashboardPayload | null,
  now = Date.now(),
): boolean {
  if (refreshTargetBackoffActive(target, now)) return false;
  if (target.failureCount > 0 && now < safeIso(target.nextDueAt)) return false;
  if (!cached || !canDisplayCached(cached)) return true;
  if (cached.cache?.state === "error" || cached.cache?.progress?.done === false) return true;
  return now >= safeIso(target.nextDueAt);
}

export function refreshTargetBackoffActive(target: RefreshTarget, now = Date.now()): boolean {
  return now < safeIso(target.terminalBackoffUntil ?? "");
}

export function refreshReason(target: RefreshTarget, cached: DashboardPayload | null): string {
  if (sharedQuotaDeferredTarget(target)) return "app-quota";
  if (!cached) return "missing-cache";
  if (!canDisplayCached(cached)) return "expired-cache";
  if (cached.cache?.state === "error") return "error-cache";
  if (cached.cache?.progress?.done === false) return "partial-cache";
  return Date.now() >= safeIso(target.nextDueAt) ? "scheduled" : "not-due";
}

export function sharedQuotaDeferredTarget(target: RefreshTarget): boolean {
  return (
    typeof target.message === "string" &&
    target.message.startsWith("shared GitHub quota paused until ") &&
    Date.now() < safeIso(target.nextDueAt)
  );
}

export type SchedulerDueOptions = {
  sharedQuotaPaused: boolean;
  sharedGraphqlPausedOperations: ReadonlySet<string>;
  now: number;
  // The installations of the targets' accounts, when the caller has read them for all its
  // targets at once; null when that read failed, and no target then counts as covered.
  registry?: InstallationRegistry | null;
};

export function refreshTargetGraphqlOperations(target: RefreshTarget): string[] {
  const operations: string[] = [];
  if (target.owners.length > 0) {
    operations.push(
      target.includeReleaseData
        ? githubGraphqlOwnerReleaseOperation
        : "ReleaseBarOwnerRepos.metadata",
    );
  }
  if (target.includeReleaseData && target.owners.length > 0) {
    operations.push(githubGraphqlRepoDetailsOperation);
  }
  return operations;
}

export function dormantSharedTargetDue(target: RefreshTarget, now: number): boolean {
  const lastSeenAt = safeIso(target.lastSeenAt);
  if (!lastSeenAt || now - lastSeenAt < schedulerSharedDormantAfterMs) return false;
  const cadenceAnchor = Math.max(
    lastSeenAt,
    safeIso(target.lastAttemptAt),
    safeIso(target.lastSuccessAt),
  );
  const nextDormantRefreshAt =
    cadenceAnchor + schedulerSharedDormantRefreshMs + jitterMs(target.key, 24 * 60 * 60 * 1000);
  return now >= nextDormantRefreshAt;
}

export async function schedulerTargetDue(
  env: Env,
  target: RefreshTarget,
  cached: DashboardPayload | null,
  options: SchedulerDueOptions = {
    sharedQuotaPaused: false,
    sharedGraphqlPausedOperations: new Set<string>(),
    now: Date.now(),
  },
): Promise<boolean> {
  const hasAppTokenCoverage = () =>
    sourceInstallationRegistryCovers(
      env,
      { owners: target.owners, repos: target.repos },
      options.registry,
    ).catch(() => false);
  if (sharedQuotaDeferredTarget(target)) {
    return hasAppTokenCoverage();
  }
  const sharedGraphqlPaused = refreshTargetGraphqlOperations(target).some((operation) =>
    options.sharedGraphqlPausedOperations.has(operation),
  );
  if ((options.sharedQuotaPaused || sharedGraphqlPaused) && !(await hasAppTokenCoverage())) {
    return false;
  }
  if (!refreshTargetDue(target, cached, options.now)) return false;
  const hasHealthyCache =
    cached &&
    canDisplayCached(cached) &&
    cached.cache?.state !== "error" &&
    cached.cache?.progress?.done !== false;
  if (!hasHealthyCache) return true;
  if (dormantSharedTargetDue(target, options.now)) return true;
  const lastSeenAt = safeIso(target.lastSeenAt);
  const dormantSharedTarget =
    lastSeenAt > 0 && options.now - lastSeenAt >= schedulerSharedDormantAfterMs;
  if (!dormantSharedTarget) return true;
  const hasApp = await hasAppTokenCoverage();
  if (hasApp) return true;
  return false;
}

export async function schedulerDueOptions(env: Env): Promise<SchedulerDueOptions> {
  const operations = [
    githubGraphqlOwnerCountsOperation,
    "ReleaseBarOwnerRepos.metadata",
    githubGraphqlOwnerReleaseOperation,
    githubGraphqlRepoDetailsOperation,
  ];
  const [cooldown, ...backoffs] = await Promise.all([
    env.GITHUB_TOKEN ? sharedQuotaCooldown(env) : Promise.resolve(null),
    ...operations.map((operation) =>
      env.GITHUB_TOKEN
        ? graphqlBackoffActive(env, "shared", null, operation)
        : Promise.resolve(false),
    ),
  ]);
  return {
    sharedQuotaPaused: Boolean(cooldown?.active),
    sharedGraphqlPausedOperations: new Set(
      operations.filter((_operation, index) => backoffs[index]),
    ),
    now: Date.now(),
  };
}
type OwnerCountsFetch =
  | { status: "deferred" }
  | {
      status: "fetched";
      mutation: OwnerMetadataMutation;
      repos: OwnerRepoCount[];
    };

// Asks GitHub for the owner's repository counts, with the owner's installation token or the
// shared one. Nothing is stored: the result carries the mutation that stores the counts.
// `registry` is the installations the invocation has read already.
async function fetchOwnerCounts(
  env: Env,
  owner: string,
  context?: BackgroundContext,
  registry?: InstallationRegistry,
): Promise<OwnerCountsFetch> {
  const observedAt = new Date().toISOString();
  const token = await sourceInstallationToken(
    env,
    { owners: [owner], repos: [] },
    { discover: false, registry },
  ).catch(() => null);
  const quotaSource = token?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  if (quotaSource === "anonymous") return { status: "deferred" };
  if (
    quotaSource === "shared" &&
    ((await sharedQuotaCooldown(env))?.active ||
      (await graphqlBackoffActive(env, quotaSource, null, githubGraphqlOwnerCountsOperation)))
  ) {
    return { status: "deferred" };
  }
  const result = await fetchOwnerRepoCounts({
    owner,
    token: token?.token ?? env.GITHUB_TOKEN,
    quotaSource,
    quotaAccount: token?.quotaAccount ?? null,
    limit: 500,
    fetch: auditGitHubFetch("dashboard", quotaSource, token?.quotaAccount ?? null, env, context),
  });
  return {
    status: "fetched",
    mutation: {
      kind: "counts",
      updatedAt: observedAt,
      counts: result.repos,
      complete: result.complete,
    },
    repos: result.repos,
  };
}

export async function refreshOwnerCounts(
  env: Env,
  owner: string,
  requiredRepo?: string,
  context?: BackgroundContext,
): Promise<{
  status: "refreshed" | "missing" | "missing-repo" | "deferred";
  exact?: OwnerRepoCount;
}> {
  const snapshot = await readOwnerMetadata(env, owner);
  if (!snapshot) return { status: "missing" };
  const fetched = await fetchOwnerCounts(env, owner, context);
  if (fetched.status === "deferred") return { status: "deferred" };
  await mutateOwnerMetadataSnapshot(env, owner, fetched.mutation);
  await markHotCacheStale(env);
  const exact = requiredRepo
    ? fetched.repos.find((repo) => repo.fullName.toLowerCase() === requiredRepo.toLowerCase())
    : undefined;
  if (requiredRepo && !exact) return { status: "missing-repo" };
  return { status: "refreshed", exact };
}

// Refreshes the repository counts of the owners of `targets` that are due for it, at most
// `schedulerCountOwnerLimit` of them. The D1 queries do not grow with the owners: one tells
// which are due, one reads their snapshots and one batch writes them (and a read and a batch
// more for the owners something else changed meanwhile). `registry` is the installations of the
// targets' accounts, which the tick has read already; null when that read failed.
export async function refreshDueOwnerCounts(
  env: Env,
  context: BackgroundContext,
  targets: RefreshTarget[],
  now = Date.now(),
  registry?: InstallationRegistry | null,
): Promise<{
  considered: number;
  refreshed: number;
  deferred: number;
  failed: number;
}> {
  const owners = [
    ...new Set(
      targets
        .filter((target) => now - safeIso(target.lastSeenAt) < schedulerRecentViewMs)
        .flatMap((target) => [
          ...target.owners,
          ...target.repos.map((repo) => repo.split("/")[0] ?? ""),
        ])
        .map(slugOwner)
        .filter(validOwnerSlug),
    ),
  ];
  const [cursor, countTimes] = await Promise.all([
    readOwnerCountCursor(env),
    readOwnerCountTimes(env, owners),
  ]);
  const cursorIndex = cursor ? owners.indexOf(cursor) : -1;
  const rotatedOwners =
    cursorIndex >= 0
      ? [...owners.slice(cursorIndex + 1), ...owners.slice(0, cursorIndex + 1)]
      : owners;
  const due: string[] = [];
  for (const owner of rotatedOwners) {
    // An owner without a snapshot that counts is not in `countTimes`.
    if (
      countTimes.has(owner) &&
      now - safeIso(countTimes.get(owner)) >=
        schedulerCountRefreshMs + jitterMs(owner, 3 * 60 * 1000)
    ) {
      due.push(owner);
    }
    if (due.length >= schedulerCountOwnerLimit) break;
  }
  const lastDueOwner = due.at(-1);
  if (lastDueOwner !== undefined) {
    await writeOwnerCountCursor(env, lastDueOwner);
  }
  let refreshed = 0;
  let deferred = 0;
  const failures: Array<{ owner: string; error: unknown }> = [];
  const fetched: Array<{ owner: string; mutation: OwnerMetadataMutation }> = [];
  await mapConcurrent(due, schedulerCountConcurrency, async (owner) => {
    try {
      const result = await fetchOwnerCounts(env, owner, context, registry ?? undefined);
      if (result.status === "deferred") deferred += 1;
      else fetched.push({ owner, mutation: result.mutation });
    } catch (error) {
      failures.push({ owner, error });
    }
  });
  // The counts of all the owners are stored together. An owner whose snapshot went away
  // meanwhile has nothing to store them in and counts as neither refreshed nor failed.
  const stored = await mutateOwnerMetadataSnapshots(env, fetched).catch((error: unknown) =>
    fetched.map((): PromiseRejectedResult => ({ status: "rejected", reason: error })),
  );
  for (const [index, result] of stored.entries()) {
    if (result.status === "rejected") {
      failures.push({
        owner: fetched[index]?.owner ?? "",
        error: result.reason,
      });
    } else if (result.value) {
      refreshed += 1;
    }
  }
  if (refreshed > 0) {
    await markHotCacheStale(env).catch((error: unknown) => {
      console.warn("releasebar: marking the hot dashboard stale failed:", error);
    });
  }
  for (const { owner, error } of failures) {
    await auditSyncEvent(env, {
      event: "owner_counts_failed",
      status: "failed",
      account: owner,
      reason: errorMessage(error),
    });
  }
  return {
    considered: owners.length,
    refreshed,
    deferred,
    failed: failures.length,
  };
}

export async function schedulerTick(
  env: Env,
  context: BackgroundContext,
  cause: string,
  limit = schedulerBatchLimit,
): Promise<{ enqueued: number; considered: number; due: number }> {
  const [previousState, jobs, dueOptions] = await Promise.all([
    readSchedulerState(env),
    listRefreshJobs(env),
    schedulerDueOptions(env),
  ]);
  const page = await listRefreshTargets(env, schedulerTargetPageLimit, previousState?.targetCursor);
  const targets = page.targets;
  // The installations of every account on the page, read once: the owner counts and the due
  // check of each target ask them.
  const registry = appTokenConfigured(env)
    ? await installationRegistryFor(env, targets).catch(() => null)
    : null;
  const countRefresh = await refreshDueOwnerCounts(env, context, targets, dueOptions.now, registry);
  const activeTargetKeys = new Set(
    jobs.filter((job) => refreshJobActive(job)).map((job) => job.targetKey),
  );
  const pairs = await mapConcurrent(targets, 16, async (target) => ({
    target,
    cached: await readCached(env, target.key),
  }));
  const duePairs = await mapConcurrent(pairs, 16, async (pair) => ({
    ...pair,
    due: await schedulerTargetDue(env, pair.target, pair.cached, {
      ...dueOptions,
      registry,
    }),
  }));
  const due = duePairs
    .filter(({ due }) => due)
    .filter(({ target }) => !activeTargetKeys.has(target.key))
    .sort(
      (a, b) =>
        b.target.priority - a.target.priority ||
        safeIso(a.target.nextDueAt) - safeIso(b.target.nextDueAt),
    );
  const picked = due.slice(0, limit);
  const enqueued = (
    await enqueueRefreshJobs(
      env,
      context,
      picked.map(({ target, cached }) => ({
        target,
        reason: refreshReason(target, cached),
      })),
    )
  ).filter(Boolean).length;
  await writeSchedulerState(env, {
    lastTickAt: new Date().toISOString(),
    cause,
    considered: targets.length,
    due: due.length,
    enqueued,
    targetCursor: page.nextCursor,
    nextDueAt:
      targets
        .map((target) => target.nextDueAt)
        .filter((value) => safeIso(value) > 0)
        .sort()[0] ?? null,
    countRefresh,
  });
  // Nothing waits for the deletions: a tick that fails here deletes on the next one.
  await deleteExpiredRefreshData(env).catch((error: unknown) => {
    console.warn("releasebar: deleting expired refresh data failed:", error);
  });
  await auditScheduler(env, {
    event: "scheduler_tick",
    status: "ok",
    reason: cause,
    detail: `considered=${targets.length} active=${activeTargetKeys.size} due=${due.length} enqueued=${enqueued} counts=${countRefresh.refreshed}/${countRefresh.considered} countFailed=${countRefresh.failed}`,
  });
  return { enqueued, considered: targets.length, due: due.length };
}
