// Refresh targets: the dashboards the scheduler keeps fresh, and the index of the targets that
// show an owner or a repository, which a webhook for that source asks.
//
// A target is a KV entry. The index is a Durable Object per source, with KV entries as its older
// form. Step 7a of the stack migration moves both to D1 (docs/data-model.md).

import type { RefreshTarget } from "../../src/types.ts";
import { mapConcurrent } from "../concurrency.ts";
import {
  dashboardCachePrefix,
  dashboardStorageTtlSeconds,
  refreshTargetIndexPrefix,
  refreshTargetIndexReadyKey,
  refreshTargetIndexVersion,
  refreshTargetPrefix,
  webhookTargetPageSize,
} from "../config.ts";
import { sha256Base64Url } from "../crypto.ts";
import type {
  RefreshTargetIndexPage,
  RefreshTargetIndexUpsert,
} from "../objects/refresh-target-index.ts";
import { refreshTargetIndexName } from "../runtime.ts";
import { tryJsonParse } from "../schemas.ts";

export type RefreshTargetSource = { kind: "owner" | "repo"; value: string };

export function refreshTargetStorageKey(key: string): string {
  return `${refreshTargetPrefix}${key}`;
}

export function refreshTargetIndexSource(kind: "owner" | "repo", source: string): string {
  return `${refreshTargetIndexPrefix}${kind}:${encodeURIComponent(source.toLowerCase())}:`;
}

// The target as it was stored, not validated.
export async function readStoredRefreshTarget(
  env: Env,
  key: string,
): Promise<RefreshTarget | null> {
  const raw = await env.DASHBOARD_CACHE.get(refreshTargetStorageKey(key));
  if (!raw) return null;
  return tryJsonParse<RefreshTarget>(raw, `refresh target ${key}`);
}

export async function writeRefreshTarget(env: Env, target: RefreshTarget): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshTargetStorageKey(target.key), JSON.stringify(target), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export function deleteRefreshTarget(env: Env, key: string): Promise<void> {
  return env.DASHBOARD_CACHE.delete(refreshTargetStorageKey(key));
}

// Which stored targets a listing covers:
// - "current": the targets of dashboards with the current cache key version.
// - "any-version": every stored target, whatever its dashboard's cache key version.
// - an owner: the current targets whose dashboard key starts with that owner.
export type StoredRefreshTargetScope = "current" | "any-version" | { owner: string };

function scopePrefix(scope: StoredRefreshTargetScope): string {
  if (scope === "any-version") return refreshTargetPrefix;
  if (scope === "current") return `${refreshTargetPrefix}${dashboardCachePrefix}`;
  return `${refreshTargetPrefix}${dashboardCachePrefix}${scope.owner}:`;
}

async function readListedRefreshTarget(env: Env, name: string): Promise<RefreshTarget | null> {
  const raw = await env.DASHBOARD_CACHE.get(name);
  return raw ? tryJsonParse<RefreshTarget>(raw, `refresh target ${name}`) : null;
}

// A page of stored targets, not validated. `complete` tells that no page follows.
export async function listStoredRefreshTargets(
  env: Env,
  scope: StoredRefreshTargetScope,
  limit: number,
  cursor?: string,
  concurrency = 16,
): Promise<{ targets: RefreshTarget[]; complete: boolean; nextCursor?: string }> {
  const page = await env.DASHBOARD_CACHE.list({
    prefix: scopePrefix(scope),
    limit,
    ...(cursor ? { cursor } : {}),
  });
  const targets = await mapConcurrent(page.keys, concurrency, (key) =>
    readListedRefreshTarget(env, key.name),
  );
  return {
    targets: targets.filter((target): target is RefreshTarget => target !== null),
    complete: page.list_complete,
    nextCursor: page.list_complete ? undefined : page.cursor,
  };
}

// How many current targets are stored, with the first `sampleLimit` of them, not validated.
export async function countStoredRefreshTargets(
  env: Env,
  sampleLimit: number,
): Promise<{ total: number; targets: RefreshTarget[] }> {
  const sampleKeys: string[] = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: scopePrefix("current"),
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    total += page.keys.length;
    for (const key of page.keys) {
      if (sampleKeys.length >= sampleLimit) break;
      sampleKeys.push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const targets = await mapConcurrent(sampleKeys, 16, (key) => readListedRefreshTarget(env, key));
  return {
    total,
    targets: targets.filter((target): target is RefreshTarget => target !== null),
  };
}

// Whether every stored target has been written to the index of its sources.
export async function refreshTargetIndexReady(env: Env): Promise<boolean> {
  return (
    (await env.DASHBOARD_CACHE.get(refreshTargetIndexReadyKey)) ===
    String(refreshTargetIndexVersion)
  );
}

export async function markRefreshTargetIndexReady(env: Env): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshTargetIndexReadyKey, String(refreshTargetIndexVersion), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

function sourceIndex(env: Env, source: RefreshTargetSource) {
  return env.REFRESH_TARGET_INDEX.getByName(refreshTargetIndexName(source.kind, source.value));
}

// Adds the target to the index of one source, or updates it there.
export async function upsertIndexedRefreshTarget(
  env: Env,
  source: RefreshTargetSource,
  target: RefreshTarget,
): Promise<RefreshTargetIndexUpsert> {
  return await sourceIndex(env, source).upsert(target);
}

export async function removeIndexedRefreshTarget(
  env: Env,
  source: RefreshTargetSource,
  key: string,
): Promise<void> {
  await sourceIndex(env, source).remove(key);
}

// Every target the source's index holds, most recently seen first, not validated.
export async function indexedRefreshTargets(
  env: Env,
  source: RefreshTargetSource,
): Promise<RefreshTarget[]> {
  return await sourceIndex(env, source).list();
}

// The targets the source's index holds, in key order, after `cursor`, not validated.
export async function indexedRefreshTargetPage(
  env: Env,
  source: RefreshTargetSource,
  cursor?: string,
): Promise<RefreshTargetIndexPage> {
  return await sourceIndex(env, source).page(cursor, webhookTargetPageSize);
}

// Records the target's key under each of its sources, in the older form of the index.
export async function writeRefreshTargetKeyIndex(
  env: Env,
  sources: RefreshTargetSource[],
  targetKey: string,
): Promise<void> {
  const hash = (await sha256Base64Url(targetKey)).slice(0, 32);
  await Promise.all(
    sources.map(({ kind, value }) =>
      env.DASHBOARD_CACHE.put(
        `${refreshTargetIndexSource(kind, value)}${hash}`,
        JSON.stringify(targetKey),
        { expirationTtl: dashboardStorageTtlSeconds },
      ),
    ),
  );
}

// A page of the older form of a source's index. An entry is a target key, or the whole target as
// the first version stored it; neither is validated.
export async function listRefreshTargetKeyIndex(
  env: Env,
  source: RefreshTargetSource,
  cursor?: string,
): Promise<{ entries: Array<RefreshTarget | string | null>; nextCursor?: string }> {
  const page = await env.DASHBOARD_CACHE.list({
    prefix: refreshTargetIndexSource(source.kind, source.value),
    limit: webhookTargetPageSize,
    ...(cursor ? { cursor } : {}),
  });
  const entries = await mapConcurrent(page.keys, 16, async (key) => {
    const raw = await env.DASHBOARD_CACHE.get(key.name);
    return raw
      ? tryJsonParse<RefreshTarget | string>(raw, `refresh target index ${key.name}`)
      : null;
  });
  return { entries, nextCursor: page.list_complete ? undefined : page.cursor };
}
