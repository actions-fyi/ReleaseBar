// What the scheduler carries from one tick to the next: the summary of the last tick with the
// cursor into the refresh targets, and the owner whose repository counts were refreshed last.
//
// Both are KV entries. Step 7a of the stack migration moves them to D1
// (docs/data-model.md).

import {
  dashboardStorageTtlSeconds,
  refreshOwnerCountCursorKey,
  refreshStateKey,
} from "../config.ts";
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

// The state as it was stored, not validated.
export async function readSchedulerState(env: Env): Promise<StoredSchedulerState | null> {
  const raw = await env.DASHBOARD_CACHE.get(refreshStateKey);
  return raw ? tryJsonParse<StoredSchedulerState>(raw, "refresh state") : null;
}

export async function writeSchedulerState(env: Env, state: StoredSchedulerState): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshStateKey, JSON.stringify(state), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export function readOwnerCountCursor(env: Env): Promise<string | null> {
  return env.DASHBOARD_CACHE.get(refreshOwnerCountCursorKey);
}

export async function writeOwnerCountCursor(env: Env, owner: string): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshOwnerCountCursorKey, owner);
}
