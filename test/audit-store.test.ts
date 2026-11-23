// The audit data in the local D1 database and the rate limiter Durable Object, through
// the store functions the Worker calls.
import { env as runtimeEnv } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { AuthFunnelEvent, SchedulerAuditEvent } from "../src/types.ts";
import { deleteExpiredAuditRows } from "../worker/audit-retention.ts";
import { githubAccessSummary, recordAuditedGitHubAccess } from "../worker/github-audit.ts";
import {
  appendAuthFunnelEvent,
  authFunnelCountInventory,
  listAuthFunnelEvents,
} from "../worker/store/auth-funnel.ts";
import { countGitHubAccess, listGitHubAccessCounts } from "../worker/store/github-access.ts";
import { rateLimitReached } from "../worker/store/rate-limits.ts";
import { appendRefreshAuditEvent, listRefreshAuditEvents } from "../worker/store/refresh-audit.ts";
import {
  kvStore,
  objectsUnavailable,
  RateLimiter,
  testEnv,
  worker,
} from "./dashboard-test-harness.ts";

const dayMs = 24 * 60 * 60 * 1000;

function funnelEvent(id: string, at: string, account: string | null = null): AuthFunnelEvent {
  return {
    id,
    at,
    event: "login_start",
    account,
    installationId: null,
    repositorySelection: null,
    status: "ok",
    detail: null,
  };
}

async function rowCount(table: string): Promise<number> {
  const row = await runtimeEnv.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

test("the rate limiter loses no count under concurrent calls", async () => {
  const env = testEnv({});
  const minute = Math.floor(Date.now() / 60_000);

  const verdicts = await Promise.all(
    Array.from({ length: 100 }, () =>
      rateLimitReached(env, "client-timing", "client-a", minute, 30),
    ),
  );

  expect(verdicts.filter((reached) => !reached).length).toBe(30);
  expect(verdicts.filter((reached) => reached).length).toBe(70);
  // Another client, another endpoint and the next minute each have their own count.
  expect(await rateLimitReached(env, "client-timing", "client-b", minute, 30)).toBe(false);
  expect(await rateLimitReached(env, "install-callback", "client-a", minute, 1)).toBe(false);
  expect(await rateLimitReached(env, "install-callback", "client-a", minute, 1)).toBe(true);
  expect(await rateLimitReached(env, "client-timing", "client-a", minute + 1, 30)).toBe(false);
});

test("the client timing endpoint drops the timing and answers as usual when the rate limiter is unreachable", async () => {
  objectsUnavailable(RateLimiter);
  const waits: Array<Promise<unknown>> = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/_client-timing", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ source: "fetch", path: "/owner", totalMs: 12 }),
    }),
    { DASHBOARD_CACHE: kvStore() },
    { waitUntil: (promise) => waits.push(promise) },
  );
  await Promise.all(waits);

  expect(response.status).toBe(202);
  expect(await response.json()).toStrictEqual({ ok: true });
  expect(await rowCount("refresh_audit_events")).toBe(0);
});

test("an install callback without fresh state answers 503 and asks GitHub nothing when the rate limiter is unreachable", async () => {
  objectsUnavailable(RateLimiter);
  const fetched: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", { status: 500 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=101&setup_action=install", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      }),
      {
        AUTH_COOKIE_SECRET: "test-secret",
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "unused",
        DASHBOARD_CACHE: kvStore(),
      },
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetched).toStrictEqual([]);
    expect(await rowCount("auth_funnel_events")).toBe(0);
    expect(await rowCount("installations")).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the client timing endpoint stores 30 timings a minute for a client sending 40 at once", async () => {
  const env = { DASHBOARD_CACHE: kvStore() };
  const waits: Array<Promise<unknown>> = [];
  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      worker.fetch(
        new Request("https://release.bar/api/_client-timing", {
          method: "POST",
          headers: { "cf-connecting-ip": "203.0.113.7" },
          body: JSON.stringify({ source: "fetch", path: "/owner", totalMs: 12 }),
        }),
        env,
        { waitUntil: (promise) => waits.push(promise) },
      ),
    ),
  );
  await Promise.all(waits);

  expect(responses.filter((response) => response.status === 202).length).toBe(30);
  expect(responses.filter((response) => response.status === 204).length).toBe(10);
  expect(await rowCount("refresh_audit_events")).toBe(30);
});

