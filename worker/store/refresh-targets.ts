// Refresh targets: the dashboards the scheduler keeps fresh, and the index of the targets that
// show an owner or a repository, which a webhook for that source asks.
//
// A target is a row of `refresh_targets` in D1, and the index is `refresh_target_sources`: one
// row per target and source (migrations/0001_refresh.sql). D1 expires nothing by itself:
// `deleteExpiredRefreshTargets` deletes the targets nobody has seen for the storage lifetime.

import type { RefreshTarget } from "../../src/types.ts";
import {
  dashboardCachePrefix,
  dashboardStorageTtlSeconds,
  refreshTargetEntryLimitBytes,
  refreshTargetSourceLimit,
  webhookTargetPageSize,
} from "../config.ts";
import { tryJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

export type RefreshTargetSource = { kind: "owner" | "repo"; value: string };

// "created" and "updated" store the target with its sources. "too-large" refuses a target over
// the entry limit, and "full" a new target of a source that has `refreshTargetSourceLimit`
// targets already.
export type RefreshTargetWrite = "created" | "updated" | "too-large" | "full";

export type RefreshTargetPage = {
  targets: RefreshTarget[];
  nextCursor?: string;
};

type ValueRow = { value: string };

// D1 takes 100 bound parameters per statement. A source takes two in a count, which binds
// three more, and three in an insert.
const sourcesPerCount = 45;
const sourcesPerInsert = 30;

function chunks<Item>(items: Item[], size: number): Item[][] {
  const result: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function parseTargets(rows: ValueRow[]): RefreshTarget[] {
  return rows
    .map((row) => tryJsonParse<RefreshTarget>(row.value, "refresh target"))
    .filter((target): target is RefreshTarget => target !== null);
}

// Targets last seen before this are past their lifetime: no listing returns them, and
// `deleteExpiredRefreshTargets` deletes them.
function seenCutoff(now = Date.now()): number {
  return now - dashboardStorageTtlSeconds * 1000;
}

// The key range of the targets of dashboards with the current cache key version.
function currentKeyRange(): [from: string, before: string] {
  const last = dashboardCachePrefix.length - 1;
  return [
    dashboardCachePrefix,
    dashboardCachePrefix.slice(0, last) +
      String.fromCharCode(dashboardCachePrefix.charCodeAt(last) + 1),
  ];
}

// The target as it was stored, not validated.
export async function readStoredRefreshTarget(
  env: Env,
  key: string,
): Promise<RefreshTarget | null> {
  const row = await env.DB.prepare("SELECT value FROM refresh_targets WHERE key = ?")
    .bind(key)
    .first<ValueRow>();
  return row ? tryJsonParse<RefreshTarget>(row.value, `refresh target ${key}`) : null;
}

// Counts the sources among `sources`, at most `sourcesPerCount`, that list
// `refreshTargetSourceLimit` other targets already. A target past its lifetime that is not
// deleted yet takes no place: no listing returns it, and the next tick deletes it.
function fullSourceCount(
  env: Env,
  sources: RefreshTargetSource[],
  targetKey: string,
  cutoff: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT COUNT(*) AS found FROM (
       SELECT 1 FROM refresh_target_sources AS source
       JOIN refresh_targets AS target ON target.key = source.target_key
       WHERE (source.kind, source.value) IN (VALUES ${sources.map(() => "(?, ?)").join(", ")})
         AND source.target_key <> ?
         AND target.last_seen_at >= ?
       GROUP BY source.kind, source.value
       HAVING COUNT(*) >= ?
     )`,
  ).bind(
    ...sources.flatMap((source) => [source.kind, source.value]),
    targetKey,
    cutoff,
    refreshTargetSourceLimit,
  );
}

// How many of `sources` are full for a new target (`fullSourceCount`).
async function fullSources(
  env: Env,
  sources: RefreshTargetSource[],
  targetKey: string,
): Promise<number> {
  if (sources.length === 0) return 0;
  const cutoff = seenCutoff();
  const results = await env.DB.batch<{ found: number }>(
    chunks(sources, sourcesPerCount).map((chunk) => fullSourceCount(env, chunk, targetKey, cutoff)),
  );
  return results.reduce((total, result) => total + (result.results[0]?.found ?? 0), 0);
}

// Stores the target and lists it under each of its sources, in one transaction. The limits are
// checked before the write, not with it: targets admitted at the same moment can take a source
// a few rows over its limit.
export async function writeRefreshTarget(
  env: Env,
  target: RefreshTarget,
  sources: RefreshTargetSource[],
): Promise<RefreshTargetWrite> {
  const value = JSON.stringify(target);
  if (new TextEncoder().encode(value).byteLength > refreshTargetEntryLimitBytes) {
    return "too-large";
  }
  const existing = await env.DB.prepare("SELECT 1 AS stored FROM refresh_targets WHERE key = ?")
    .bind(target.key)
    .first<{ stored: number }>();
  if (!existing && (await fullSources(env, sources, target.key)) > 0) return "full";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO refresh_targets (key, next_due_at, last_seen_at, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         next_due_at = excluded.next_due_at,
         last_seen_at = excluded.last_seen_at,
         value = excluded.value`,
    ).bind(target.key, safeIso(target.nextDueAt), safeIso(target.lastSeenAt), value),
    env.DB.prepare("DELETE FROM refresh_target_sources WHERE target_key = ?").bind(target.key),
    ...chunks(sources, sourcesPerInsert).map((chunk) =>
      env.DB.prepare(
        `INSERT INTO refresh_target_sources (kind, value, target_key)
         VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`,
      ).bind(...chunk.flatMap((source) => [source.kind, source.value, target.key])),
    ),
  ]);
  return existing ? "updated" : "created";
}

