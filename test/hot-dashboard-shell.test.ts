import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../dashboard.js";
import { attentionReasons, needsAttention, releaseDebtText } from "../../../src/dashboard-view.js";
import type { DashboardPayload } from "../../../src/types.js";
import { kvStore, testDashboard, testProject, worker } from "../dashboard-test-harness.js";

test("need attention explains release debt, stale releases, CI, and open work", () => {
  const stale = testProject({
    owner: "owner",
    name: "stale",
    releaseDate: "2026-01-01T00:00:00Z",
  });
  const pressured = testProject({
    owner: "owner",
    name: "pressure",
    commitsSinceRelease: 42,
    freshness: "hot",
    ciState: "failure",
    openPullRequests: 12,
    openIssues: 120,
  });
  const releaseDebt = testProject({
    owner: "owner",
    name: "release-debt",
    commitsSinceRelease: 201,
    freshness: "hot",
    releaseDate: "2026-05-01T00:00:00Z",
  });

  expect(needsAttention(stale)).toBe(true);
  expect(attentionReasons(stale, Date.parse("2026-05-15T00:00:00Z"))).toStrictEqual([
    "last release 134 days ago",
  ]);
  expect(needsAttention(pressured)).toBe(true);
  expect(attentionReasons(pressured)).toStrictEqual([
    "CI failing",
    "12 open PRs",
    "120 open issues",
  ]);
  expect(needsAttention(releaseDebt)).toBe(true);
  expect(needsAttention({ ...pressured, archived: true })).toBe(false);
  expect(releaseDebtText({ ...releaseDebt, archived: true })).toBe(null);
  expect(attentionReasons({ ...pressured, archived: true })).toStrictEqual([]);
  expect(attentionReasons(releaseDebt, Date.parse("2026-05-15T00:00:00Z"))).toStrictEqual([
    "201 commits since release",
  ]);
  expect(
    attentionReasons(
      testProject({ owner: "owner", name: "fresh" }),
      Date.parse("2026-05-15T00:00:00Z"),
    ).length,
  ).toBe(0);
  expect(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "warm",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
  ).toStrictEqual([]);
  expect(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "hot-placeholder",
        version: "repo search",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
  ).toStrictEqual([]);
  expect(
    attentionReasons(
      testProject({
        owner: "owner",
        name: "unreleased",
        version: "unreleased",
        releaseDate: null,
        commitsSinceRelease: null,
        compareUrl: null,
        freshness: "hot",
      }),
      Date.parse("2026-05-15T00:00:00Z"),
    ),
  ).toStrictEqual([]);
});

test("worker builds root hot dashboard from cached dashboards", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const betaKey = dashboardCacheKey({ owner: "beta", includeUnreleased: true, schemaVersion: 6 });
  const forksKey = dashboardCacheKey({ owner: "forks", includeForks: true, schemaVersion: 6 });
  const legacyKey = dashboardCacheKey({ owner: "legacy", schemaVersion: 5 });
  const env = {
    DASHBOARD_CACHE: kvStore({
      "hot:index:v3": JSON.stringify([alphaKey, legacyKey]),
      [alphaKey]: JSON.stringify(
        testDashboard("alpha", [
          testProject({
            owner: "alpha",
            name: "hot",
            commitsSinceRelease: 100,
            freshness: "hot",
          }),
          testProject({ owner: "alpha", name: "second", commitsSinceRelease: 80 }),
          testProject({ owner: "alpha", name: "third", commitsSinceRelease: 60 }),
          testProject({ owner: "alpha", name: "fourth", commitsSinceRelease: 40 }),
          testProject({
            owner: "alpha",
            name: "archived",
            archived: true,
            commitsSinceRelease: 120,
          }),
        ]),
      ),
      [betaKey]: JSON.stringify(
        testDashboard("beta", [
          testProject({
            owner: "beta",
            name: "popular",
            stars: 500,
            commitsSinceRelease: 20,
          }),
          testProject({
            owner: "beta",
            name: "unreleased",
            releaseDate: null,
            commitsSinceRelease: null,
          }),
        ]),
      ),
      [forksKey]: JSON.stringify({
        ...testDashboard("forks", [
          testProject({
            owner: "forks",
            name: "cached-fork",
            commitsSinceRelease: 500,
            freshness: "hot",
          }),
        ]),
        options: {
          includeForks: true,
          includeArchived: false,
          includeUnreleased: false,
          repoLimit: 200,
        },
      }),
      [legacyKey]: JSON.stringify(
        testDashboard("legacy", [
          testProject({
            owner: "legacy",
            name: "estimated-counts",
            stars: 10_000,
            openIssues: 500,
            openPullRequests: 100,
          }),
        ]),
      ),
      [dashboardCacheKey({ owner: "gamma", schemaVersion: 6 })]: JSON.stringify(
        testDashboard("gamma", [
          testProject({
            owner: "gamma",
            name: "from-list",
            commitsSinceRelease: 30,
          }),
        ]),
      ),
      "owner-metadata:v1:alpha": JSON.stringify({
        owner: "alpha",
        generatedAt: new Date().toISOString(),
        metadataUpdatedAt: new Date().toISOString(),
        countsUpdatedAt: new Date().toISOString(),
        releaseDataComplete: true,
        projects: [
          testProject({ owner: "alpha", name: "hot", openIssues: 99 }),
          testProject({ owner: "alpha", name: "second", archived: true }),
        ],
      }),
    }),
  };

  const response = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.title).toBe("ReleaseBar Hot");
  expect(body.owners).toStrictEqual([]);
  expect(body.projects[0]?.fullName).toBe("alpha/hot");
  expect(body.projects[0]?.openIssues).toBe(99);
  expect(body.projects.some((project) => project.fullName === "alpha/second")).toBe(false);
  expect(body.projects.some((project) => project.fullName === "alpha/archived")).toBe(false);
  expect(body.projects.some((project) => project.fullName === "beta/unreleased")).toBe(false);
  expect(body.projects.some((project) => project.fullName === "legacy/estimated-counts")).toBe(
    false,
  );
  expect(body.projects.some((project) => project.fullName === "forks/cached-fork")).toBe(false);
  expect(body.projects.some((project) => project.fullName === "gamma/from-list")).toBe(true);
  expect(body.projects.filter((project) => project.owner === "alpha").length <= 3).toBe(true);
  expect(body.cache?.message ?? "").toMatch(/cached dashboards/);

  const cachedResponse = await worker.fetch(new Request("https://release.bar/api/_hot"), env, {
    waitUntil: () => undefined,
  });
  const cachedBody = (await cachedResponse.json()) as DashboardPayload;
  expect(cachedBody.cache?.repoLimit).toBe(null);
  expect(cachedBody.cache?.message ?? "").toMatch(/cached dashboards/);
});

