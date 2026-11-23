// Profile snapshots: the dashboard profile as it was when a refresh target was remembered, so a
// refresh builds what the visitor saw. A target carries its snapshot's key as
// `profileSnapshotKey`.
//
// A snapshot is a KV entry. Step 7a of the stack migration moves them to D1
// (docs/data-model.md).

import { slugOwner } from "../../shared/dashboard.ts";
import type { DashboardProfile } from "../../src/types.ts";
import { dashboardStorageTtlSeconds, refreshProfileSnapshotPrefix } from "../config.ts";
import { tryJsonParse } from "../schemas.ts";

export function profileSnapshotStorageKey(profile: DashboardProfile): string {
  return `${refreshProfileSnapshotPrefix}${slugOwner(profile.owner)}:${encodeURIComponent(profile.updatedAt)}`;
}

// The snapshot a target's `profileSnapshotKey` names. Null for any other key.
export async function readProfileSnapshot(env: Env, key: string): Promise<DashboardProfile | null> {
  if (!key.startsWith(refreshProfileSnapshotPrefix)) return null;
  const raw = await env.DASHBOARD_CACHE.get(key);
  if (!raw) return null;
  const parsed = tryJsonParse<DashboardProfile>(raw, `profile snapshot ${key}`);
  return parsed?.owner ? parsed : null;
}

export async function writeProfileSnapshot(env: Env, profile: DashboardProfile): Promise<void> {
  await env.DASHBOARD_CACHE.put(profileSnapshotStorageKey(profile), JSON.stringify(profile), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

// Stores the snapshot of `profile` unless it is stored already. Returns its key.
export async function ensureProfileSnapshot(env: Env, profile: DashboardProfile): Promise<string> {
  const key = profileSnapshotStorageKey(profile);
  if (!(await env.DASHBOARD_CACHE.get(key))) {
    await env.DASHBOARD_CACHE.put(key, JSON.stringify(profile), {
      expirationTtl: dashboardStorageTtlSeconds,
    });
  }
  return key;
}
