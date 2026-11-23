// Refresh jobs: one record per job, a snapshot of each job as it was enqueued, listed newest
// first, and a record of each delivery of a job to the queue handler.
//
// All three are KV entries. Step 7a of the stack migration moves them to D1
// (docs/data-model.md).

import type { RefreshJob } from "../../src/types.ts";
import {
  legacyRefreshJobIndexKey,
  refreshJobDeliveryPrefix,
  refreshJobIndexPrefix,
  refreshJobListLimit,
  refreshJobPrefix,
} from "../config.ts";
import { tryJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

const refreshJobTtlSeconds = 14 * 24 * 60 * 60;

function newestFirst(at: string): string {
  const timestamp = safeIso(at) || Date.now();
  return String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
}

export function refreshJobStorageKey(id: string): string {
  return `${refreshJobPrefix}${id}`;
}

// Where the snapshot of a job is stored: a job carries it as `targetSnapshotKey`.
export function refreshJobIndexStorageKey(job: Pick<RefreshJob, "id" | "createdAt">): string {
  return `${refreshJobIndexPrefix}${newestFirst(job.createdAt)}:${job.id}`;
}

export function refreshJobDeliveryStorageKey(job: RefreshJob): string {
  return `${refreshJobDeliveryPrefix}${newestFirst(job.updatedAt)}:${job.id}:${job.attempts}`;
}

export async function writeRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshJobStorageKey(job.id), JSON.stringify(job), {
    expirationTtl: refreshJobTtlSeconds,
  });
}

// The job as it was stored, not validated.
export async function readStoredRefreshJob(env: Env, id: string): Promise<RefreshJob | null> {
  const raw = await env.DASHBOARD_CACHE.get(refreshJobStorageKey(id));
  if (!raw) return null;
  return tryJsonParse<RefreshJob>(raw, `refresh job ${id}`);
}

export async function writeRefreshJobDelivery(env: Env, job: RefreshJob): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshJobDeliveryStorageKey(job), JSON.stringify(job), {
    expirationTtl: refreshJobTtlSeconds,
  });
}

// Stores the snapshot of a job as it is enqueued.
export async function indexRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshJobIndexStorageKey(job), JSON.stringify(job), {
    expirationTtl: refreshJobTtlSeconds,
  });
}

// The snapshot a job's `targetSnapshotKey` names, not validated. Null for any other key.
export async function readStoredRefreshJobSnapshot(
  env: Env,
  key: string,
): Promise<RefreshJob | null> {
  if (!key.startsWith(refreshJobIndexPrefix)) return null;
  const raw = await env.DASHBOARD_CACHE.get(key);
  if (!raw) return null;
  return tryJsonParse<RefreshJob>(raw, `refresh job snapshot ${key}`);
}

async function listStoredJobs(env: Env, prefix: string, context: string): Promise<RefreshJob[]> {
  const page = await env.DASHBOARD_CACHE.list({ prefix, limit: refreshJobListLimit });
  const jobs = await Promise.all(
    page.keys.slice(0, refreshJobListLimit).map(async (key) => {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      return raw ? tryJsonParse<RefreshJob>(raw, `${context} ${key.name}`) : null;
    }),
  );
  return jobs.filter((job): job is RefreshJob => job !== null);
}

// The newest job snapshots, not validated.
export function listStoredRefreshJobSnapshots(env: Env): Promise<RefreshJob[]> {
  return listStoredJobs(env, refreshJobIndexPrefix, "refresh job index");
}

// The newest delivery records, not validated.
export function listStoredRefreshJobDeliveries(env: Env): Promise<RefreshJob[]> {
  return listStoredJobs(env, refreshJobDeliveryPrefix, "refresh job delivery");
}

// The job IDs of the list that came before the snapshots.
export async function readLegacyRefreshJobIds(env: Env): Promise<string[]> {
  const raw = await env.DASHBOARD_CACHE.get(legacyRefreshJobIndexKey);
  if (!raw) return [];
  const parsed = tryJsonParse<string[]>(raw, legacyRefreshJobIndexKey);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}
