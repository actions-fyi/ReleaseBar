import { expect, test, vi } from "vitest";
import { buildDashboard, dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload } from "../src/types.ts";
import {
  BuildCoordinator,
  buildLocksHeld,
  refreshAuditEvents,
  testDashboard,
  testProject,
  worker,
  seedOwnerMetadata,
  cacheWith,
  holdQueue,
} from "./dashboard-test-harness.ts";

test("worker rejects POST to reserved read-only owner-like APIs", async () => {
  for (const path of ["/api/me", "/api/_hot", "/api/_discover"]) {
    const response = await worker.fetch(
      new Request(`https://release.bar${path}`, { method: "POST" }),
      {},
      { waitUntil: () => undefined },
    );
    expect(response.status, path).toBe(405);
  }
});

test("worker marks GitHub discovery hydration complete when release scan is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      return Response.json({
        total_count: 1,
        items: [
          {
            name: "releasebar",
            full_name: "acme/releasebar",
            private: false,
            fork: false,
            archived: false,
            html_url: "https://github.com/acme/releasebar",
            description: "Release dashboard",
            default_branch: "main",
            language: "TypeScript",
            stargazers_count: 1200,
            forks_count: 42,
            open_issues_count: 7,
            pushed_at: "2026-05-16T12:00:00Z",
            updated_at: "2026-05-16T12:00:00Z",
            owner: { login: "acme" },
          },
        ],
      });
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const waitUntil: Promise<unknown>[] = [];
  const env = {};
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntil.push(promise);
        },
      },
    );
    expect(response.status).toBe(200);
    await Promise.all(waitUntil.splice(0));
    const cached = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    const body = (await cached.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("fresh");
    expect(body.cache?.progress?.done).toBe(true);
    expect(body.projects[0]?.version).toBe("repo search");
    expect(body.cache?.message ?? "").toMatch(/release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker pauses shared quota after discovery secondary rate limits", async () => {
  const cache = await cacheWith();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { message: "You have exceeded a secondary rate limit" },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-resource": "search",
        },
      },
    );
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      { GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(429);
    const cooldown = JSON.parse((await cache.get("github:budget:v1:shared:search")) ?? "{}") as {
      active?: boolean;
      resource?: string;
      reason?: string;
      resetAt?: string | null;
    };
    expect(cooldown.active).toBe(true);
    expect(cooldown.resource).toBe("search");
    expect(cooldown.reason).toBe("rate limited status 403");
    expect(typeof cooldown.resetAt).toBe("string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker falls back to stale discovery cache when GitHub search is rate limited", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [testProject({ owner: "cached", name: "repo" })]);
  await cacheWith({
    "discover:v4:week:all": JSON.stringify({
      ...cached,
      title: "GitHub Hot",
      owners: [],
      generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }),
  });
  const env = {};
  globalThis.fetch = async () =>
    Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("stale");
    expect(body.projects[0]?.fullName).toBe("cached/repo");
    expect(body.cache?.message ?? "").toMatch(/cached search/);
    expect(body.cache?.message ?? "").not.toMatch(/install the app/i);

    const coldResponse = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=month"),
      {},
      { waitUntil: () => undefined },
    );
    expect(coldResponse.status).toBe(429);
    const coldBody = (await coldResponse.json()) as DashboardPayload;
    expect(coldBody.cache?.state).toBe("error");
    expect(coldBody.cache?.message ?? "").toMatch(/repository search quota is exhausted/);
    expect(coldBody.cache?.message ?? "").not.toMatch(/install the app/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker returns dashboard-shaped rate-limit errors without raw GitHub JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/vincentkoc") {
      return Response.json(
        {
          message: "API rate limit exceeded for user ID 58493",
          documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
          status: "403",
        },
        { status: 403 },
      );
    }
    return Response.json({ message: "API rate limit exceeded" }, { status: 403 });
  };
  const env = {
    GITHUB_TOKEN: "shared-token",
  };
  const waits: Array<Promise<unknown>> = [];
  const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    expect(response.status).toBe(429);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("error");
    expect(body.owners[0]?.login).toBe("vincentkoc");
    expect(body.projects).toStrictEqual([]);
    expect(body.cache?.message ?? "").toMatch(/shared API quota is exhausted/);
    expect(body.cache?.message ?? "").not.toMatch(/58493|documentation_url|request ID/i);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/vincentkoc"),
      env,
      context,
    );
    expect(cached.status).toBe(429);
    await cached.arrayBuffer();
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dashboard build records GitHub quota headers", async () => {
  const resetAt = Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000);
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [{ type: "user", login: "owner" }],
    includeForks: false,
    includeArchived: false,
    token: "installation-token",
    quotaSource: "app",
    quotaAccount: "owner",
    repoLimit: 200,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") {
        return Response.json(
          {
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
          {
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-reset": String(resetAt),
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected fetch ${path}`);
    },
  });

  expect(payload.cache?.quota?.source).toBe("app");
  expect(payload.cache?.quota?.account).toBe("owner");
  expect(payload.cache?.quota?.limit).toBe(5000);
  expect(payload.cache?.quota?.remaining).toBe(4998);
  expect(payload.cache?.quota?.resetAt).toBe("2026-05-15T13:00:00.000Z");
  expect(payload.cache?.quota?.resource).toBe("graphql");
});

test("worker preserves cached quota metadata on fresh responses", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", []);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
    dashboard.cache.quota = {
      source: "app",
      account: "owner",
      limit: 5000,
      remaining: 4900,
      resetAt: "2026-05-15T13:00:00.000Z",
      resource: "graphql",
    };
  }

  await cacheWith({ [key]: JSON.stringify(dashboard) });
  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe(
    "public, max-age=60, stale-while-revalidate=300",
  );
  const body = (await response.json()) as DashboardPayload;
  expect(body.cache?.state).toBe("fresh");
  expect(body.cache?.quota?.source).toBe("app");
  expect(body.cache?.quota?.remaining).toBe(4900);
});

test("worker streams cached dashboard snapshots over owner events", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  await cacheWith({ [key]: JSON.stringify(dashboard) });
  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    {},
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const text = await response.text();
  expect(text).toMatch(/event: dashboard/);
  expect(text).toMatch(/owner\/repo/);
});

test("worker records dashboard stream sync audits", async () => {
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  await cacheWith({ [key]: JSON.stringify(dashboard) });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner/events"),
    {},
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  await response.text();
  const events = await refreshAuditEvents();
  expect(events.some((event) => event.event === "dashboard_stream_start")).toBe(true);
  const send = events.find((event) => event.event === "dashboard_stream_send");
  expect(send?.status).toBe("fresh");
  expect(send?.projects).toBe(1);
  const done = events.find((event) => event.event === "dashboard_stream_done");
  expect(done?.events).toBe(1);
});

test("worker keeps owner events working for the repos owner slug", async () => {
  const key = dashboardCacheKey({ owner: "repos", includeUnreleased: true, schemaVersion: 6 });
  const dashboard = testDashboard("repos", [testProject({ owner: "repos", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  await cacheWith({ [key]: JSON.stringify(dashboard) });
  const response = await worker.fetch(
    new Request("https://release.bar/api/repos/events"),
    {},
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  const text = await response.text();
  expect(text).toMatch(/event: dashboard/);
  expect(text).toMatch(/repos\/repo/);
});

test("worker returns rebuilding while another isolate owns the dashboard build lock", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  buildLocksHeld();
  const waits: Promise<unknown>[] = [];

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw"),
      {
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("rebuilding");
    // The background work ends while the lock is still held.
    await Promise.allSettled(waits);
    expect(repoFetches).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses an in-isolate build lease when Durable Objects fail open", async () => {
  const originalFetch = globalThis.fetch;
  await cacheWith();
  let graphqlCalls = 0;
  let markGraphqlStarted: (() => void) | undefined;
  let releaseGraphql: (() => void) | undefined;
  const graphqlStarted = new Promise<void>((resolve) => {
    markGraphqlStarted = resolve;
  });
  const graphqlGate = new Promise<void>((resolve) => {
    releaseGraphql = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/local") {
      return Response.json({ login: "local", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      markGraphqlStarted?.();
      await graphqlGate;
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  vi.spyOn(BuildCoordinator.prototype, "acquireLock").mockImplementation(() => {
    throw new Error("Durable Object unavailable");
  });
  holdQueue(async () => undefined);
  const env = {
    GITHUB_TOKEN: "shared-token",
  };

  try {
    const first = worker.fetch(new Request("https://release.bar/api/local"), env, {
      waitUntil: () => undefined,
    });
    await graphqlStarted;
    const second = await worker.fetch(new Request("https://release.bar/api/local"), env, {
      waitUntil: () => undefined,
    });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as DashboardPayload;
    expect(secondBody.cache?.state).toBe("rebuilding");
    releaseGraphql?.();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(graphqlCalls).toBe(1);
  } finally {
    releaseGraphql?.();
    globalThis.fetch = originalFetch;
  }
});

test("worker does not display dashboard data past the stale display window", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/old") {
      return Response.json({ login: "old", type: "User" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  buildLocksHeld();
  const key = dashboardCacheKey({ owner: "old", schemaVersion: 6 });
  const dashboard = testDashboard("old", [testProject({ owner: "old", name: "ancient" })]);
  dashboard.generatedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }

  try {
    await cacheWith({ [key]: JSON.stringify(dashboard) });
    const response = await worker.fetch(
      new Request("https://release.bar/api/old"),
      {
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("rebuilding");
    expect(body.projects.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves partial cached sources while combined dashboard rebuilds", async () => {
  const originalFetch = globalThis.fetch;
  let repoFetches = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    if (url.pathname.includes("/repos")) {
      repoFetches += 1;
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  buildLocksHeld();
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 6 });
  const now = new Date().toISOString();
  const alphaSource = testProject({ owner: "alpha", name: "one", openIssues: 1 });
  const alphaMetadata = testProject({
    owner: "alpha",
    name: "one",
    openIssues: 9,
    version: "repo search",
    releaseDate: null,
  });

  try {
    await seedOwnerMetadata(
      "alpha",
      JSON.stringify({
        owner: "alpha",
        generatedAt: now,
        metadataUpdatedAt: now,
        countsUpdatedAt: now,
        projects: [alphaMetadata],
      }),
    );
    await cacheWith({
      [alphaKey]: JSON.stringify(testDashboard("alpha", [alphaSource])),
      [betaKey]: JSON.stringify(
        testDashboard("beta", [testProject({ owner: "beta", name: "two" })]),
      ),
    });
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta"),
      {
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("partial");
    expect(body.projects.map((project) => project.fullName).sort()).toStrictEqual([
      "alpha/one",
      "beta/two",
    ]);
    expect(body.totals.repos).toBe(2);
    expect(body.cache?.countsUpdatedAt).toBe(null);
    expect(body.cache?.releasesUpdatedAt).toBe(null);
    expect(body.cache?.ciUpdatedAt).toBe(null);
    const mergedAlpha = body.projects.find((project) => project.fullName === "alpha/one");
    expect(mergedAlpha?.openIssues).toBe(9);
    expect(mergedAlpha?.version).toBe(alphaSource.version);
    expect(mergedAlpha?.releaseDate).toBe(alphaSource.releaseDate);
    expect(repoFetches).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
