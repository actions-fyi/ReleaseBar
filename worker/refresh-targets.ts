import { slugOwner } from "../shared/dashboard.ts";
import type {
  DashboardPayload,
  DashboardProfile,
  RefreshJob,
  RefreshTarget,
  SchedulerAuditEvent,
} from "../src/types.ts";
import { mapConcurrent } from "./concurrency.ts";
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
  durableRefreshTargetEntryLimitBytes,
  localRefreshDirtyMarkers,
  localRefreshJobReservations,
  localRefreshReservationFallbackScope,
  refreshAuditListLimit,
  refreshJobActiveGraceMs,
  refreshJobListLimit,
  refreshJobReservationTtlMs,
  refreshTargetIndexBackfillLimit,
  refreshTargetIndexVersion,
  type RefreshTargetMutation,
  schedulerActiveRefreshMs,
  schedulerDormantRefreshMs,
  schedulerRecentViewMs,
  schedulerRetryBaseMs,
  schedulerTargetPageLimit,
  type StoredRefreshDirty,
  type StoredRefreshJobReservation,
  webhookPriorityTargetLimit,
} from "./config.ts";
import {
  ensureProfileSnapshot,
  profileSnapshotStorageKey,
  readProfile,
  readProfileSnapshot,
} from "./dashboard-cache.ts";
import { safeIso } from "./owner-metadata-write.ts";
import { mutateCoordinatedTarget } from "./store/build-coordinator.ts";
import { cacheIdentity } from "./store/cache.ts";
import { rateLimitReached } from "./store/rate-limits.ts";
import {
  appendRefreshAuditEvent,
  isAuditEvent,
  listRefreshAuditEvents,
  refreshAuditStorageKey,
} from "./store/refresh-audit.ts";
import {
  indexRefreshJob,
  listStoredRefreshJobDeliveries,
  listStoredRefreshJobSnapshots,
  readLegacyRefreshJobIds,
  readStoredRefreshJob,
  readStoredRefreshJobSnapshot,
  refreshJobDeliveryStorageKey,
  refreshJobIndexStorageKey,
  refreshJobStorageKey,
  writeRefreshJob,
  writeRefreshJobDelivery,
} from "./store/refresh-jobs.ts";
import {
  countStoredRefreshTargets,
  deleteRefreshTarget,
  listStoredRefreshTargets,
  readStoredRefreshTarget,
  refreshTargetIndexSource,
  refreshTargetStorageKey,
  removeIndexedRefreshTarget,
  upsertIndexedRefreshTarget,
  writeRefreshTarget,
  writeRefreshTargetKeyIndex,
} from "./store/refresh-targets.ts";

export { refreshTargetIndexSource, refreshTargetStorageKey, writeRefreshTarget };
export { indexRefreshJob, writeRefreshJob, writeRefreshJobDelivery };
export { refreshJobDeliveryStorageKey, refreshJobIndexStorageKey, refreshJobStorageKey };
export { isAuditEvent, refreshAuditStorageKey };

