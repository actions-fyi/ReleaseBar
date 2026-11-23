// The GitHub audit log: how often the Worker called each GitHub route, by hour, with which
// credentials and with what result.
//
// The counts of an hour are spread over KV entries, each read and written in two steps, so
// concurrent calls can lose a count. Step 7b of the stack migration moves them to D1
// (docs/data-model.md).

import type { GitHubAccessRouteSummary } from "../../src/types.ts";
import { tryJsonParse } from "../schemas.ts";

const githubAccessPrefix = "github:access:v1:";
const githubAccessTtlSeconds = 14 * 24 * 60 * 60;
const githubAccessShardCount = 16;

export type StoredGitHubAccessShard = {
  count?: number;
  lastAt?: string | null;
  routes?: Record<string, GitHubAccessRouteSummary>;
};

// An entry of the form that came before the shards: one route's count.
export type StoredGitHubAccessCounter = GitHubAccessRouteSummary & {
  remaining?: number | null;
  limit?: number | null;
  resetAt?: string | null;
};

function githubAccessCounterKey(shard: number): string {
  const hour = new Date().toISOString().slice(0, 13);
  return `${githubAccessPrefix}${hour}:${shard}`;
}

// Adds one call to the current hour's count for `route.key`.
export async function countGitHubAccess(
  env: Env,
  route: Omit<GitHubAccessRouteSummary, "count" | "lastAt">,
): Promise<void> {
  const key = githubAccessCounterKey(Math.floor(Math.random() * githubAccessShardCount));
  const raw = await env.DASHBOARD_CACHE.get(key);
  const current = raw ? tryJsonParse<StoredGitHubAccessShard>(raw, `github access ${key}`) : null;
  const routes = { ...current?.routes };
  const existing = routes[route.key];
  const lastAt = new Date().toISOString();
  routes[route.key] = {
    key: route.key,
    area: route.area,
    route: route.route,
    status: route.status,
    source: route.source,
    account: route.account,
    resource: route.resource,
    count: (existing?.count ?? 0) + 1,
    lastPath: route.lastPath,
    lastAt,
  };
  await env.DASHBOARD_CACHE.put(
    key,
    JSON.stringify({
      count: (current?.count ?? 0) + 1,
      lastAt,
      routes,
    }),
    { expirationTtl: githubAccessTtlSeconds },
  );
}

// What is stored for the given hours ("2026-06-13T12"), not validated. `key` names the entry.
export async function listGitHubAccessCounts(
  env: Env,
  hours: string[],
): Promise<Array<{ key: string; stored: StoredGitHubAccessShard | StoredGitHubAccessCounter }>> {
  const cache = env.DASHBOARD_CACHE;
  const list = cache.list.bind(cache);
  const pages = await Promise.all(
    hours.map((hour) =>
      list({
        prefix: `${githubAccessPrefix}${hour}:`,
        limit: 1000,
      }),
    ),
  );
  const keys = pages.flatMap((page) => page.keys.map((key) => key.name));
  const entries = await Promise.all(
    keys.map(async (key) => {
      const raw = await cache.get(key);
      if (!raw) return null;
      const stored = tryJsonParse<StoredGitHubAccessShard | StoredGitHubAccessCounter>(
        raw,
        `github access ${key}`,
      );
      return stored ? { key, stored } : null;
    }),
  );
  return entries.filter((entry) => entry !== null);
}
