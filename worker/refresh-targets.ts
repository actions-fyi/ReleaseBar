import { slugOwner } from "../shared/dashboard.ts";
import type {
  DashboardPayload,
  DashboardProfile,
  RefreshJob,
  RefreshTarget,
  SchedulerAuditEvent,
} from "../src/types.ts";
import { collectAuditEvent } from "./audit-collector.ts";
import { randomNonce, sha256Base64Url } from "./crypto.ts";
import { jsonResponse } from "./http.ts";
import {
  type BackgroundContext,
  type GitHubWebhookFanoutJob,
  type GitHubWebhookJob,
} from "./runtime.ts";
import { tryJsonParse } from "./schemas.ts";
import {
  adminTargetListLimit,
  dashboardCachePrefix,
  refreshExpiryBatchLimit,
  localRefreshDirtyMarkers,
  refreshJobActiveGraceMs,
  refreshJobListLimit,
  refreshJobReservationTtlMs,
  refreshTargetEntryLimitBytes,
  type RefreshTargetMutation,
  schedulerActiveRefreshMs,
  schedulerDormantRefreshMs,
  schedulerRecentViewMs,
  schedulerRetryBaseMs,
  schedulerTargetPageLimit,
  type StoredRefreshDirty,
  webhookPriorityTargetLimit,
} from "./config.ts";
import { mutateCoordinatedTarget } from "./store/build-coordinator.ts";
import { rateLimitReached } from "./store/rate-limits.ts";
import type { RateLimitedEndpoint } from "./runtime.ts";
import { appendRefreshAuditEvent } from "./store/refresh-audit.ts";
import { mapConcurrent } from "./concurrency.ts";
import {
  deleteExpiredProfileSnapshots,
  ensureProfileSnapshots,
  ensureProfileSnapshot,
  profileSnapshotStorageKey,
  readProfileSnapshot,
} from "./store/profile-snapshots.ts";
import {
  deleteExpiredRefreshJobs,
  listStoredRefreshJobDeliveries,
  listStoredRefreshJobs,
  readStoredRefreshJob,
  readStoredRefreshJobSnapshot,
  refreshJobSnapshotKey,
} from "./store/refresh-jobs.ts";
import {
  countStoredRefreshTargets,
  deleteExpiredRefreshTargets,
  deleteRefreshTarget,
  deleteRefreshTargets,
  listStoredRefreshTargets,
  readStoredRefreshTarget,
  readStoredRefreshTargetsOf,
  type RefreshTargetSource,
  writeRefreshTarget,
  writeRefreshTargets,
} from "./store/refresh-targets.ts";
import { safeIso } from "./time.ts";
import { readProfile } from "./store/profiles.ts";

export function refreshTargetSources(target: RefreshTarget): RefreshTargetSource[] {
  return [
    ...new Set([
      ...target.owners.map((owner) => `owner:${slugOwner(owner)}`),
      ...(target.owner && target.owner !== "custom" ? [`owner:${slugOwner(target.owner)}`] : []),
      ...target.repos.map((repo) => `repo:${repo.toLowerCase()}`),
    ]),
  ].map((source) => {
    const separator = source.indexOf(":");
    return {
      kind: source.slice(0, separator) as "owner" | "repo",
      value: source.slice(separator + 1),
    };
  });
}

// Stores the target with the index of its sources. False when the store refused it: the target
// is too large, or one of its sources lists as many targets as it takes. A refused target is not
// kept.
export async function persistRefreshTarget(env: Env, target: RefreshTarget): Promise<boolean> {
  const written = await writeRefreshTarget(env, target, refreshTargetSources(target));
  if (written === "created" || written === "updated") return true;
  await deleteRefreshTarget(env, target.key);
  return false;
}

export function currentDashboardCacheKey(key: string): boolean {
  return key.startsWith(dashboardCachePrefix);
}

export function jitterMs(seed: string, windowMs: number): number {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % Math.max(1, windowMs);
}

