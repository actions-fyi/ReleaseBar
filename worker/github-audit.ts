import type { ApiQuota, GitHubAccessRouteSummary, GitHubAccessSummary } from "../src/types.ts";
import { jsonResponse, workerFetch } from "./http.ts";
import { tryJsonParse } from "./schemas.ts";
import {
  deleteCacheEntry,
  listAllCacheKeys,
  readCacheEntry,
  readCacheText,
  writeCacheEntry,
} from "./store/cache.ts";
import {
  countGitHubAccess,
  type GitHubAccessCalls,
  listGitHubAccessCounts,
} from "./store/github-access.ts";
import type { BackgroundContext } from "./runtime.ts";
import { collectGitHubAccess } from "./audit-collector.ts";
import { safeIso } from "./time.ts";

export const githubAccessAdminHours = 24;
const githubAccessAdminRouteLimit = 30;
const githubSharedBudgetPrefix = "github:budget:v1:shared:";
const githubGraphqlBackoffPrefix = "github:backoff:v2:graphql:";
export const githubGraphqlBackoffSeconds = 2 * 60;
export const githubGraphqlOwnerReleaseOperation = "ReleaseBarOwnerRepos.release";
const sharedQuotaCooldownFallbackSeconds = 30 * 60;
const sharedQuotaMinimumRemaining: Record<string, number> = {
  core: 1000,
  graphql: 1000,
  search: 3,
  integration_manifest: 20,
  _: 250,
};
const sharedQuotaEnrichmentMinimumRemaining: Record<string, number> = {
  core: 2000,
  graphql: 2000,
  search: 10,
  integration_manifest: 40,
  _: 1000,
};

// The audit writes of one request or job whose env has no audit collector
// (worker/audit-collector.ts): the calls not yet counted, by route key, and the chain that counts
// them. One write runs at a time, and the calls made meanwhile go into the next as one batch.
// With a collector the calls are counted in its batch, and the chain only marks the cooldowns.
type GitHubAccessWrites = { pending: Map<string, GitHubAccessCalls>; chain: Promise<void> };
const githubAccessWrites = new WeakMap<BackgroundContext, GitHubAccessWrites>();

export type GitHubAuditArea =
  | "dashboard"
  | "discover"
  | "owner-activity"
  | "repo-activity"
  | "repo-audience"
  | "repo-detail"
  | "release-summary"
  | "trust-profile"
  | "social-card"
  | "auth";

const githubAuditAreas = new Set<GitHubAuditArea>([
  "dashboard",
  "discover",
  "owner-activity",
  "repo-activity",
  "repo-audience",
  "repo-detail",
  "release-summary",
  "trust-profile",
  "social-card",
  "auth",
]);

export function githubRequestOptions(
  acceptOrAuditArea = "application/vnd.github+json",
  auditArea: GitHubAuditArea = "repo-detail",
): { accept: string; auditArea: GitHubAuditArea } {
  if (githubAuditAreas.has(acceptOrAuditArea as GitHubAuditArea)) {
    return {
      accept: "application/vnd.github+json",
      auditArea: acceptOrAuditArea as GitHubAuditArea,
    };
  }
  return { accept: acceptOrAuditArea, auditArea };
}
function auditGitHubTokenUse(
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
): void {
  console.log(
    JSON.stringify({
      event: "github_token_use",
      area,
      path,
      status,
      quota: {
        source: quota.source,
        account: quota.account,
        remaining: quota.remaining,
        limit: quota.limit,
        resetAt: quota.resetAt,
        resource: quota.resource,
      },
    }),
  );
}