export function refreshTargetSources(target: RefreshTarget): Array<{
  kind: "owner" | "repo";
  value: string;
}> {
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

export type RefreshTargetIndexWrite = "accepted" | "rejected" | "unavailable";

export async function writeDurableRefreshTargetIndexes(
  env: Env,
  target: RefreshTarget,
): Promise<RefreshTargetIndexWrite> {
  try {
    const writes = await Promise.all(
      refreshTargetSources(target).map(async (source) => {
        try {
          return { source, result: await upsertIndexedRefreshTarget(env, source, target) };
        } catch {
          return { source, result: null };
        }
      }),
    );
    if (writes.every(({ result }) => result === "created" || result === "updated")) {
      return "accepted";
    }
    // Take the target back out of the indexes this write added it to.
    await Promise.allSettled(
      writes
        .filter(({ result }) => result === "created")
        .map(async ({ source }) => {
          await removeIndexedRefreshTarget(env, source, target.key);
        }),
    );
    return writes.some(({ result }) => result === "full") ? "rejected" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function writeRefreshTargetIndexes(
  env: Env,
  target: RefreshTarget,
): Promise<RefreshTargetIndexWrite> {
  const sources = refreshTargetSources(target);
  const durableIndex = await writeDurableRefreshTargetIndexes(env, target);
  if (durableIndex === "rejected") return durableIndex;
  await writeRefreshTargetKeyIndex(env, sources, target.key);
  return durableIndex;
}

export async function persistRefreshTargetWithIndexes(
  env: Env,
  target: RefreshTarget,
  options: { requireAdmission?: boolean } = {},
): Promise<{ target: RefreshTarget; persisted: boolean }> {
  const indexed = { ...target, indexVersion: refreshTargetIndexVersion };
  const indexWrite = await writeRefreshTargetIndexes(env, indexed);
  const admissionFailed =
    indexWrite === "rejected" ||
    (options.requireAdmission === true && indexWrite === "unavailable");
  if (admissionFailed) {
    await deleteRefreshTarget(env, target.key);
    return { target: { ...target, indexVersion: undefined }, persisted: false };
  }
  const persisted = indexWrite === "accepted" ? indexed : { ...target, indexVersion: undefined };
  await writeRefreshTarget(env, persisted);
  return { target: persisted, persisted: true };
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

export function isRefreshTargetMutation(value: unknown): value is RefreshTargetMutation {
  const mutation = value as RefreshTargetMutation | null;
  if (!mutation || typeof mutation !== "object" || typeof mutation.kind !== "string") return false;
  if (mutation.kind === "observe") {
    return Boolean(
      mutation.input &&
      typeof mutation.input.key === "string" &&
      typeof mutation.observedAt === "string" &&
      typeof mutation.profileProvided === "boolean",
    );
  }
  if (mutation.kind === "defer") {
    return (
      typeof mutation.at === "string" &&
      typeof mutation.nextDueAt === "string" &&
      typeof mutation.message === "string"
    );
  }
  if (mutation.kind === "success") {
    return typeof mutation.at === "string";
  }
  return (
    mutation.kind === "failure" &&
    typeof mutation.at === "string" &&
    typeof mutation.message === "string" &&
    typeof mutation.terminal === "boolean"
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
    (job.source === "indexed" ||
      job.source === "owner" ||
      job.source === "repo" ||
      job.source === "kv-owner" ||
      job.source === "kv-repo" ||
      job.source === "legacy") &&
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

export function localRefreshJobReservationStore(
  env: Env,
): Map<string, StoredRefreshJobReservation> {
  const scope = cacheIdentity(env) ?? localRefreshReservationFallbackScope;
  const existing = localRefreshJobReservations.get(scope);
  if (existing) return existing;
  const created = new Map<string, StoredRefreshJobReservation>();
  localRefreshJobReservations.set(scope, created);
  return created;
}

export function localRefreshDirtyMarkerStore(env: Env): Map<string, StoredRefreshDirty> {
  const scope = cacheIdentity(env) ?? localRefreshReservationFallbackScope;
  const existing = localRefreshDirtyMarkers.get(scope);
  if (existing) return existing;
  const created = new Map<string, StoredRefreshDirty>();
  localRefreshDirtyMarkers.set(scope, created);
  return created;
}

export function recordLocalRefreshDirty(
  env: Env,
  targetKey: string,
  dirty: StoredRefreshDirty,
): void {
  const markers = localRefreshDirtyMarkerStore(env);
  const existing = markers.get(targetKey);
  if (!existing || safeIso(dirty.observedAt) >= safeIso(existing.observedAt)) {
    markers.set(targetKey, dirty);
  }
}

export function takeLocalRefreshDirty(env: Env, targetKey: string): StoredRefreshDirty | null {
  const markers = localRefreshDirtyMarkerStore(env);
  const dirty = markers.get(targetKey);
  if (!dirty) return null;
  markers.delete(targetKey);
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
  const requireAdmission = mutation.kind === "observe" && observedCurrent === null;
  try {
    // The object answers null when it has no state for the target yet: it then needs what the
    // cache holds, which an observation has read already.
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
    if (isRefreshTarget(updated)) {
      const persisted = await persistRefreshTargetWithIndexes(env, updated, {
        requireAdmission,
      });
      return persisted.persisted ? persisted.target : null;
    }
  } catch {
    // The object can't be reached: the cache alone keeps the target.
  }
  const current = mutation.kind === "observe" ? observedCurrent : await readRefreshTarget(env, key);
  const updated = applyRefreshTargetMutation(snapshot, current, mutation);
  const persisted = await persistRefreshTargetWithIndexes(env, updated, {
    requireAdmission,
  });
  return persisted.persisted ? persisted.target : null;
}

export async function rememberRefreshTarget(
  env: Env,
  input: Pick<
    RefreshTarget,
    "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
  > & { profile?: DashboardProfile | null },
): Promise<RefreshTarget | null> {
  if (new TextEncoder().encode(input.path).byteLength > durableRefreshTargetEntryLimitBytes) {
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
  const page = await listStoredRefreshTargets(env, "current", limit, cursor);
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

export async function backfillRefreshTargetIndexes(
  env: Env,
  targets: RefreshTarget[],
): Promise<void> {
  const pending = targets.filter((target) => target.indexVersion !== refreshTargetIndexVersion);
  const batch = pending.slice(0, refreshTargetIndexBackfillLimit);
  await mapConcurrent(batch, 4, (target) => persistRefreshTargetWithIndexes(env, target));
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
  const [snapshots, deliveries] = await Promise.all([
    listStoredRefreshJobSnapshots(env),
    listStoredRefreshJobDeliveries(env),
  ]);
  await Promise.all(
    snapshots.map(async (indexed) => {
      if (!isRefreshJob(indexed)) return;
      jobs.set(indexed.id, (await readRefreshJob(env, indexed.id)) ?? indexed);
    }),
  );
  for (const delivery of deliveries) {
    if (!isRefreshJob(delivery)) continue;
    const current = jobs.get(delivery.id);
    if (!current || safeIso(delivery.updatedAt) > safeIso(current.updatedAt)) {
      jobs.set(delivery.id, delivery);
    }
  }
  if (jobs.size < refreshJobListLimit) {
    const legacyIds = await readLegacyRefreshJobIds(env);
    await Promise.all(
      legacyIds.slice(0, refreshJobListLimit - jobs.size).map(async (id) => {
        const job = await readRefreshJob(env, id);
        if (job) jobs.set(job.id, job);
      }),
    );
  }
  return [...jobs.values()]
    .sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt))
    .slice(0, refreshJobListLimit);
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
  await appendRefreshAuditEvent(env, item);
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

export async function clientTimingRateLimited(request: Request, env: Env): Promise<boolean> {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client =
    request.headers.get("cf-connecting-ip") ??
    forwardedFor ??
    request.headers.get("user-agent") ??
    "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const id = (await sha256Base64Url(client)).slice(0, 16);
  return rateLimitReached(env, "client-timing", id, minute, 30);
}

export async function authInstallCallbackRateLimited(request: Request, env: Env): Promise<boolean> {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client =
    request.headers.get("cf-connecting-ip") ??
    forwardedFor ??
    request.headers.get("user-agent") ??
    "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const id = (await sha256Base64Url(client)).slice(0, 16);
  return rateLimitReached(env, "install-callback", id, minute, 6);
}

export async function clientTimingResponse(
  request: Request,
  env: Env,
  context: BackgroundContext,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ error: "forbidden" }, 403, { "cache-control": "no-store" });
  }
  if (await clientTimingRateLimited(request, env)) {
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  const raw = await request.text().catch(() => "");
  if (raw.length > 2048) {
    return jsonResponse({ error: "payload too large" }, 413, { "cache-control": "no-store" });
  }
  const input = tryJsonParse<Record<string, unknown>>(raw, "client timing");
  if (!input || typeof input !== "object") {
    return jsonResponse({ error: "invalid timing" }, 400, { "cache-control": "no-store" });
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

export function listCurrentAuditEvents(env: Env): Promise<SchedulerAuditEvent[]> {
  return listRefreshAuditEvents(env, refreshAuditListLimit);
}

export async function listAuditEvents(env: Env): Promise<SchedulerAuditEvent[]> {
  return (await listCurrentAuditEvents(env))
    .filter((event): event is SchedulerAuditEvent => Boolean(event))
    .sort((a, b) => safeIso(b.at) - safeIso(a.at))
    .slice(0, refreshAuditListLimit);
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
  job.targetSnapshotKey = refreshJobIndexStorageKey(job);
  return job;
}