export function nextRefreshAt(target: RefreshTarget, success: boolean): string {
  const now = Date.now();
  if (!success) {
    const failureDelay = schedulerRetryBaseMs * Math.max(1, Math.min(target.failureCount + 1, 8));
    return new Date(now + failureDelay + jitterMs(target.key, 15 * 60 * 1000)).toISOString();
  }
  const recentlyViewed = now - safeIso(target.lastSeenAt) < schedulerRecentViewMs;
  const base = recentlyViewed ? schedulerActiveRefreshMs : schedulerDormantRefreshMs;
  return new Date(now + base + jitterMs(target.key, Math.floor(base / 3))).toISOString();
}

export function isRefreshTarget(value: unknown): value is RefreshTarget {
  const target = value as RefreshTarget | null;
  return Boolean(
    target &&
    target.kind === "dashboard" &&
    typeof target.key === "string" &&
    typeof target.owner === "string" &&
    Array.isArray(target.owners) &&
    Array.isArray(target.repos) &&
    typeof target.path === "string" &&
    typeof target.nextDueAt === "string",
  );
}

export function isRefreshJob(value: unknown): value is RefreshJob {
  const job = value as RefreshJob | null;
  return Boolean(
    job &&
    job.kind === "dashboard" &&
    typeof job.id === "string" &&
    typeof job.targetKey === "string" &&
    typeof job.status === "string",
  );
}

export function isGitHubWebhookJob(value: unknown): value is GitHubWebhookJob {
  const job = value as GitHubWebhookJob | null;
  return Boolean(
    job &&
    job.kind === "github-webhook" &&
    typeof job.id === "string" &&
    typeof job.event === "string" &&
    typeof job.delivery === "string" &&
    (job.attempts === undefined || typeof job.attempts === "number") &&
    job.payload &&
    typeof job.payload === "object",
  );
}

export function isGitHubWebhookFanoutJob(value: unknown): value is GitHubWebhookFanoutJob {
  const job = value as GitHubWebhookFanoutJob | null;
  return Boolean(
    job &&
    job.kind === "github-webhook-fanout" &&
    typeof job.id === "string" &&
    typeof job.event === "string" &&
    typeof job.delivery === "string" &&
    typeof job.createdAt === "string" &&
    (job.source === "owner" || job.source === "repo") &&
    job.payload &&
    typeof job.payload === "object" &&
    job.action &&
    typeof job.action.reason === "string" &&
    typeof job.action.includeReleaseDataOnly === "boolean" &&
    typeof job.action.invalidateDashboard === "boolean" &&
    (job.priorityBatchStartedAt === undefined || typeof job.priorityBatchStartedAt === "string") &&
    (job.action.prioritizedTargetKeys === undefined ||
      (Array.isArray(job.action.prioritizedTargetKeys) &&
        job.action.prioritizedTargetKeys.length <= webhookPriorityTargetLimit &&
        job.action.prioritizedTargetKeys.every((key) => typeof key === "string"))),
  );
}

export function refreshJobActive(job: RefreshJob, now = Date.now()): boolean {
  return (
    (job.status === "queued" || job.status === "running") &&
    now - safeIso(job.updatedAt) <= refreshJobReservationTtlMs + refreshJobActiveGraceMs
  );
}

export function recordLocalRefreshDirty(targetKey: string, dirty: StoredRefreshDirty): void {
  const existing = localRefreshDirtyMarkers.get(targetKey);
  if (!existing || safeIso(dirty.observedAt) >= safeIso(existing.observedAt)) {
    localRefreshDirtyMarkers.set(targetKey, dirty);
  }
}

export function takeLocalRefreshDirty(targetKey: string): StoredRefreshDirty | null {
  const dirty = localRefreshDirtyMarkers.get(targetKey);
  if (!dirty) return null;
  localRefreshDirtyMarkers.delete(targetKey);
  return dirty;
}

export async function readRefreshTarget(env: Env, key: string): Promise<RefreshTarget | null> {
  const parsed = await readStoredRefreshTarget(env, key);
  return isRefreshTarget(parsed) ? parsed : null;
}