function githubPathBucket(path: string): string {
  const url = new URL(path, "https://api.github.com");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/graphql") {
    const operation = url.searchParams.get("operation");
    return operation ? `graphql/${operation}` : "graphql";
  }
  if (parts[0] === "users" && parts[2] === "repos") return "users/:owner/repos";
  if (parts[0] === "orgs" && parts[2] === "repos") return "orgs/:owner/repos";
  if (parts[0] === "users" && parts.length === 2) return "users/:owner";
  if (parts[0] === "repos" && parts.length >= 3) {
    const suffix = parts.slice(3);
    if (suffix[0] === "releases") return "repos/:owner/:repo/releases";
    if (suffix[0] === "compare") return "repos/:owner/:repo/compare";
    if (suffix[0] === "commits" && suffix[2] === "check-runs") {
      return "repos/:owner/:repo/commits/:ref/check-runs";
    }
    if (suffix[0] === "commits") return "repos/:owner/:repo/commits/:ref";
    if (suffix[0] === "pulls") return "repos/:owner/:repo/pulls";
    if (suffix[0] === "stats") return `repos/:owner/:repo/stats/${suffix[1] ?? ""}`;
    if (suffix[0]) return `repos/:owner/:repo/${suffix[0]}`;
    return "repos/:owner/:repo";
  }
  if (parts[0] === "search") return `search/${parts[1] ?? ""}`;
  return url.pathname;
}

export type SharedQuotaCooldown = {
  active: boolean;
  level?: "conserve" | "critical";
  resource: string | null;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  reason: string | null;
};

function sharedQuotaThreshold(resource: string | null): number {
  return sharedQuotaMinimumRemaining[resource ?? "_"] ?? sharedQuotaMinimumRemaining._;
}

function sharedQuotaEnrichmentThreshold(resource: string | null): number {
  return (
    sharedQuotaEnrichmentMinimumRemaining[resource ?? "_"] ??
    sharedQuotaEnrichmentMinimumRemaining._
  );
}

function sharedQuotaBudgetKey(resource: string | null): string {
  return `${githubSharedBudgetPrefix}${resource ?? "_"}`;
}

function sharedQuotaCooldownTtlSeconds(resetAt: string | null): number {
  const resetMs = resetAt ? Date.parse(resetAt) - Date.now() : 0;
  if (Number.isFinite(resetMs) && resetMs > 0) {
    return Math.max(60, Math.min(2 * 60 * 60, Math.ceil(resetMs / 1000)));
  }
  return sharedQuotaCooldownFallbackSeconds;
}

async function markSharedQuotaCooldown(
  env: Env | undefined,
  quota: ApiQuota,
  reason: string,
  level: SharedQuotaCooldown["level"] = "critical",
): Promise<void> {
  if (!env || quota.source !== "shared") return;
  const resetAt =
    quota.resetAt ?? new Date(Date.now() + sharedQuotaCooldownFallbackSeconds * 1000).toISOString();
  const item: SharedQuotaCooldown = {
    active: true,
    level,
    resource: quota.resource,
    remaining: quota.remaining,
    limit: quota.limit,
    resetAt,
    reason,
  };
  const ttl = sharedQuotaCooldownTtlSeconds(resetAt);
  await Promise.all([
    writeCacheEntry(env, sharedQuotaBudgetKey(null), item, ttl),
    writeCacheEntry(env, sharedQuotaBudgetKey(quota.resource), item, ttl),
  ]);
}

export async function sharedQuotaCooldown(
  env: Env,
  resource: string | null = null,
): Promise<SharedQuotaCooldown> {
  return sharedQuotaState(env, resource, false);
}

export async function sharedQuotaConservation(
  env: Env,
  resource: string | null = null,
): Promise<SharedQuotaCooldown> {
  return sharedQuotaState(env, resource, true);
}

async function sharedQuotaState(
  env: Env,
  resource: string | null,
  includeConserve: boolean,
): Promise<SharedQuotaCooldown> {
  const empty: SharedQuotaCooldown = {
    active: false,
    resource: null,
    remaining: null,
    limit: null,
    resetAt: null,
    reason: null,
  };
  const keys = new Set(
    resource
      ? [sharedQuotaBudgetKey(resource), sharedQuotaBudgetKey(null)]
      : [sharedQuotaBudgetKey(null)],
  );
  if (!resource) {
    for (const key of await listAllCacheKeys(env, githubSharedBudgetPrefix)) keys.add(key);
  }
  let selected: SharedQuotaCooldown | null = null;
  let selectedUntil = 0;
  for (const key of keys) {
    const parsed = await readCacheEntry<SharedQuotaCooldown>(
      env,
      key,
      `shared quota cooldown ${key}`,
    );
    if (!parsed?.active) continue;
    if (!includeConserve && parsed.level === "conserve") continue;
    const reset = parsed.resetAt ? Date.parse(parsed.resetAt) : 0;
    if (Number.isFinite(reset) && reset > 0 && reset <= Date.now()) {
      await deleteCacheEntry(env, key).catch(() => undefined);
      continue;
    }
    const until = Date.parse(sharedQuotaDeferUntil(parsed));
    if (!selected || until > selectedUntil) {
      selected = parsed;
      selectedUntil = until;
    }
  }
  return selected ?? empty;
}