test("worker serves stale hot dashboards while one background rebuild refreshes the cache", async () => {
  const alphaKey = dashboardCacheKey({ owner: "alpha", includeUnreleased: true, schemaVersion: 6 });
  const staleAt = new Date(Date.now() - 1000).toISOString();
  const staleHot: DashboardPayload = {
    ...testDashboard("stale", [
      testProject({ owner: "stale", name: "cached", commitsSinceRelease: 5 }),
    ]),
    title: "ReleaseBar Hot",
    generatedAt: staleAt,
    owners: [],
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: null,
      generatedAt: staleAt,
    },
  };
  const cache = kvStore({
    "hot:v3": JSON.stringify(staleHot),
    "hot:v3:invalidated-at": staleAt,
    "hot:index:v3": JSON.stringify([alphaKey]),
    [alphaKey]: JSON.stringify(
      testDashboard("alpha", [
        testProject({ owner: "alpha", name: "fresh", commitsSinceRelease: 50 }),
      ]),
    ),
  });
  const waits: Array<Promise<unknown>> = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/_hot"),
    { DASHBOARD_CACHE: cache },
    { waitUntil: (promise) => waits.push(promise) },
  );
  const body = (await response.json()) as DashboardPayload;

  expect(response.status).toBe(200);
  expect(body.cache?.state).toBe("stale");
  expect(body.cache?.message ?? "").toMatch(/while it refreshes/);
  expect(body.projects[0]?.fullName).toBe("stale/cached");

  await Promise.all(waits);
  const refreshed = JSON.parse((await cache.get("hot:v3")) ?? "{}") as DashboardPayload;
  expect(refreshed.cache?.state).toBe("fresh");
  expect(refreshed.projects[0]?.fullName).toBe("alpha/fresh");
});

test("worker keeps hot owner route distinct from root hot API", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/hot") {
      return Response.json({ login: "hot", type: "User" });
    }
    if (url.pathname === "/users/hot/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/hot"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: (promise) => waits.push(promise) },
    );
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(response.status).toBe(200);
    expect(body.owners[0]?.login).toBe("hot");
    expect(body.title).not.toBe("ReleaseBar Hot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves escaped dotted repository detail paths as app shell", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/-/openclaw/react.dev"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe("/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/ReleaseBar release freshness dashboard for openclaw\/react\.dev/);
  expect(html).toMatch(
    /property="og:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
  expect(html).toMatch(
    /name="twitter:image" content="https:\/\/release\.bar\/og\/openclaw%2Freact\.dev\.png"/,
  );
});

test("worker reserves owner activity pages while escaped activity repositories remain available", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/acme/activity"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          expect(new URL(request.url).pathname).toBe("/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore(),
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/@acme activity/);
  expect(html).not.toMatch(/id="releasebar-initial-data"/);

  const escaped = await worker.fetch(
    new Request("https://release.bar/-/acme/activity"),
    {
      ASSETS: {
        fetch: async () =>
          new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
            { headers: { "content-type": "text/html" } },
          ),
      },
      DASHBOARD_CACHE: kvStore(),
    },
    { waitUntil: () => undefined },
  );
  expect(escaped.status).toBe(200);
  expect(await escaped.text()).toMatch(/acme\/activity/);

  for (const owner of ["api", "og"]) {
    const reserved = await worker.fetch(
      new Request(`https://release.bar/-/owners/${owner}/activity`),
      {
        ASSETS: {
          fetch: async (request: Request) => {
            expect(new URL(request.url).pathname).toBe("/index.html");
            return new Response(
              '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" />',
              { headers: { "content-type": "text/html" } },
            );
          },
        },
        DASHBOARD_CACHE: kvStore(),
      },
      { waitUntil: () => undefined },
    );
    expect(reserved.status).toBe(200);
    expect(await reserved.text()).toMatch(new RegExp(`@${owner} activity`));
  }
});