export function newerIso<T extends string | null>(left: T, right: T): T {
  return safeIso(right) > safeIso(left) ? right : left;
}

export function mergeRefreshTargetState(
  snapshot: RefreshTarget,
  current: RefreshTarget | null,
): RefreshTarget {
  if (!current) return snapshot;
  return {
    ...current,
    lastSeenAt: newerIso(snapshot.lastSeenAt, current.lastSeenAt),
    lastAttemptAt: newerIso(snapshot.lastAttemptAt, current.lastAttemptAt),
    lastSuccessAt: newerIso(snapshot.lastSuccessAt, current.lastSuccessAt),
  };
}

export function applyRefreshTargetMutation(
  snapshot: RefreshTarget | null,
  current: RefreshTarget | null,
  mutation: RefreshTargetMutation,
): RefreshTarget {
  if (mutation.kind === "observe") {
    const existing = current ?? snapshot;
    return {
      ...mutation.input,
      kind: "dashboard",
      profileSnapshotKey: mutation.profileProvided
        ? mutation.profileSnapshotKey
        : existing?.profileSnapshotKey,
      lastSeenAt: mutation.observedAt,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      nextDueAt:
        existing?.nextDueAt ??
        new Date(Date.now() + jitterMs(mutation.input.key, 60 * 60 * 1000)).toISOString(),
      failureCount: existing?.failureCount ?? 0,
      terminalBackoffUntil: existing?.terminalBackoffUntil ?? null,
      message: existing?.message,
    };
  }
  if (!snapshot) {
    throw new Error("refresh target snapshot required");
  }
  const target = mergeRefreshTargetState(snapshot, current);
  if (mutation.kind === "defer") {
    return {
      ...target,
      lastAttemptAt: mutation.at,
      nextDueAt: mutation.nextDueAt,
      message: mutation.message,
    };
  }
  if (mutation.kind === "success") {
    return {
      ...target,
      lastAttemptAt: mutation.at,
      lastSuccessAt: mutation.at,
      nextDueAt: nextRefreshAt(target, true),
      failureCount: 0,
      terminalBackoffUntil: null,
      message: mutation.message,
    };
  }
  const nextDueAt = nextRefreshAt(target, false);
  return {
    ...target,
    lastAttemptAt: mutation.at,
    nextDueAt,
    failureCount: target.failureCount + 1,
    terminalBackoffUntil: mutation.terminal ? nextDueAt : target.terminalBackoffUntil,
    message: mutation.message,
  };
}

export async function mutateRefreshTargetState(
  env: Env,
  snapshot: RefreshTarget | null,
  mutation: RefreshTargetMutation,
): Promise<RefreshTarget | null> {
  const key = mutation.kind === "observe" ? mutation.input.key : snapshot?.key;
  if (!key) {
    throw new Error("refresh target key required");
  }
  const observedCurrent = mutation.kind === "observe" ? await readRefreshTarget(env, key) : null;
  let coordinated: RefreshTarget | null = null;
  try {
    // The object answers null when it has no state for the target yet: it then needs what the
    // database holds, which an observation has read already.
    const updated =
      (await mutateCoordinatedTarget(
        env,
        key,
        snapshot,
        mutation,
        mutation.kind === "observe" ? { current: observedCurrent } : undefined,
      )) ??
      (await mutateCoordinatedTarget(env, key, snapshot, mutation, {
        current: await readRefreshTarget(env, key),
      }));
    if (isRefreshTarget(updated)) coordinated = updated;
  } catch {
    // The object can't be reached: the database alone keeps the target.
  }
  const updated =
    coordinated ??
    applyRefreshTargetMutation(
      snapshot,
      mutation.kind === "observe" ? observedCurrent : await readRefreshTarget(env, key),
      mutation,
    );
  return (await persistRefreshTarget(env, updated)) ? updated : null;
}

