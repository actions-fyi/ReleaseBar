// Owner metadata: what is known about one owner's repositories, including the ones that turned
// private or were removed and must stay hidden.
//
// An owner's snapshot is a row of the table `owner_metadata` of the D1 database
// (migrations/0003_registry.sql), as JSON, with a revision: a random token that every write
// replaces. The snapshot is one value because every change computes a whole snapshot from the
// whole one before it.
//
// No change can be lost to another: a change is written with one statement that names the
// revision it read, and the database runs statements one at a time. Of two changes that read the
// same revision, the second writes nothing, reads again and is applied to what the first one
// stored.
//
// The owners of one invocation are read with one query and written with one batch
// (docs/data-model.md, "D1 queries per invocation"): the batch holds the same statement for each
// owner, and tells for each whether it changed a row.

import { slugOwner } from "../../shared/dashboard.ts";
import { type OwnerMetadataSnapshot, ownerMetadataTtlSeconds } from "../config.ts";
import { tryJsonParse } from "../schemas.ts";

// How long a snapshot counts after it was last written. A row nobody wrote for this long reads
// as absent and is deleted by `deleteExpiredOwnerMetadata`.
const ownerMetadataTtlMs = ownerMetadataTtlSeconds * 1000;

// How often a change is tried before it gives up. Each try that fails means another change of
// the same owner went through in between, so only that many concurrent ones can use them up.
const changeAttempts = 12;

// Owners per statement of a read. D1 takes 100 bound parameters per statement, and a result of at
// most 50 MB; a snapshot is at most 2 MB, the size of a row.
const ownersPerRead = 20;

// Owners per statement of the read of the count times, which returns two short columns per owner
// and binds the time besides the owners.
const ownersPerCountTimeRead = 90;

// Owners per batch of writes: a batch carries each owner's whole snapshot.
const ownersPerWrite = 20;

type SnapshotRow = {
  owner: string;
  revision: string;
  snapshot: string;
  expires_at: number;
};

type StoredSnapshot = {
  // Null when the owner has no row.
  revision: string | null;
  // Null when the owner has no row, or the row's time ran out, or it does not hold JSON.
  snapshot: OwnerMetadataSnapshot | null;
};

export type OwnerMetadataChange = (
  stored: OwnerMetadataSnapshot | null,
) => OwnerMetadataSnapshot | null;

// What became of one owner's change: the snapshot that is stored now (null when the change left
// nothing to store), or why the change was not applied.
export type OwnerMetadataChangeResult = PromiseSettledResult<OwnerMetadataSnapshot | null>;

function chunks<Item>(items: Item[], size: number): Item[][] {
  const result: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

// One "?" per item: the values are always bound, never written into the statement.
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

// The rows of the owners, given as slugs, with their revisions. One query: a statement per
// `ownersPerRead` owners, in one batch. An owner is matched exactly, as by `=`.
async function readRevisions(env: Env, owners: string[]): Promise<Map<string, StoredSnapshot>> {
  const stored = new Map<string, StoredSnapshot>(
    owners.map((owner) => [owner, { revision: null, snapshot: null }]),
  );
  if (stored.size === 0) return stored;
  const results = await env.DB.batch<SnapshotRow>(
    chunks([...stored.keys()], ownersPerRead).map((chunk) =>
      env.DB.prepare(
        `SELECT owner, revision, snapshot, expires_at FROM owner_metadata
         WHERE owner IN (${placeholders(chunk.length)})`,
      ).bind(...chunk),
    ),
  );
  const now = Date.now();
  for (const row of results.flatMap((result) => result.results)) {
    stored.set(row.owner, {
      revision: row.revision,
      snapshot:
        row.expires_at > now
          ? tryJsonParse<OwnerMetadataSnapshot>(row.snapshot, `owner metadata ${row.owner}`)
          : null,
    });
  }
  return stored;
}

// The snapshots of the owners, as they were stored, not validated, by the owner's slug: null for
// an owner that has none. One query, however many owners. Rejects when the database can't be
// reached: a caller that hides private repositories must then hide all.
export async function readStoredOwnerMetadataOf(
  env: Env,
  owners: string[],
): Promise<Map<string, OwnerMetadataSnapshot | null>> {
  const stored = await readRevisions(env, [...new Set(owners.map(slugOwner))]);
  return new Map([...stored].map(([owner, { snapshot }]) => [owner, snapshot]));
}

// The owner's snapshot, as it was stored, not validated. Null when there is none. Rejects when
// the database can't be reached: a caller that hides private repositories must then hide all.
export async function readStoredOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  const slug = slugOwner(owner);
  return (await readStoredOwnerMetadataOf(env, [slug])).get(slug) ?? null;
}