export function sharedQuotaDeferUntil(cooldown: SharedQuotaCooldown): string {
  const reset = cooldown.resetAt ? Date.parse(cooldown.resetAt) : 0;
  const next = Number.isFinite(reset) && reset > Date.now() ? reset : Date.now() + 30 * 60 * 1000;
  return new Date(next).toISOString();
}

function githubGraphqlOperation(init?: RequestInit): string {
  if (typeof init?.body !== "string") return "unknown";
  const payload = tryJsonParse<{
    query?: unknown;
    variables?: { includeReleases?: unknown };
  }>(init.body, "GitHub GraphQL request");
  if (typeof payload?.query !== "string") return "unknown";
  const name = payload.query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (!name) return "anonymous";
  if (name === "ReleaseBarOwnerRepos") {
    return payload.variables?.includeReleases
      ? githubGraphqlOwnerReleaseOperation
      : "ReleaseBarOwnerRepos.metadata";
  }
  return name;
}

export function githubGraphqlAuditPath(operation: string): string {
  return `/graphql?operation=${encodeURIComponent(operation)}`;
}

function githubGraphqlBackoffKey(
  source: ApiQuota["source"],
  account: string | null,
  operation: string,
): string {
  return `${githubGraphqlBackoffPrefix}${source}:${account ?? "_"}:${operation}`;
}

export async function graphqlBackoffActive(
  env: Env | undefined,
  source: ApiQuota["source"],
  account: string | null,
  operation: string,
): Promise<boolean> {
  return Boolean(
    env && (await readCacheText(env, githubGraphqlBackoffKey(source, account, operation))),
  );
}

export async function markGraphqlBackoff(
  env: Env | undefined,
  source: ApiQuota["source"],
  account: string | null,
  operation: string,
  status: number,
): Promise<void> {
  if (!env) return;
  await writeCacheEntry(
    env,
    githubGraphqlBackoffKey(source, account, operation),
    {
      active: true,
      status,
      source,
      account,
      operation,
      at: new Date().toISOString(),
    },
    githubGraphqlBackoffSeconds,
  );
}

export function githubGraphqlBackoffDeferUntil(): string {
  return new Date(Date.now() + githubGraphqlBackoffSeconds * 1000).toISOString();
}

// Adds one call to those of its route key in `pending`.
function addGitHubAccessCall(
  pending: Map<string, GitHubAccessCalls>,
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
): void {
  const route = githubPathBucket(path);
  const routeKey = `${area}:${status}:${quota.source}:${quota.account ?? "_"}:${quota.resource ?? "_"}:${route}`;
  pending.set(routeKey, {
    key: routeKey,
    area,
    route,
    status,
    source: quota.source,
    account: quota.account,
    resource: quota.resource,
    count: (pending.get(routeKey)?.count ?? 0) + 1,
    lastPath: path.slice(0, 240),
    lastAt: new Date().toISOString(),
  });
}

// Counts the pending calls in one batch. Calls of an hour that has ended meanwhile count for the
// hour of the last of them.
async function countPendingGitHubAccess(
  env: Env | undefined,
  pending: Map<string, GitHubAccessCalls>,
): Promise<void> {
  if (!env || pending.size === 0) return;
  const calls = [...pending.values()];
  pending.clear();
  await countGitHubAccess(env, calls);
}

function sharedQuotaPressure(status: number, quota: ApiQuota, rateLimited = false): boolean {
  return (
    quota.source === "shared" &&
    ((quota.remaining !== null && quota.remaining <= sharedQuotaThreshold(quota.resource)) ||
      status === 429 ||
      rateLimited)
  );
}

function sharedQuotaConservationPressure(quota: ApiQuota): boolean {
  return (
    quota.source === "shared" &&
    quota.remaining !== null &&
    quota.remaining <= sharedQuotaEnrichmentThreshold(quota.resource)
  );
}