export async function rememberRefreshTarget(
  env: Env,
  input: Pick<
    RefreshTarget,
    "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
  > & { profile?: DashboardProfile | null },
): Promise<RefreshTarget | null> {
  if (new TextEncoder().encode(input.path).byteLength > refreshTargetEntryLimitBytes) {
    return null;
  }
  const now = new Date().toISOString();
  const { profile, ...targetInput } = input;
  const profileSnapshotKey =
    profile === undefined ? undefined : profile ? await ensureProfileSnapshot(env, profile) : null;
  return mutateRefreshTargetState(env, null, {
    kind: "observe",
    input: targetInput,
    observedAt: now,
    profileProvided: profile !== undefined,
    profileSnapshotKey,
  });
}

type RefreshTargetInput = Pick<
  RefreshTarget,
  "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
> & { profile?: DashboardProfile | null };

// How many targets are observed at once: each observation is a call to the dashboard's object.
const rememberConcurrency = 8;

// `rememberRefreshTarget` for many targets, with a bounded number of D1 queries, however many
// there are: the profile snapshots are one batch, the stored targets are one read, the limits
// one query, and the targets one batch for 25. Each target's state is still changed by its own
// dashboard's object. The results are in the order of `inputs`: null for a target that was not
// kept. A key that is given twice is remembered once, as the first input says.
export async function rememberRefreshTargets(
  env: Env,
  inputs: RefreshTargetInput[],
): Promise<Array<RefreshTarget | null>> {
  const byKey = new Map<string, RefreshTargetInput>();
  for (const input of inputs) {
    if (
      !byKey.has(input.key) &&
      new TextEncoder().encode(input.path).byteLength <= refreshTargetEntryLimitBytes
    ) {
      byKey.set(input.key, input);
    }
  }
  const accepted = [...byKey.values()];
  const remembered = new Map<string, RefreshTarget | null>();
  if (accepted.length > 0) {
    const now = new Date().toISOString();
    const profiles = accepted.flatMap((input) => (input.profile ? [input.profile] : []));
    if (profiles.length > 0) await ensureProfileSnapshots(env, profiles);
    const stored = await readStoredRefreshTargetsOf(
      env,
      accepted.map((input) => input.key),
    );
    const updated = await mapConcurrent(accepted, rememberConcurrency, async (input) => {
      const { profile, ...targetInput } = input;
      const mutation: RefreshTargetMutation = {
        kind: "observe",
        input: targetInput,
        observedAt: now,
        profileProvided: profile !== undefined,
        profileSnapshotKey:
          profile === undefined ? undefined : profile ? profileSnapshotStorageKey(profile) : null,
      };
      const candidate = stored.get(input.key);
      const current = isRefreshTarget(candidate) ? candidate : null;
      try {
        const coordinated = await mutateCoordinatedTarget(env, input.key, null, mutation, {
          current,
        });
        if (isRefreshTarget(coordinated)) return coordinated;
      } catch {
        // The object can't be reached: the database alone keeps the target.
      }
      return applyRefreshTargetMutation(null, current, mutation);
    });
    const written = await writeRefreshTargets(
      env,
      updated.map((target) => ({
        target,
        sources: refreshTargetSources(target),
      })),
    );
    const refused: string[] = [];
    for (const [index, target] of updated.entries()) {
      const kept = written[index] === "created" || written[index] === "updated";
      remembered.set(target.key, kept ? target : null);
      if (!kept) refused.push(target.key);
    }
    // A refused target is not kept, as in `persistRefreshTarget`.
    await deleteRefreshTargets(env, refused);
  }
  return inputs.map((input) => remembered.get(input.key) ?? null);
}

export async function refreshTargetProfile(
  env: Env,
  target: RefreshTarget,
  cached: DashboardPayload | null,
): Promise<DashboardProfile | null | undefined> {
  if (target.profileSnapshotKey === null) return null;
  if (!target.profileSnapshotKey) return cached?.profile ?? null;
  const snapshot = await readProfileSnapshot(env, target.profileSnapshotKey);
  if (snapshot) return snapshot;
  const current = await readProfile(env, target.owner);
  if (current && profileSnapshotStorageKey(current) === target.profileSnapshotKey) {
    await ensureProfileSnapshot(env, current).catch(() => undefined);
    return current;
  }
  return undefined;
}