// When each owner's repository counts were last asked of GitHub, by the owner's slug, without
// reading the snapshots: `countsAttemptedAt` of the snapshot, or its `countsUpdatedAt` when it
// has none, as `normalizeOwnerMetadataSnapshot` reads them. Only the owners with a snapshot that
// counts are in the result: the row's time has not run out, and the snapshot names the owner and
// lists projects. One query, however many owners.
export async function readOwnerCountTimes(
  env: Env,
  owners: string[],
): Promise<Map<string, string | null>> {
  const slugs = [...new Set(owners.map(slugOwner))];
  if (slugs.length === 0) return new Map();
  const now = Date.now();
  const results = await env.DB.batch<{ owner: string; attempted_at: unknown }>(
    chunks(slugs, ownersPerCountTimeRead).map((chunk) =>
      env.DB.prepare(
        `SELECT owner,
                COALESCE(
                  json_extract(snapshot, '$.countsAttemptedAt'),
                  json_extract(snapshot, '$.countsUpdatedAt')
                ) AS attempted_at
         FROM owner_metadata
         WHERE owner IN (${placeholders(chunk.length)})
           AND expires_at > ?
           AND json_extract(snapshot, '$.owner') = owner
           AND json_type(snapshot, '$.projects') = 'array'`,
      ).bind(...chunk, now),
    ),
  );
  return new Map(
    results
      .flatMap((result) => result.results)
      .map((row) => [row.owner, typeof row.attempted_at === "string" ? row.attempted_at : null]),
  );
}

// The statement that stores `snapshot` if the owner's row still has `revision`, or still does not
// exist when that is null, and changes no row when it has moved on. One statement: the database
// checks and writes in one step.
function writeIfRevision(
  env: Env,
  owner: string,
  revision: string | null,
  snapshot: OwnerMetadataSnapshot,
): D1PreparedStatement {
  const value = JSON.stringify(snapshot);
  const next = crypto.randomUUID();
  const expiresAt = Date.now() + ownerMetadataTtlMs;
  return revision === null
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
}

// Changes the snapshot of each owner to what its `change` makes of the stored one, with two
// queries for `ownersPerWrite` owners: one that reads their rows, and one batch of the statements
// `changeOwnerMetadata` would send for each. Every statement names the revision that was read, so
// an owner's change is stored only if nothing else changed that owner's row meanwhile. The batch
// tells for each statement whether it changed a row: the owners whose statement did not are read
// again, and only their changes are applied again, to what is stored by then.
//
// The result has one entry per change, in the order given: fulfilled with the snapshot that is
// stored now, or null when the change returned null and nothing was stored; rejected when the
// database could not be reached, or the owner's change kept losing to others. A rejected change is
// not applied, and the caller must not go on as if it were. An owner may be named once only.
// `change` must be free of side effects, as for `changeOwnerMetadata`.
export async function changeOwnerMetadataOf(
  env: Env,
  changes: Array<{ owner: string; change: OwnerMetadataChange }>,
): Promise<OwnerMetadataChangeResult[]> {
  const slugs = changes.map(({ owner }) => slugOwner(owner));
  if (new Set(slugs).size !== slugs.length) {
    throw new TypeError("an owner's metadata can take one change at a time");
  }
  const results = Array.from<OwnerMetadataChangeResult>({ length: changes.length });
  await Promise.all(
    chunks([...changes.keys()], ownersPerWrite).map(async (indexes) => {
      let pending = indexes;
      try {
        for (let attempt = 1; attempt <= changeAttempts && pending.length > 0; attempt += 1) {
          const stored = await readRevisions(
            env,
            pending.map((index) => slugs[index] ?? ""),
          );
          const writes: Array<{
            index: number;
            updated: OwnerMetadataSnapshot;
            statement: D1PreparedStatement;
          }> = [];
          for (const index of pending) {
            const slug = slugs[index] ?? "";
            const row = stored.get(slug) ?? { revision: null, snapshot: null };
            const updated = changes[index]?.change(row.snapshot) ?? null;
            if (updated) {
              writes.push({
                index,
                updated,
                statement: writeIfRevision(env, slug, row.revision, updated),
              });
            } else {
              results[index] = { status: "fulfilled", value: null };
            }
          }
          if (writes.length === 0) return;
          const written = await env.DB.batch(writes.map((write) => write.statement));
          pending = [];
          for (const [position, write] of writes.entries()) {
            if (written[position]?.meta.changes === 1) {
              results[write.index] = {
                status: "fulfilled",
                value: write.updated,
              };
            } else {
              pending.push(write.index);
            }
          }
        }
        for (const index of pending) {
          results[index] = {
            status: "rejected",
            reason: new Error(
              `owner metadata of ${slugs[index]} kept changing; the change was not applied`,
            ),
          };
        }
      } catch (error) {
        // The database failed: a batch is one transaction, so none of its writes is stored.
        for (const index of pending) results[index] ??= { status: "rejected", reason: error };
      }
    }),
  );
  return results;
}

// Changes the owner's snapshot to what `change` makes of the stored one, and returns the result.
// `change` gets the stored snapshot, not validated, or null; it must be free of side effects,
// because it runs again when another change of the owner got in first. When it returns null,
// nothing is stored. Rejects when the database can't be reached or the change kept losing to
// others: the change is then not applied, and the caller must not go on as if it were.
export async function changeOwnerMetadata(
  env: Env,
  owner: string,
  change: OwnerMetadataChange,
): Promise<OwnerMetadataSnapshot | null> {
  const [result] = await changeOwnerMetadataOf(env, [{ owner, change }]);
  if (!result) throw new Error("owner metadata change has no result");
  if (result.status === "rejected") throw result.reason;
  return result.value;
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