function sharedQuotaCooldownReason(status: number, quota: ApiQuota, rateLimited = false): string {
  if (rateLimited) return `rate limited status ${status}`;
  if (quota.remaining !== null && quota.remaining <= sharedQuotaThreshold(quota.resource)) {
    return `remaining ${quota.remaining} <= ${sharedQuotaThreshold(quota.resource)}`;
  }
  return `status ${status}`;
}

export async function recordAuditedGitHubAccess(
  env: Env | undefined,
  area: GitHubAuditArea,
  path: string,
  status: number,
  quota: ApiQuota,
  rateLimited = false,
  forceWait = false,
  context?: BackgroundContext,
): Promise<void> {
  auditGitHubTokenUse(area, path, status, quota);
  const writes = (context && githubAccessWrites.get(context)) ?? {
    pending: new Map<string, GitHubAccessCalls>(),
    chain: Promise.resolve(),
  };
  if (context) githubAccessWrites.set(context, writes);
  if (
    !collectGitHubAccess(env, (pending) => addGitHubAccessCall(pending, area, path, status, quota))
  ) {
    addGitHubAccessCall(writes.pending, area, path, status, quota);
  }
  const write = () =>
    countPendingGitHubAccess(env, writes.pending)
      .then(() => {
        if (sharedQuotaPressure(status, quota, rateLimited)) {
          return markSharedQuotaCooldown(
            env,
            quota,
            sharedQuotaCooldownReason(status, quota, rateLimited),
            "critical",
          );
        }
        if (sharedQuotaConservationPressure(quota)) {
          return markSharedQuotaCooldown(
            env,
            quota,
            `remaining ${quota.remaining} <= ${sharedQuotaEnrichmentThreshold(quota.resource)}`,
            "conserve",
          );
        }
        return undefined;
      })
      .catch(() => undefined);
  const mustWait = forceWait || sharedQuotaPressure(status, quota, rateLimited);
  if (context) {
    const chained = writes.chain.then(write, write);
    writes.chain = chained;
    if (mustWait) {
      await chained;
    } else {
      context.waitUntil(chained);
    }
  } else {
    await write();
  }
}

export async function responseRateLimitSignal(response: Response): Promise<boolean> {
  if (response.status !== 403 && response.status !== 429) return false;
  if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
    return true;
  }
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { message?: unknown } | null;
  const message = body && typeof body.message === "string" ? body.message : "";
  return isRateLimitResponse(response, message);
}

export function auditGitHubFetch(
  area: GitHubAuditArea,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  env?: Env,
  context?: BackgroundContext,
  signal?: AbortSignal,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const graphqlOperation =
      url.hostname === "api.github.com" && url.pathname === "/graphql"
        ? githubGraphqlOperation(init)
        : null;
    if (
      graphqlOperation &&
      (await graphqlBackoffActive(env, quotaSource, quotaAccount, graphqlOperation))
    ) {
      console.log(
        JSON.stringify({
          event: "github_graphql_backoff_skip",
          area,
          source: quotaSource,
          account: quotaAccount,
          operation: graphqlOperation,
        }),
      );
      const hardBackoff = quotaSource === "shared";
      return jsonResponse(
        { message: "GitHub GraphQL temporarily paused after upstream errors" },
        503,
        {
          "cache-control": "no-store",
          ...(hardBackoff ? { "x-releasebar-github-backoff": "graphql" } : {}),
        },
      );
    }
    const response = await workerFetch(input, signal ? { ...init, signal } : init);
    if (url.hostname === "api.github.com") {
      const path = graphqlOperation
        ? githubGraphqlAuditPath(graphqlOperation)
        : `${url.pathname}${url.search}`;
      const quota = quotaFromGitHubResponse(response, quotaSource, quotaAccount);
      const rateLimited =
        quota.source === "shared" ? await responseRateLimitSignal(response) : false;
      const isGraphqlServerError =
        url.pathname === "/graphql" && response.status >= 500 && response.status < 600;
      const shouldWaitAccess =
        sharedQuotaPressure(response.status, quota, rateLimited) ||
        (quotaSource === "shared" && isGraphqlServerError);
      const accessRecord = recordAuditedGitHubAccess(
        env,
        area,
        path,
        response.status,
        quota,
        rateLimited,
        shouldWaitAccess,
        context,
      );
      if (isGraphqlServerError) {
        const backoffWrite = markGraphqlBackoff(
          env,
          quotaSource,
          quotaAccount,
          graphqlOperation ?? "unknown",
          response.status,
        );
        if (quotaSource === "shared") {
          await Promise.all([accessRecord, backoffWrite.catch(() => undefined)]);
          return jsonResponse(
            { message: "GitHub GraphQL temporarily paused after upstream errors" },
            503,
            { "cache-control": "no-store", "x-releasebar-github-backoff": "graphql" },
          );
        }
        const durableBackoffWrite = backoffWrite.catch(() => undefined);
        if (context) {
          context.waitUntil(durableBackoffWrite);
        } else {
          await durableBackoffWrite;
        }
      }
      if (shouldWaitAccess || !context) await accessRecord;
    }
    return response;
  };
}
export function quotaFromResponse(response: Response, env: Env): ApiQuota {
  const remaining = parseHeaderInt(response.headers.get("x-ratelimit-remaining"));
  const limit = parseHeaderInt(response.headers.get("x-ratelimit-limit"));
  const reset = parseHeaderInt(response.headers.get("x-ratelimit-reset"));
  return {
    source: env.GITHUB_TOKEN ? "shared" : "anonymous",
    account: null,
    remaining,
    limit,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource: response.headers.get("x-ratelimit-resource"),
  };
}