export async function listRefreshTargets(
  env: Env,
  limit = schedulerTargetPageLimit,
  cursor?: string,
): Promise<{ targets: RefreshTarget[]; nextCursor?: string }> {
  const page = await listStoredRefreshTargets(env, limit, cursor);
  return {
    targets: page.targets.filter(
      (target) => isRefreshTarget(target) && currentDashboardCacheKey(target.key),
    ),
    nextCursor: page.nextCursor,
  };
}

export async function refreshTargetInventory(
  env: Env,
  sampleLimit = adminTargetListLimit,
): Promise<{ total: number; targets: RefreshTarget[] }> {
  const { total, targets } = await countStoredRefreshTargets(env, sampleLimit);
  return {
    total,
    targets: targets.filter(
      (target) => isRefreshTarget(target) && currentDashboardCacheKey(target.key),
    ),
  };
}

export async function readRefreshJobSnapshot(env: Env, key: string): Promise<RefreshJob | null> {
  const parsed = await readStoredRefreshJobSnapshot(env, key);
  return isRefreshJob(parsed) ? parsed : null;
}

export async function readRefreshJob(env: Env, id: string): Promise<RefreshJob | null> {
  const parsed = await readStoredRefreshJob(env, id);
  return isRefreshJob(parsed) ? parsed : null;
}

export async function listRefreshJobs(env: Env): Promise<RefreshJob[]> {
  const jobs = new Map<string, RefreshJob>();
  const [stored, deliveries] = await Promise.all([
    listStoredRefreshJobs(env),
    listStoredRefreshJobDeliveries(env),
  ]);
  for (const job of stored) {
    if (isRefreshJob(job)) jobs.set(job.id, job);
  }
  // A delivery that is still running has written no job state yet: its record is the newest.
  for (const delivery of deliveries) {
    if (!isRefreshJob(delivery)) continue;
    const current = jobs.get(delivery.id);
    if (!current || safeIso(delivery.updatedAt) > safeIso(current.updatedAt)) {
      jobs.set(delivery.id, delivery);
    }
  }
  return [...jobs.values()]
    .sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt))
    .slice(0, refreshJobListLimit);
}

// D1 keeps a row until it is deleted. Each scheduler tick deletes a bounded number of the
// targets, jobs, delivery records and profile snapshots that are past their lifetime, so a
// backlog is worked off over several ticks.
export async function deleteExpiredRefreshData(env: Env): Promise<void> {
  await Promise.all([
    deleteExpiredRefreshTargets(env, refreshExpiryBatchLimit),
    deleteExpiredRefreshJobs(env, refreshExpiryBatchLimit),
    deleteExpiredProfileSnapshots(env, refreshExpiryBatchLimit),
  ]);
}

export async function auditScheduler(
  env: Env,
  event: Omit<SchedulerAuditEvent, "id" | "at">,
): Promise<void> {
  const item: SchedulerAuditEvent = {
    id: randomNonce(),
    at: new Date().toISOString(),
    ...event,
  };
  console.log(JSON.stringify({ area: "scheduler", ...item }));
  // The events of a request or job are written as one batch; without a collector, at once.
  if (!collectAuditEvent(env, item)) await appendRefreshAuditEvent(env, item);
}

export function dashboardSyncDetail(payload: DashboardPayload | null, extra = ""): string {
  const cache = payload?.cache;
  const progress = cache?.progress;
  return [
    cache?.state ? `state=${cache.state}` : "state=missing",
    `projects=${payload?.projects.length ?? 0}`,
    progress ? `scanned=${progress.scanned}/${progress.limit}` : "",
    progress ? `done=${progress.done}` : "",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export function auditDashboardSync(
  context: BackgroundContext,
  env: Env,
  event: Omit<SchedulerAuditEvent, "id" | "at">,
): void {
  context.waitUntil(auditSyncEvent(env, event));
}

export async function auditSyncEvent(
  env: Env,
  event: Omit<SchedulerAuditEvent, "id" | "at">,
): Promise<void> {
  await auditScheduler(env, event).catch(() => undefined);
}

export function timingNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 10 * 60 * 1000) return undefined;
  return Math.round(value);
}