test("the refresh audit log lists the newest events first, up to the limit", async () => {
  const env = testEnv({});
  const now = Date.now();
  const events: SchedulerAuditEvent[] = Array.from({ length: 5 }, (_, index) => ({
    id: `event-${index}`,
    event: "job_start",
    at: new Date(now - index * 1000).toISOString(),
    scanned: index === 0 ? null : index,
    done: index % 2 === 0,
  }));
  for (const event of events.toReversed()) await appendRefreshAuditEvent(env, event);

  expect(await listRefreshAuditEvents(env, 3)).toStrictEqual(events.slice(0, 3));
});

test("GitHub call counts add up across concurrent writers and hours", async () => {
  const env = testEnv({});
  const call = {
    key: "dashboard:200:shared:_:core:users/:owner",
    area: "dashboard",
    route: "users/:owner",
    status: 200,
    source: "shared" as const,
    account: null,
    resource: "core",
  };
  await Promise.all(
    Array.from({ length: 40 }, (_, index) =>
      countGitHubAccess(env, [
        {
          ...call,
          count: 1,
          lastAt: `2026-06-13T11:00:${String(index).padStart(2, "0")}.000Z`,
          lastPath: `/users/owner-${index}`,
        },
      ]),
    ),
  );
  await countGitHubAccess(env, [
    { ...call, count: 2, lastAt: "2026-06-13T12:00:00.000Z", lastPath: "/users/later" },
    {
      ...call,
      key: "other",
      route: "graphql",
      count: 5,
      lastAt: "2026-06-13T12:00:01.000Z",
      lastPath: null,
    },
    // Older than the row's last call: counted, but not the last path.
    { ...call, count: 1, lastAt: "2026-06-13T11:00:00.000Z", lastPath: "/users/earlier" },
  ]);

  const { counts, complete } = await listGitHubAccessCounts(env, "2026-06-13T11");
  expect(complete).toBe(true);
  expect(
    counts.map((count) => [count.key, count.count, count.lastAt, count.lastPath]),
  ).toStrictEqual([
    [call.key, 41, "2026-06-13T11:00:39.000Z", "/users/owner-39"],
    [call.key, 2, "2026-06-13T12:00:00.000Z", "/users/later"],
    ["other", 5, "2026-06-13T12:00:01.000Z", null],
  ]);
  expect((await listGitHubAccessCounts(env, "2026-06-13T12")).counts.length).toBe(2);
});

test("GitHub calls of one request are counted in batches, and the summary adds the hours up", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  let batches = 0;
  const database = new Proxy(env.DB, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property);
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          batches += 1;
          return target.batch(statements);
        };
      }
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const countingEnv = { ...env, DB: database };
  const waits: Array<Promise<unknown>> = [];
  const context = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise) };
  const quota = {
    source: "shared" as const,
    account: null,
    remaining: 4900,
    limit: 5000,
    resetAt: null,
    resource: "core",
  };
  for (let index = 0; index < 50; index += 1) {
    void recordAuditedGitHubAccess(
      countingEnv,
      "dashboard",
      index % 2 ? "/users/owner" : "/repos/owner/repo/releases",
      200,
      quota,
      false,
      false,
      context,
    );
  }
  await Promise.all(waits);

  expect(batches).toBeLessThanOrEqual(2);
  const summary = await githubAccessSummary(env);
  expect(summary.total).toBe(50);
  expect(summary.buckets).toBe(2);
  expect(summary.byArea).toStrictEqual([{ key: "dashboard", count: 50 }]);
  expect(summary.topRoutes.map((route) => [route.route, route.count])).toStrictEqual([
    ["repos/:owner/:repo/releases", 25],
    ["users/:owner", 25],
  ]);
});

