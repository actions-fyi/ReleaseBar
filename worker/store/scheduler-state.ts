// What the scheduler carries from one tick to the next: the summary of the last tick with the
// cursor into the refresh targets, and the owner whose repository counts were refreshed last.
//
// Each is a row of `scheduler_state` in D1, by name (migrations/0001_refresh.sql).

import { tryJsonParse } from "../schemas.ts";

export type StoredSchedulerState = {
  lastTickAt?: string;
  cause?: string;
  considered?: number;
  due?: number;
  enqueued?: number;
  targetCursor?: string;
  nextDueAt?: string | null;
  countRefresh?: { considered: number; refreshed: number; deferred: number; failed: number };
};

const lastTickName = "last-tick";
const ownerCountCursorName = "owner-count-cursor";

async function readState(env: Env, name: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM scheduler_state WHERE name = ?")
    .bind(name)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function writeState(env: Env, name: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO scheduler_state (name, updated_at, value) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET updated_at = excluded.updated_at, value = excluded.value`,
  )
    .bind(name, Date.now(), value)
    .run();
}

// The state as it was stored, not validated.
export async function readSchedulerState(env: Env): Promise<StoredSchedulerState | null> {
  const raw = await readState(env, lastTickName);
  return raw ? tryJsonParse<StoredSchedulerState>(raw, "refresh state") : null;
}

export function writeSchedulerState(env: Env, state: StoredSchedulerState): Promise<void> {
  return writeState(env, lastTickName, JSON.stringify(state));
}

export function readOwnerCountCursor(env: Env): Promise<string | null> {
  return readState(env, ownerCountCursorName);
}

export function writeOwnerCountCursor(env: Env, owner: string): Promise<void> {
  return writeState(env, ownerCountCursorName, owner);
}
