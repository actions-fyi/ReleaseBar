import { DurableObject } from "cloudflare:workers";
import type { RefreshTarget } from "../../src/types.ts";
import { isStoredBuildProgress, storedBuildProgressExpired } from "../build-progress.ts";
import {
  buildLockTtlMs,
  refreshJobReservationTtlMs,
  type RefreshTargetMutation,
  type StoredBuildProgress,
  type StoredRefreshDirty,
} from "../config.ts";
import { safeIso } from "../owner-metadata-write.ts";
import { applyRefreshTargetMutation, isRefreshTarget } from "../refresh-targets.ts";
import { firstRow, parseStored } from "./sql.ts";

type LockRow = { token: string; expires_at: number };
type JobRow = { job_id: string; expires_at: number };
type DirtyRow = { observed_at: string; reason: string };
type JsonRow = { value: string };

// What the target was before the object first saw it, read from the cache by the caller: the
// object itself reads no binding. Null when the cache has no target either.
export type RefreshTargetSeed = { current: RefreshTarget | null };

// Coordinates the work on one dashboard. An instance is named by the dashboard's cache key, which
// is also its refresh target's key, and holds what must be checked and changed in one step: the
// build lock, the progress of the running build, the reservation of the target's refresh job with
// its dirty marker, and the target's scheduling state.
//
// No method awaits, so each one runs to completion before the next call starts and its writes
// commit together.
export class BuildCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Each table holds at most one row.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS build_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS build_progress (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_job (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        job_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_dirty (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        observed_at TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_target (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `);
  }

  // Takes the build lock for `token`. False when another token holds an unexpired lock.
  acquireLock(token: string): boolean {
    const existing = this.#lock();
    if (existing && existing.expires_at > Date.now()) return false;
    this.#putLock(token);
    return true;
  }

  // Extends the lock. False when `token` no longer holds it.
  refreshLock(token: string): boolean {
    if (this.#lock()?.token !== token) return false;
    this.#putLock(token);
    return true;
  }

  releaseLock(token: string): void {
    this.ctx.storage.sql.exec("DELETE FROM build_lock WHERE token = ?", token);
  }

  progress(): StoredBuildProgress | null {
    const row = firstRow(this.ctx.storage.sql.exec<JsonRow>("SELECT value FROM build_progress"));
    if (!row) return null;
    const progress = parseStored<StoredBuildProgress>(row.value);
    if (!isStoredBuildProgress(progress) || storedBuildProgressExpired(progress)) {
      this.deleteProgress();
      return null;
    }
    return progress;
  }

  putProgress(progress: StoredBuildProgress): void {
    if (!isStoredBuildProgress(progress)) throw new TypeError("invalid build progress");
    this.ctx.storage.sql.exec(
      `INSERT INTO build_progress (id, value) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value`,
      JSON.stringify(progress),
    );
  }

  deleteProgress(): void {
    this.ctx.storage.sql.exec("DELETE FROM build_progress");
  }

  // Reserves the target for one refresh job. False when another job holds an unexpired
  // reservation; `dirtyOnConflict` is then kept, unless a newer marker is, for that job to pick up
  // when it releases.
  reserveJob(jobId: string, dirtyOnConflict?: StoredRefreshDirty): boolean {
    const sql = this.ctx.storage.sql;
    const existing = this.#job();
    if (existing && existing.job_id !== jobId && existing.expires_at > Date.now()) {
      if (dirtyOnConflict) {
        const current = this.#dirty();
        if (!current || safeIso(dirtyOnConflict.observedAt) >= safeIso(current.observedAt)) {
          sql.exec(
            `INSERT INTO refresh_dirty (id, observed_at, reason) VALUES (1, ?, ?)
             ON CONFLICT (id) DO UPDATE
             SET observed_at = excluded.observed_at, reason = excluded.reason`,
            dirtyOnConflict.observedAt,
            dirtyOnConflict.reason,
          );
        }
      }
      return false;
    }
    sql.exec(
      `INSERT INTO refresh_job (id, job_id, expires_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET job_id = excluded.job_id, expires_at = excluded.expires_at`,
      jobId,
      Date.now() + refreshJobReservationTtlMs,
    );
    return true;
  }

  // Ends the reservation `jobId` holds. With `consumeDirty`, returns the dirty marker and clears
  // it. Does nothing for a job that holds no reservation.
  releaseJob(jobId: string, consumeDirty: boolean): StoredRefreshDirty | null {
    if (this.#job()?.job_id !== jobId) return null;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM refresh_job");
    if (!consumeDirty) return null;
    const dirty = this.#dirty();
    if (dirty) sql.exec("DELETE FROM refresh_dirty");
    return dirty;
  }

  // Whether a refresh job holds an unexpired reservation.
  jobActive(): boolean {
    const existing = this.#job();
    if (!existing) return false;
    if (existing.expires_at > Date.now()) return true;
    this.ctx.storage.sql.exec("DELETE FROM refresh_job");
    return false;
  }

  // Applies `mutation` to the target's stored state and returns the result. Returns null, and
  // changes nothing, when the object has no state for the target yet and the caller gave no
  // `seed`: the caller then reads the target from the cache and calls again with it.
  mutateTarget(
    snapshot: RefreshTarget | null,
    mutation: RefreshTargetMutation,
    seed?: RefreshTargetSeed,
  ): RefreshTarget | null {
    const sql = this.ctx.storage.sql;
    const row = firstRow(sql.exec<JsonRow>("SELECT value FROM refresh_target"));
    const stored = row ? parseStored<unknown>(row.value) : null;
    let current = isRefreshTarget(stored) ? stored : null;
    if (!current) {
      if (!seed) return null;
      current = seed.current;
    }
    const updated = applyRefreshTargetMutation(snapshot, current, mutation);
    sql.exec(
      `INSERT INTO refresh_target (id, value) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value`,
      JSON.stringify(updated),
    );
    return updated;
  }

  #lock(): LockRow | null {
    return firstRow(this.ctx.storage.sql.exec<LockRow>("SELECT token, expires_at FROM build_lock"));
  }

  #putLock(token: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO build_lock (id, token, expires_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
      token,
      Date.now() + buildLockTtlMs,
    );
  }

  #job(): JobRow | null {
    return firstRow(
      this.ctx.storage.sql.exec<JobRow>("SELECT job_id, expires_at FROM refresh_job"),
    );
  }

  #dirty(): StoredRefreshDirty | null {
    const row = firstRow(
      this.ctx.storage.sql.exec<DirtyRow>("SELECT observed_at, reason FROM refresh_dirty"),
    );
    return row ? { observedAt: row.observed_at, reason: row.reason } : null;
  }
}