test("sign-in funnel events are stored with a count per day, event, account and status", async () => {
  const env = testEnv({});
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      appendAuthFunnelEvent(
        env,
        funnelEvent(
          `event-${index}`,
          new Date(now.getTime() - index * 1000).toISOString(),
          index < 5 ? "acme" : null,
        ),
      ),
    ),
  );

  const events = await listAuthFunnelEvents(env, 10);
  expect(events.map((event) => event.id)).toStrictEqual(
    Array.from({ length: 10 }, (_, index) => `event-${index}`),
  );
  expect(events[0]).toStrictEqual(funnelEvent("event-0", now.toISOString(), "acme"));
  expect(await authFunnelCountInventory(env, 80)).toStrictEqual({
    total: 2,
    counts: [
      { key: `${today}:login_start:_:ok`, count: 20 },
      { key: `${today}:login_start:acme:ok`, count: 5 },
    ],
  });
});

test("the scheduled handler deletes audit rows past their retention and keeps the rest", async () => {
  const fakes = { DASHBOARD_CACHE: kvStore() };
  const env = testEnv(fakes);
  const now = Date.now();
  const iso = (daysAgo: number): string => new Date(now - daysAgo * dayMs).toISOString();
  for (const [id, daysAgo] of [
    ["old", 15],
    ["kept", 13],
  ] as const) {
    await appendRefreshAuditEvent(env, { id, event: "job_start", at: iso(daysAgo) });
    await countGitHubAccess(env, [
      {
        key: "route",
        area: "dashboard",
        route: "graphql",
        status: 200,
        source: "shared",
        account: null,
        resource: null,
        count: 1,
        lastAt: iso(daysAgo),
        lastPath: null,
      },
    ]);
  }
  for (const [id, daysAgo] of [
    ["old", 91],
    ["kept", 89],
  ] as const) {
    await appendAuthFunnelEvent(env, funnelEvent(id, iso(daysAgo)));
    await runtimeEnv.DB.prepare(
      "INSERT INTO auth_funnel_counts (day, event, account, status, count) VALUES (?, 'x', '_', '_', 1)",
    )
      .bind(iso(daysAgo).slice(0, 10))
      .run();
  }

  await deleteExpiredAuditRows(env, now);

  expect((await listRefreshAuditEvents(env, 10)).map((event) => event.id)).toStrictEqual(["kept"]);
  expect((await listGitHubAccessCounts(env, "")).counts.map((count) => count.lastAt)).toStrictEqual(
    [iso(13)],
  );
  expect((await listAuthFunnelEvents(env, 10)).map((event) => event.id)).toStrictEqual(["kept"]);
  // Today's count of the two events, and the one of 89 days ago.
  expect(await rowCount("auth_funnel_counts")).toBe(2);

  // The scheduled handler runs the same deletion.
  await appendRefreshAuditEvent(env, { id: "old-again", event: "job_start", at: iso(20) });
  const waits: Array<Promise<unknown>> = [];
  await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now }, fakes, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);
  const ids = (await listRefreshAuditEvents(env, 100)).map((event) => event.id);
  expect(ids).not.toContain("old-again");
  expect(ids).toContain("kept");
});

test("deleting expired audit rows is bounded per run", async () => {
  const env = testEnv({});
  const now = Date.now();
  const insert = runtimeEnv.DB.prepare(
    "INSERT INTO refresh_audit_events (id, at, event, data) VALUES (?, ?, 'job_start', '{}')",
  );
  const old = new Date(now - 20 * dayMs).toISOString();
  for (let page = 0; page < 6; page += 1) {
    await runtimeEnv.DB.batch(
      Array.from({ length: 1000 }, (_, index) => insert.bind(`old-${page}-${index}`, old)),
    );
  }
  await runtimeEnv.DB.batch(
    Array.from({ length: 100 }, (_, index) => insert.bind(`old-rest-${index}`, old)),
  );

  await deleteExpiredAuditRows(env, now);
  expect(await rowCount("refresh_audit_events")).toBe(1100);
  await deleteExpiredAuditRows(env, now);
  expect(await rowCount("refresh_audit_events")).toBe(0);
});