export function timingText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 160) : fallback;
}

export function timingPath(value: unknown): string {
  const path = timingText(value, "/");
  return path.startsWith("/") ? path.slice(0, 160) : "/";
}

export function timingBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function timingDetail(input: Record<string, unknown>): string {
  const pairs: Array<[string, string | number | boolean | null | undefined]> = [
    ["source", timingText(input.source, "unknown")],
    ["path", timingPath(input.path)],
    ["api", timingPath(input.apiPath)],
    ["route", timingText(input.route)],
    ["attempt", timingNumber(input.attempt)],
    ["http", timingNumber(input.httpStatus)],
    ["cache", timingText(input.cacheState)],
    ["headerMs", timingNumber(input.headerMs)],
    ["bodyMs", timingNumber(input.bodyMs)],
    ["renderMs", timingNumber(input.renderMs)],
    ["streamMs", timingNumber(input.streamMs)],
    ["totalMs", timingNumber(input.totalMs)],
    ["navTtfbMs", timingNumber(input.navigationTtfbMs)],
    ["navInteractiveMs", timingNumber(input.navigationInteractiveMs)],
  ];
  return pairs
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

// Counts the request against the endpoint's limit per client and minute. True when the client
// reached the limit already. Rejects when the limiter can't be reached: each endpoint decides
// what that means for it.
export async function clientRateLimited(
  request: Request,
  env: Env,
  endpoint: RateLimitedEndpoint,
  limit: number,
): Promise<boolean> {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client =
    request.headers.get("cf-connecting-ip") ??
    forwardedFor ??
    request.headers.get("user-agent") ??
    "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const id = (await sha256Base64Url(client)).slice(0, 16);
  return rateLimitReached(env, endpoint, id, minute, limit);
}

const clientTimingLimitPerMinute = 30;

export async function clientTimingResponse(
  request: Request,
  env: Env,
  context: BackgroundContext,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ error: "forbidden" }, 403, {
      "cache-control": "no-store",
    });
  }
  let limited: boolean;
  try {
    limited = await clientRateLimited(request, env, "client-timing", clientTimingLimitPerMinute);
  } catch (error) {
    // A timing sample is not worth an error in the browser, and without the limiter nothing
    // bounds what one client can write: the sample is dropped and the answer is the usual one.
    console.warn(`client timing dropped: rate limiter unavailable: ${String(error)}`);
    return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
  }
  if (limited) {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }
  const raw = await request.text().catch(() => "");
  if (raw.length > 2048) {
    return jsonResponse({ error: "payload too large" }, 413, {
      "cache-control": "no-store",
    });
  }
  const input = tryJsonParse<Record<string, unknown>>(raw, "client timing");
  if (!input || typeof input !== "object") {
    return jsonResponse({ error: "invalid timing" }, 400, {
      "cache-control": "no-store",
    });
  }
  const cacheState = timingText(input.cacheState, "ok");
  auditDashboardSync(context, env, {
    event: "client_dashboard_timing",
    status: cacheState,
    source: "browser",
    reason: timingText(input.source, "unknown"),
    durationMs: timingNumber(input.totalMs),
    projects: timingNumber(input.projects),
    scanned: timingNumber(input.scanned),
    limit: timingNumber(input.limit),
    done: timingBool(input.done),
    detail: timingDetail(input),
  });
  return jsonResponse({ ok: true }, 202, { "cache-control": "no-store" });
}

export function refreshJob(target: RefreshTarget, reason: string): RefreshJob {
  const now = new Date().toISOString();
  const job: RefreshJob = {
    id: randomNonce(),
    targetKey: target.key,
    target,
    kind: target.kind,
    status: "queued",
    reason,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  job.targetSnapshotKey = refreshJobSnapshotKey(job);
  return job;
}
