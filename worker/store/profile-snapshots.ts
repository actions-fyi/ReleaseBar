// Profile snapshots: the dashboard profile as it was when a refresh target was remembered, so a
// refresh builds what the visitor saw. A target carries its snapshot's key as
// `profileSnapshotKey`.
//
// A snapshot is a row of `profile_snapshots` in D1 (migrations/0001_refresh.sql). D1 expires
// nothing by itself: `deleteExpiredProfileSnapshots` deletes the snapshots written before the
// storage lifetime. A target whose snapshot is gone builds with the owner's profile, if that is
// still the one the key names.

import { slugOwner } from "../../shared/dashboard.ts";
import type { DashboardProfile } from "../../src/types.ts";
import { dashboardStorageTtlSeconds } from "../config.ts";
import { tryJsonParse } from "../schemas.ts";

const snapshotKeyPrefix = "profile-snapshot:";

// What names the snapshot of `profile`: its owner and the time it was last changed.
export function profileSnapshotStorageKey(profile: DashboardProfile): string {
  return `${snapshotKeyPrefix}${slugOwner(profile.owner)}:${encodeURIComponent(profile.updatedAt)}`;
}

// The snapshot a target's `profileSnapshotKey` names. Null for any other key.
export async function readProfileSnapshot(env: Env, key: string): Promise<DashboardProfile | null> {
  if (!key.startsWith(snapshotKeyPrefix)) return null;
  const row = await env.DB.prepare("SELECT value FROM profile_snapshots WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  if (!row) return null;
  const parsed = tryJsonParse<DashboardProfile>(row.value, `profile snapshot ${key}`);
  return parsed?.owner ? parsed : null;
}

// Stores the snapshot of `profile`, in place of one stored already.
export async function writeProfileSnapshot(env: Env, profile: DashboardProfile): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO profile_snapshots (key, created_at, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET created_at = excluded.created_at, value = excluded.value`,
  )
    .bind(profileSnapshotStorageKey(profile), Date.now(), JSON.stringify(profile))
    .run();
}

// Snapshots per batch: a snapshot carries the profile's lists.
const snapshotsPerWrite = 25;

// Stores the snapshot of each profile unless it is stored already, `snapshotsPerWrite` to a
// batch. Returns their keys, in the order of `profiles`.
export async function ensureProfileSnapshots(
  env: Env,
  profiles: DashboardProfile[],
): Promise<string[]> {
  const insert = env.DB.prepare(
    `INSERT INTO profile_snapshots (key, created_at, value) VALUES (?, ?, ?)
     ON CONFLICT (key) DO NOTHING`,
  );
  const keys = profiles.map(profileSnapshotStorageKey);
  const now = Date.now();
  for (let index = 0; index < profiles.length; index += snapshotsPerWrite) {
    await env.DB.batch(
      profiles
        .slice(index, index + snapshotsPerWrite)
        .map((profile, offset) =>
          insert.bind(keys[index + offset] ?? "", now, JSON.stringify(profile)),
        ),
    );
  }
  return keys;
}

// Stores the snapshot of `profile` unless it is stored already. Returns its key.
export async function ensureProfileSnapshot(env: Env, profile: DashboardProfile): Promise<string> {
  const [key] = await ensureProfileSnapshots(env, [profile]);
  return key ?? profileSnapshotStorageKey(profile);
}

// Deletes up to `limit` snapshots written before the storage lifetime, the oldest first. Returns
// how many it deleted.
export async function deleteExpiredProfileSnapshots(env: Env, limit: number): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM profile_snapshots WHERE key IN (
       SELECT key FROM profile_snapshots WHERE created_at < ? ORDER BY created_at LIMIT ?
     )`,
  )
    .bind(Date.now() - dashboardStorageTtlSeconds * 1000, limit)
    .run();
  return result.meta.changes;
}