export function parseHeaderInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRateLimitResponse(response: Response, message: string): boolean {
  return (
    response.status === 429 ||
    /rate limit|secondary rate|abuse detection/i.test(message) ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
  );
}

export function quotaFromGitHubResponse(
  response: Response,
  source: ApiQuota["source"],
  account: string | null,
): ApiQuota {
  const quota = quotaFromResponse(response, {
    GITHUB_TOKEN: source === "anonymous" ? undefined : "token",
  } as Env);
  return { ...quota, source, account };
}

function incrementSummary(map: Map<string, number>, key: string, count: number): void {
  map.set(key, (map.get(key) ?? 0) + count);
}

function summaryRows(map: Map<string, number>): Array<{ key: string; count: number }> {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export async function githubAccessSummary(
  env: Env,
  hours = githubAccessAdminHours,
): Promise<GitHubAccessSummary> {
  const cooldown = await sharedQuotaCooldown(env);
  const sinceHour = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().slice(0, 13);
  const { counts: counters, complete } = await listGitHubAccessCounts(env, sinceHour);
  if (!complete) {
    console.warn(JSON.stringify({ area: "github", event: "access_summary_truncated", hours }));
  }

  const byArea = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const routeCounts = new Map<string, GitHubAccessRouteSummary>();
  let total = 0;
  for (const counter of counters) {
    const count = counter.count;
    total += count;
    incrementSummary(byArea, counter.area, count);
    incrementSummary(bySource, `${counter.source}:${counter.account ?? "_"}`, count);
    incrementSummary(
      byStatus,
      `${counter.status}:${counter.resource ?? "_"}:${counter.area}`,
      count,
    );
    const routeKey = `${counter.area}:${counter.status}:${counter.source}:${counter.account ?? "_"}:${counter.resource ?? "_"}:${counter.route}`;
    const existing = routeCounts.get(routeKey);
    routeCounts.set(routeKey, {
      key: routeKey,
      area: counter.area,
      route: counter.route,
      status: counter.status,
      source: counter.source,
      account: counter.account ?? null,
      resource: counter.resource ?? null,
      count: (existing?.count ?? 0) + count,
      lastAt:
        !existing?.lastAt || (counter.lastAt && safeIso(counter.lastAt) > safeIso(existing.lastAt))
          ? counter.lastAt
          : existing.lastAt,
      lastPath:
        !existing?.lastAt || (counter.lastAt && safeIso(counter.lastAt) > safeIso(existing.lastAt))
          ? counter.lastPath
          : existing.lastPath,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    hours,
    buckets: counters.length,
    total,
    cooldown,
    byArea: summaryRows(byArea),
    bySource: summaryRows(bySource),
    byStatus: summaryRows(byStatus),
    topRoutes: [...routeCounts.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, githubAccessAdminRouteLimit),
  };
}
