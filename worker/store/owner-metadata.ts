// Owner metadata: what is known about one owner's repositories, including the ones that turned
// private or were removed and must stay hidden.
//
// An owner's snapshot is a row of the table `owner_metadata` of the D1 database
// (migrations/0003_registry.sql), as JSON, with a revision: a random token that every write
// replaces. The snapshot is one value because every change computes a whole snapshot from the
// whole one before it.
//
// No change can be lost to another: `changeOwnerMetadata` writes with one statement that names
// the revision it read, and the database runs statements one at a time. Of two changes that read
// the same revision, the second writes nothing, reads again and is applied to what the first one
// stored.

import { slugOwner } from "../../shared/dashboard.ts";
import { type OwnerMetadataSnapshot, ownerMetadataTtlSeconds } from "../config.ts";
import { tryJsonParse } from "../schemas.ts";

// How long a snapshot counts after it was last written. A row nobody wrote for this long reads
// as absent and is deleted by `deleteExpiredOwnerMetadata`.
const ownerMetadataTtlMs = ownerMetadataTtlSeconds * 1000;

// How often a change is tried before it gives up. Each try that fails means another change of
// the same owner went through in between, so only that many concurrent ones can use them up.
const changeAttempts = 12;

type SnapshotRow = { revision: string; snapshot: string; expires_at: number };

type StoredSnapshot = {
  // Null when the owner has no row.
  revision: string | null;
  // Null when the owner has no row, or the row's time ran out, or it does not hold JSON.
  snapshot: OwnerMetadataSnapshot | null;
};

async function readRevision(env: Env, owner: string): Promise<StoredSnapshot> {
  const row = await env.DB.prepare(
    "SELECT revision, snapshot, expires_at FROM owner_metadata WHERE owner = ?1",
  )
    .bind(owner)
    .first<SnapshotRow>();
  if (!row) return { revision: null, snapshot: null };
  return {
    revision: row.revision,
    snapshot:
      row.expires_at > Date.now()
        ? tryJsonParse<OwnerMetadataSnapshot>(row.snapshot, `owner metadata ${owner}`)
        : null,
  };
}

// The owner's snapshot, as it was stored, not validated. Null when there is none. Rejects when
// the database can't be reached: a caller that hides private repositories must then hide all.
export async function readStoredOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  return (await readRevision(env, slugOwner(owner))).snapshot;
}

// Stores `snapshot` if the owner's row still has `revision`, or still does not exist when that is
// null. False when it has moved on. One statement: the database checks and writes in one step.
async function writeIfRevision(
  env: Env,
  owner: string,
  revision: string | null,
  snapshot: OwnerMetadataSnapshot,
): Promise<boolean> {
  const value = JSON.stringify(snapshot);
  const next = crypto.randomUUID();
  const expiresAt = Date.now() + ownerMetadataTtlMs;
  const statement =
    revision === null
      ? env.DB.prepare(
          `INSERT INTO owner_metadata (owner, revision, snapshot, expires_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (owner) DO NOTHING`,
        ).bind(owner, next, value, expiresAt)
      : env.DB.prepare(
          `UPDATE owner_metadata
           SET revision = ?3, snapshot = ?4, expires_at = ?5
           WHERE owner = ?1 AND revision = ?2`,
        ).bind(owner, revision, next, value, expiresAt);
  return (await statement.run()).meta.changes === 1;
}

// Changes the owner's snapshot to what `change` makes of the stored one, and returns the result.
// `change` gets the stored snapshot, not validated, or null; it must be free of side effects,
// because it runs again when another change of the owner got in first. When it returns null,
// nothing is stored. Rejects when the database can't be reached or the change kept losing to
// others: the change is then not applied, and the caller must not go on as if it were.
export async function changeOwnerMetadata(
  env: Env,
  owner: string,
  change: (stored: OwnerMetadataSnapshot | null) => OwnerMetadataSnapshot | null,
): Promise<OwnerMetadataSnapshot | null> {
  const slug = slugOwner(owner);
  for (let attempt = 1; attempt <= changeAttempts; attempt += 1) {
    const stored = await readRevision(env, slug);
    const updated = change(stored.snapshot);
    if (!updated) return null;
    if (await writeIfRevision(env, slug, stored.revision, updated)) return updated;
  }
  throw new Error(`owner metadata of ${slug} kept changing; the change was not applied`);
}

// Deletes up to `limit` snapshots whose time ran out, and returns how many. KV expired them by
// itself; the scheduled handler calls this instead.
export async function deleteExpiredOwnerMetadata(env: Env, limit: number): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM owner_metadata
     WHERE owner IN (SELECT owner FROM owner_metadata WHERE expires_at <= ?1 LIMIT ?2)`,
  )
    .bind(Date.now(), limit)
    .run();
  return result.meta.changes;
}
