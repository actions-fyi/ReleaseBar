// Refresh jobs: one row of `refresh_jobs` per job, with the job as it was enqueued (its
// snapshot, which carries the target) and its latest state, and one row of
// `refresh_job_deliveries` per delivery of a job to the queue handler
// (migrations/0001_refresh.sql). D1 expires nothing by itself: `deleteExpiredRefreshJobs`
// deletes what has not changed for the job lifetime.

import type { RefreshJob } from "../../src/types.ts";
import { refreshJobListLimit } from "../config.ts";
import { tryJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

const refreshJobLifetimeMs = 14 * 24 * 60 * 60 * 1000;
const snapshotKeyPrefix = "refresh-job:";

type ValueRow = { value: string };

function parseJobs(rows: ValueRow[], context: string): RefreshJob[] {
  return rows
    .map((row) => tryJsonParse<RefreshJob>(row.value, context))
    .filter((job): job is RefreshJob => job !== null);
}

// What names the snapshot of a job: a job carries it as `targetSnapshotKey`.
export function refreshJobSnapshotKey(job: Pick<RefreshJob, "id">): string {
  return `${snapshotKeyPrefix}${job.id}`;
}

// Stores the latest state of a job.
export async function writeRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO refresh_jobs (id, target_key, created_at, updated_at, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, value = excluded.value`,
  )
    .bind(
      job.id,
      job.targetKey,
      safeIso(job.createdAt) || Date.now(),
      safeIso(job.updatedAt) || Date.now(),
      JSON.stringify(job),
    )
    .run();
}

// The latest state of a job as it was stored, not validated. Null for a job that was enqueued
// and has not been delivered yet: it has a snapshot only.
export async function readStoredRefreshJob(env: Env, id: string): Promise<RefreshJob | null> {
  const row = await env.DB.prepare("SELECT value FROM refresh_jobs WHERE id = ?")
    .bind(id)
    .first<{ value: string | null }>();
  return row?.value ? tryJsonParse<RefreshJob>(row.value, `refresh job ${id}`) : null;
}

// Records that a delivery of the job started.
export async function writeRefreshJobDelivery(env: Env, job: RefreshJob): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO refresh_job_deliveries (job_id, attempt, updated_at, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id, attempt) DO UPDATE
     SET updated_at = excluded.updated_at, value = excluded.value`,
  )
    .bind(job.id, job.attempts, safeIso(job.updatedAt) || Date.now(), JSON.stringify(job))
    .run();
}

// Stores the snapshot of a job as it is enqueued.
export async function indexRefreshJob(env: Env, job: RefreshJob): Promise<void> {
  const createdAt = safeIso(job.createdAt) || Date.now();
  await env.DB.prepare(
    `INSERT INTO refresh_jobs (id, target_key, created_at, updated_at, snapshot)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot`,
  )
    .bind(
      job.id,
      job.targetKey,
      createdAt,
      safeIso(job.updatedAt) || createdAt,
      JSON.stringify(job),
    )
    .run();
}

// The snapshot a job's `targetSnapshotKey` names, not validated. Null for any other key.
export async function readStoredRefreshJobSnapshot(
  env: Env,
  key: string,
): Promise<RefreshJob | null> {
  if (!key.startsWith(snapshotKeyPrefix)) return null;
  const row = await env.DB.prepare("SELECT snapshot FROM refresh_jobs WHERE id = ?")
    .bind(key.slice(snapshotKeyPrefix.length))
    .first<{ snapshot: string | null }>();
  return row?.snapshot
    ? tryJsonParse<RefreshJob>(row.snapshot, `refresh job snapshot ${key}`)
    : null;
}

// The newest jobs, each in its latest state, or as it was enqueued while it has none; not
// validated.
export async function listStoredRefreshJobs(env: Env): Promise<RefreshJob[]> {
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(value, snapshot) AS value FROM refresh_jobs
     WHERE COALESCE(value, snapshot) IS NOT NULL
     ORDER BY created_at DESC, id LIMIT ?`,
  )
    .bind(refreshJobListLimit)
    .all<ValueRow>();
  return parseJobs(results, "refresh job");
}

// The newest delivery records, not validated.
export async function listStoredRefreshJobDeliveries(env: Env): Promise<RefreshJob[]> {
  const { results } = await env.DB.prepare(
    `SELECT value FROM refresh_job_deliveries
     ORDER BY updated_at DESC, job_id, attempt LIMIT ?`,
  )
    .bind(refreshJobListLimit)
    .all<ValueRow>();
  return parseJobs(results, "refresh job delivery");
}

// Deletes up to `limit` jobs and up to `limit` delivery records that have not changed for the
// job lifetime, the oldest first. Returns how many rows it deleted.
export async function deleteExpiredRefreshJobs(env: Env, limit: number): Promise<number> {
  const cutoff = Date.now() - refreshJobLifetimeMs;
  const results = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM refresh_jobs WHERE id IN (
         SELECT id FROM refresh_jobs WHERE updated_at < ? ORDER BY updated_at LIMIT ?
       )`,
    ).bind(cutoff, limit),
    env.DB.prepare(
      `DELETE FROM refresh_job_deliveries WHERE (job_id, attempt) IN (
         SELECT job_id, attempt FROM refresh_job_deliveries
         WHERE updated_at < ? ORDER BY updated_at LIMIT ?
       )`,
    ).bind(cutoff, limit),
  ]);
  return results.reduce((total, result) => total + result.meta.changes, 0);
}
