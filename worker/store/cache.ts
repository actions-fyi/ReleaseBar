// Cached payloads and short-lived entries, addressed by the cache key their owner builds:
// dashboards, repository details, activity, audience, summaries, markers and cooldowns. They stay
// in KV. Data that is queried, listed or counted has a module of its own in this folder
// (docs/data-model.md) and must not come through here.

import type { ProjectCache } from "../../shared/dashboard-contracts.ts";
import { mapConcurrent } from "../concurrency.ts";
import { tryJsonParse } from "../schemas.ts";

export function readCacheText(env: Env, key: string): Promise<string | null> {
  return env.DASHBOARD_CACHE.get(key);
}

// The entry as it was stored, not validated. `context` names it in the warning for invalid JSON.
export async function readCacheEntry<Value>(
  env: Env,
  key: string,
  context: string,
): Promise<Value | null> {
  const raw = await env.DASHBOARD_CACHE.get(key);
  return raw ? tryJsonParse<Value>(raw, context) : null;
}

// Without `ttlSeconds` the entry does not expire.
export function writeCacheText(
  env: Env,
  key: string,
  text: string,
  ttlSeconds?: number,
): Promise<void> {
  return ttlSeconds === undefined
    ? env.DASHBOARD_CACHE.put(key, text)
    : env.DASHBOARD_CACHE.put(key, text, { expirationTtl: ttlSeconds });
}

export function writeCacheEntry(
  env: Env,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  return writeCacheText(env, key, JSON.stringify(value), ttlSeconds);
}

export function deleteCacheEntry(env: Env, key: string): Promise<void> {
  return env.DASHBOARD_CACHE.delete(key);
}

// The first `limit` keys that start with `prefix`.
export async function listCacheKeys(env: Env, prefix: string, limit: number): Promise<string[]> {
  const page = await env.DASHBOARD_CACHE.list({ prefix, limit });
  return page.keys.map((key) => key.name);
}

// Every key that starts with `prefix`.
export async function listAllCacheKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) keys.push(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export async function deleteCacheEntries(env: Env, prefix: string): Promise<void> {
  const cache = env.DASHBOARD_CACHE;
  const list = cache.list.bind(cache);
  const deleteKey = cache.delete.bind(cache);
  let cursor: string | undefined;
  do {
    const page = await list({
      prefix,
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    await mapConcurrent(page.keys, 16, (key) => deleteKey(key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// The cache of built projects that the dashboard build of shared/dashboard.ts reads and writes.
export function projectCache(env: Env): ProjectCache {
  return env.DASHBOARD_CACHE;
}

// What in-memory stand-ins for a Durable Object are kept per: one cache, one set of stand-ins.
// Undefined when the env has no cache.
export function cacheIdentity(env: Env): object | undefined {
  return env.DASHBOARD_CACHE as object | undefined;
}