// Keys per statement of a lookup, and targets per batch of writes: a target is at most
// `refreshTargetEntryLimitBytes`, so a batch carries less than 1 MB.
const keysPerRead = 90;
const targetsPerWrite = 100;

// The targets with the keys, as they were stored, not validated, by key: null for a key that has
// none. One query, however many keys: a statement per `keysPerRead` of them, in one batch.
export async function readStoredRefreshTargetsOf(
  env: Env,
  keys: string[],
): Promise<Map<string, RefreshTarget | null>> {
  const found = new Map<string, RefreshTarget | null>(keys.map((key) => [key, null]));
  if (found.size === 0) return found;
  const results = await env.DB.batch<ValueRow & { key: string }>(
    chunks([...found.keys()], keysPerRead).map((chunk) =>
      env.DB.prepare(
        `SELECT key, value FROM refresh_targets
         WHERE key IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(...chunk),
    ),
  );
  for (const row of results.flatMap((result) => result.results)) {
    found.set(row.key, tryJsonParse<RefreshTarget>(row.value, `refresh target ${row.key}`));
  }
  return found;
}

// Stores each target as `writeRefreshTarget` does, with a query for the limits of all of them
// and a batch per `targetsPerWrite` targets that are stored. The results are in the order of
// `entries`. A target is named once only.
export async function writeRefreshTargets(
  env: Env,
  entries: Array<{ target: RefreshTarget; sources: RefreshTargetSource[] }>,
): Promise<RefreshTargetWrite[]> {
  const results = Array.from<RefreshTargetWrite>({ length: entries.length });
  const values = entries.map(({ target }) => JSON.stringify(target));
  const sized: number[] = [];
  for (const [index, value] of values.entries()) {
    if (new TextEncoder().encode(value).byteLength > refreshTargetEntryLimitBytes) {
      results[index] = "too-large";
    } else {
      sized.push(index);
    }
  }
  if (sized.length === 0) return results;

  // Which of the targets are stored already, and for each how many of its sources are full: a
  // statement per target, and the statements of `fullSources` after them.
  const checks: Array<{ index: number; statement: D1PreparedStatement }> = [];
  const cutoff = seenCutoff();
  for (const index of sized) {
    const entry = entries[index];
    if (!entry) continue;
    for (const chunk of chunks(entry.sources, sourcesPerCount)) {
      checks.push({
        index,
        statement: fullSourceCount(env, chunk, entry.target.key, cutoff),
      });
    }
  }
  const checked = await env.DB.batch<{ found: number }>([
    ...sized.map((index) =>
      env.DB.prepare("SELECT COUNT(*) AS found FROM refresh_targets WHERE key = ?").bind(
        entries[index]?.target.key ?? "",
      ),
    ),
    ...checks.map((check) => check.statement),
  ]);
  const existing = new Set(
    sized.filter((_index, position) => (checked[position]?.results[0]?.found ?? 0) > 0),
  );
  const full = new Set(
    checks
      .filter((_check, position) => (checked[sized.length + position]?.results[0]?.found ?? 0) > 0)
      .map((check) => check.index),
  );

  const stored: number[] = [];
  for (const index of sized) {
    if (!existing.has(index) && full.has(index)) {
      results[index] = "full";
    } else {
      stored.push(index);
    }
  }
  for (const chunk of chunks(stored, targetsPerWrite)) {
    await env.DB.batch(
      chunk.flatMap((index) => {
        const entry = entries[index];
        if (!entry) return [];
        const { target, sources } = entry;
        return [
          env.DB.prepare(
            `INSERT INTO refresh_targets (key, next_due_at, last_seen_at, value)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET
               next_due_at = excluded.next_due_at,
               last_seen_at = excluded.last_seen_at,
               value = excluded.value`,
          ).bind(
            target.key,
            safeIso(target.nextDueAt),
            safeIso(target.lastSeenAt),
            values[index] ?? "",
          ),
          env.DB.prepare("DELETE FROM refresh_target_sources WHERE target_key = ?").bind(
            target.key,
          ),
          ...chunks(sources, sourcesPerInsert).map((sourceChunk) =>
            env.DB.prepare(
              `INSERT INTO refresh_target_sources (kind, value, target_key)
               VALUES ${sourceChunk.map(() => "(?, ?, ?)").join(", ")}`,
            ).bind(...sourceChunk.flatMap((source) => [source.kind, source.value, target.key])),
          ),
        ];
      }),
    );
    for (const index of chunk) results[index] = existing.has(index) ? "updated" : "created";
  }
  return results;
}

// Deletes the target and takes it out of the index of its sources.
export async function deleteRefreshTarget(env: Env, key: string): Promise<void> {
  await deleteRefreshTargets(env, [key]);
}

// Deletes the targets and takes them out of the index of their sources: one batch.
export async function deleteRefreshTargets(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await env.DB.batch(
    chunks([...new Set(keys)], keysPerRead).flatMap((chunk) => {
      const list = chunk.map(() => "?").join(", ");
      return [
        env.DB.prepare(`DELETE FROM refresh_target_sources WHERE target_key IN (${list})`).bind(
          ...chunk,
        ),
        env.DB.prepare(`DELETE FROM refresh_targets WHERE key IN (${list})`).bind(...chunk),
      ];
    }),
  );
}

// A page of the stored targets of dashboards with the current cache key version, in key order
// after `cursor`, not validated. No `nextCursor` tells that no page follows.
export async function listStoredRefreshTargets(
  env: Env,
  limit: number,
  cursor?: string,
): Promise<RefreshTargetPage> {
  const [from, before] = currentKeyRange();
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM refresh_targets
     WHERE key >= ? AND key < ? AND key > ?
     ORDER BY key LIMIT ?`,
  )
    .bind(from, before, cursor ?? "", limit + 1)
    .all<ValueRow & { key: string }>();
  const page = results.slice(0, limit);
  return {
    targets: parseTargets(page),
    nextCursor: results.length > limit ? page.at(-1)?.key : undefined,
  };
}

// How many current targets are stored, with the `sampleLimit` of them that are due soonest, not
// validated.
export async function countStoredRefreshTargets(
  env: Env,
  sampleLimit: number,
): Promise<{ total: number; targets: RefreshTarget[] }> {
  const [from, before] = currentKeyRange();
  const [count, sample] = await env.DB.batch<{
    total?: number;
    value?: string;
  }>([
    env.DB.prepare("SELECT COUNT(*) AS total FROM refresh_targets WHERE key >= ? AND key < ?").bind(
      from,
      before,
    ),
    env.DB.prepare(
      `SELECT value FROM refresh_targets
       WHERE key >= ? AND key < ?
       ORDER BY next_due_at, key LIMIT ?`,
    ).bind(from, before, sampleLimit),
  ]);
  return {
    total: count?.results[0]?.total ?? 0,
    targets: parseTargets((sample?.results ?? []) as ValueRow[]),
  };
}

// The targets listed under each of the sources, most recently seen first, not validated: at most
// `refreshTargetSourceLimit` of them per source, in the order of `sources`. One batch.
export async function indexedRefreshTargets(
  env: Env,
  sources: RefreshTargetSource[],
): Promise<RefreshTarget[][]> {
  if (sources.length === 0) return [];
  const statement = env.DB.prepare(
    `SELECT targets.value FROM refresh_target_sources AS sources
     JOIN refresh_targets AS targets ON targets.key = sources.target_key
     WHERE sources.kind = ? AND sources.value = ? AND targets.last_seen_at >= ?
     ORDER BY targets.last_seen_at DESC, targets.key LIMIT ?`,
  );
  const cutoff = seenCutoff();
  const results = await env.DB.batch<ValueRow>(
    sources.map((source) =>
      statement.bind(source.kind, source.value, cutoff, refreshTargetSourceLimit),
    ),
  );
  return results.map((result) => parseTargets(result.results));
}

// A page of the targets listed under the source, in key order after `cursor`, not validated.
export async function indexedRefreshTargetPage(
  env: Env,
  source: RefreshTargetSource,
  cursor?: string,
): Promise<RefreshTargetPage> {
  const { results } = await env.DB.prepare(
    `SELECT sources.target_key AS key, targets.value FROM refresh_target_sources AS sources
     JOIN refresh_targets AS targets ON targets.key = sources.target_key
     WHERE sources.kind = ? AND sources.value = ? AND sources.target_key > ?
       AND targets.last_seen_at >= ?
     ORDER BY sources.target_key LIMIT ?`,
  )
    .bind(source.kind, source.value, cursor ?? "", seenCutoff(), webhookTargetPageSize + 1)
    .all<ValueRow & { key: string }>();
  const page = results.slice(0, webhookTargetPageSize);
  return {
    targets: parseTargets(page),
    nextCursor: results.length > webhookTargetPageSize ? page.at(-1)?.key : undefined,
  };
}

// Deletes up to `limit` targets that nobody has seen for the storage lifetime, the longest
// unseen first, with their index rows. Returns how many targets it deleted.
export async function deleteExpiredRefreshTargets(env: Env, limit: number): Promise<number> {
  const expired = `SELECT key FROM refresh_targets WHERE last_seen_at < ?
                   ORDER BY last_seen_at LIMIT ?`;
  const cutoff = seenCutoff();
  // One transaction: both statements select the same targets.
  const [, targets] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM refresh_target_sources WHERE target_key IN (${expired})`).bind(
      cutoff,
      limit,
    ),
    env.DB.prepare(`DELETE FROM refresh_targets WHERE key IN (${expired})`).bind(cutoff, limit),
  ]);
  return targets?.meta.changes ?? 0;
}