test("worker preserves API and social namespaces beside escaped reserved-owner activity pages", async () => {
  const generatedAt = new Date().toISOString();
  const dashboard = testDashboard("activity", []);
  dashboard.generatedAt = generatedAt;
  if (dashboard.cache && dashboard.options) {
    dashboard.cache.generatedAt = generatedAt;
    dashboard.options.includeUnreleased = true;
  }
  const key = dashboardCacheKey({
    owner: "activity",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const apiResponse = await worker.fetch(
    new Request("https://release.bar/api/activity"),
    {
      ASSETS: {
        fetch: async () => {
          throw new Error("API namespace must not reach app assets");
        },
      },
      DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    },
    { waitUntil: () => undefined },
  );
  expect(apiResponse.status).toBe(200);
  expect(apiResponse.headers.get("content-type") ?? "").toMatch(/^application\/json/);
  expect(((await apiResponse.json()) as DashboardPayload).owners[0]?.login).toBe("activity");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const socialResponse = await worker.fetch(
      new Request("https://release.bar/og/activity"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    expect(socialResponse.status).toBe(200);
    expect(socialResponse.headers.get("content-type") ?? "").toMatch(/^image\/svg\+xml/);
    expect(await socialResponse.text()).toMatch(/@activity/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached public dashboard data in the app shell", async () => {
  const payload = testDashboard("hot", [testProject({ owner: "acme", name: "releasebar" })]);
  const response = await worker.fetch(
    new Request("https://release.bar/"),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          expect(new URL(request.url).pathname).toBe("/index.html");
          return new Response(
            '<title>ReleaseBar</title><meta property="og:title" content="ReleaseBar" /><meta property="og:url" content="https://release.bar/" /><meta property="og:image" content="https://release.bar/og/ReleaseBar.svg" /><meta name="twitter:title" content="ReleaseBar" /><meta name="twitter:image" content="https://release.bar/og/ReleaseBar.svg" /><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toMatch(/id="releasebar-initial-data"/);
  expect(html).toMatch(/"route":"dashboard"/);
  expect(html).toMatch(/acme\\u002freleasebar|acme\/releasebar/);
  expect(html).toMatch(
    /property="og:title" content="ReleaseBar release freshness dashboard for ReleaseBar Hot"/,
  );
  expect(html).toMatch(
    /property="og:image" content="https:\/\/release\.bar\/og\/ReleaseBar%20Hot\.png"/,
  );
  assert.ok(html.indexOf('id="releasebar-initial-data"') < html.indexOf('<script type="module"'));
});

test("worker embeds cached metadata-only owner dashboard data in the app shell", async () => {
  const payload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  assert.ok(payload.options);
  assert.ok(payload.cache);
  payload.options = { ...payload.options, includeUnreleased: true };
  payload.cache = {
    ...payload.cache,
    message: "release scan skipped until GitHub App quota is available",
  };
  const metadataKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = {
    ...payload,
    projects: [
      testProject({
        owner: "owner",
        name: "repo",
        version: "v9.9.9",
        releaseName: "hydrated release cache",
      }),
    ],
  } satisfies DashboardPayload;
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async (request: Request) => {
          expect(new URL(request.url).pathname).toBe("/index.html");
          return new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
        },
      },
      DASHBOARD_CACHE: kvStore({
        [metadataKey]: JSON.stringify(payload),
        [releaseKey]: JSON.stringify(releasePayload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("cookie");
  expect(html).toMatch(/id="releasebar-initial-data"/);
  expect(html).toMatch(/owner\\u002frepo|owner\/repo/);
  expect(html).toMatch(/release scan skipped/);
  expect(html).not.toMatch(/hydrated release cache/);
});

test("worker does not embed a release-only cache for an unsynced owner dashboard", async () => {
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const releasePayload = testDashboard("owner", [
    testProject({
      owner: "owner",
      name: "repo",
      version: "v9.9.9",
      releaseName: "hydrated release cache",
    }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/owner", { headers: { cookie: "rd_session=bogus" } }),
    {
      ASSETS: {
        fetch: async () =>
          new Response(
            '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
            { headers: { "content-type": "text/html" } },
          ),
      },
      DASHBOARD_CACHE: kvStore({
        [releaseKey]: JSON.stringify(releasePayload),
      }),
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).not.toMatch(/hydrated release cache/);
  expect(html).not.toMatch(/id="releasebar-initial-data"/);
});
