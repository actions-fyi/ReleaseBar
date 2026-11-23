import { generateKeyPairSync } from "node:crypto";
import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RepoDetailPayload } from "../../../src/types.js";
import {
  crawlerRequest,
  kvStore,
  signedJson,
  testDashboard,
  testProject,
  worker,
} from "../dashboard-test-harness.js";

test("signed-in mixed-account fast paths preserve release dashboards", async () => {
  const sessionId = "session-mixed-cache";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const generatedAt = new Date().toISOString();
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const keyInput = {
    owner: "openclaw",
    owners: ["steipete"],
    includeUnreleased: true,
    schemaVersion: 6,
  };
  const metadataKey = dashboardCacheKey({ ...keyInput, includeReleaseData: false });
  const releaseKey = dashboardCacheKey({ ...keyInput, includeReleaseData: true });
  const metadataPayload = testDashboard("openclaw", [
    testProject({
      owner: "openclaw",
      name: "releasebar",
      version: "repo search",
      releaseName: "metadata cache",
    }),
  ]);
  metadataPayload.generatedAt = generatedAt;
  assert.ok(metadataPayload.cache);
  metadataPayload.cache = { ...metadataPayload.cache, generatedAt };
  const releasePayload = testDashboard("openclaw", [
    testProject({
      owner: "openclaw",
      name: "releasebar",
      version: "v1.2.3",
      releaseName: "hydrated release cache",
    }),
  ]);
  releasePayload.generatedAt = generatedAt;
  assert.ok(releasePayload.cache);
  releasePayload.cache = { ...releasePayload.cache, generatedAt };
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    ASSETS: {
      fetch: async () =>
        new Response(
          '<title>ReleaseBar</title><script type="module" src="/assets/index.js"></script>',
          { headers: { "content-type": "text/html" } },
        ),
    },
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
      [metadataKey]: JSON.stringify(metadataPayload),
      [releaseKey]: JSON.stringify(releasePayload),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const requestHeaders = { cookie: `rd_session=${authCookie}` };

  const apiResponse = await worker.fetch(
    new Request("https://release.bar/api/openclaw?owners=steipete", {
      headers: requestHeaders,
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(apiResponse.status).toBe(200);
  const apiPayload = (await apiResponse.json()) as DashboardPayload;
  expect(apiPayload.projects[0]?.releaseName).toBe("hydrated release cache");

  const pageResponse = await worker.fetch(
    new Request("https://release.bar/openclaw?owners=steipete", {
      headers: requestHeaders,
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(pageResponse.status).toBe(200);
  const html = await pageResponse.text();
  expect(html).toMatch(/hydrated release cache/);
  expect(html).not.toMatch(/metadata cache/);
});

test("worker embeds cached crawler dashboard shells without discovering app installs", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const payload = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  let installationListCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      installationListCalls += 1;
      return Response.json([]);
    }
    throw new Error(`crawler shell should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/owner", "Googlebot/2.1", null),
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
          [key]: JSON.stringify(payload),
        }),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toMatch(/id="releasebar-initial-data"/);
    expect(html).toMatch(/owner\\u002frepo|owner\/repo/);
    expect(installationListCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker embeds cached language-filtered discover data in the app shell", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&hotLang=TypeScript"),
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
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toMatch(/id="releasebar-initial-data"/);
  expect(html).toMatch(/typedbar/);
  expect(html).not.toMatch(/allbar/);
});

test("worker preserves partial discover state in embedded app shell data", async () => {
  const payload = testDashboard("all", [
    testProject({
      owner: "acme",
      name: "placeholder",
      version: "repo search",
      releaseDate: null,
      commitsSinceRelease: null,
      compareUrl: null,
    }),
  ]);
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 0, limit: 1, done: false },
  };
  const response = await worker.fetch(
    new Request("https://release.bar/"),
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
        "discover:v4:week:all": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toMatch(/id="releasebar-initial-data"/);
  expect(html).toMatch(/"state":"partial"/);
  expect(html).toMatch(/"done":false/);
});

test("worker does not treat view language filters as discover cache selectors", async () => {
  const allPayload = testDashboard("all", [testProject({ owner: "acme", name: "allbar" })]);
  const languagePayload = testDashboard("typescript", [
    testProject({ owner: "acme", name: "typedbar", language: "TypeScript" }),
  ]);
  const response = await worker.fetch(
    new Request("https://release.bar/?period=day&lang=TypeScript"),
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
        "discover:v4:day:all": JSON.stringify(allPayload),
        "discover:v4:day:typescript": JSON.stringify(languagePayload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toMatch(/id="releasebar-initial-data"/);
  expect(html).toMatch(/allbar/);
  expect(html).not.toMatch(/typedbar/);
});

test("worker embeds cached public repository detail data in the app shell", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({ owner: "acme", name: "releasebar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const response = await worker.fetch(
    new Request("https://release.bar/acme/releasebar"),
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
        "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
      }),
    },
    { waitUntil: () => undefined },
  );

  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toMatch(/id="releasebar-initial-data"/);
  expect(html).toMatch(/"route":"repo"/);
  expect(html).toMatch(/acme\\u002freleasebar|acme\/releasebar/);
  expect(html).toMatch(
    /property="og:title" content="ReleaseBar release freshness dashboard for acme\/releasebar"/,
  );
  expect(html).toMatch(
    /property="og:image" content="https:\/\/release\.bar\/og\/acme%2Freleasebar\.png"/,
  );
});

test("worker serves cached GitHub discovery dashboards from repository search", async () => {
  const originalFetch = globalThis.fetch;
  const searchItems = Array.from({ length: 13 }, (_, index) => {
    const name = index === 0 ? "releasebar" : `releasebar-${index + 1}`;
    return {
      name,
      full_name: `acme/${name}`,
      private: false,
      fork: false,
      archived: false,
      html_url: `https://github.com/acme/${name}`,
      description: "Release dashboard",
      default_branch: "main",
      language: "TypeScript",
      topics: ["releases", "dashboard"],
      stargazers_count: 1200 - index,
      forks_count: 42,
      open_issues_count: 7,
      pushed_at: "2026-05-16T12:00:00Z",
      updated_at: "2026-05-16T12:00:00Z",
      owner: { login: "acme" },
    };
  });
  let searchCalls = 0;
  const hydratedPaths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      searchCalls += 1;
      expect(url.searchParams.get("q") ?? "").toMatch(/language:"TypeScript"/);
      expect(url.searchParams.get("q") ?? "").toMatch(/pushed:>=/);
      expect(url.searchParams.get("sort")).toBe("stars");
      expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer shared-token");
      return Response.json(
        {
          total_count: searchItems.length,
          incomplete_results: false,
          items: searchItems,
        },
        {
          headers: {
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": "1770000000",
            "x-ratelimit-resource": "search",
          },
        },
      );
    }
    hydratedPaths.push(url.pathname);
    if (url.pathname.match(/^\/repos\/acme\/[^/]+\/releases$/)) {
      if (url.pathname === "/repos/acme/releasebar-13/releases") {
        return Response.json([]);
      }
      return Response.json([
        {
          tag_name: "v1.2.3",
          name: "Release 1.2.3",
          html_url: "https://github.com/acme/releasebar/releases/tag/v1.2.3",
          draft: false,
          published_at: "2026-05-15T00:00:00Z",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = {
    DASHBOARD_CACHE: kvStore(),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const first = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = (await first.json()) as DashboardPayload;
    expect(body.title).toBe("GitHub Hot");
    expect(body.projects[0]?.fullName).toBe("acme/releasebar");
    expect(body.projects[0]?.version).toBe("repo search");
    expect(body.projects[0]?.topics).toStrictEqual(["releases", "dashboard"]);
    expect(body.projects[0]?.openIssues).toBe(7);
    expect(body.cache?.state).toBe("partial");
    expect(body.cache?.progress?.done).toBe(false);
    expect(body.cache?.progress?.limit).toBe(searchItems.length);
    expect(body.cache?.quota?.remaining).toBe(4999);
    expect(body.cache?.message ?? "").toMatch(/repository search/);

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    expect(second.status).toBe(200);
    const firstBatch = (await second.json()) as DashboardPayload;
    expect(firstBatch.cache?.state).toBe("partial");
    expect(firstBatch.cache?.progress?.done).toBe(false);
    expect(firstBatch.cache?.progress?.scanned).toBe(8);
    expect(firstBatch.projects.filter((project) => project.version === "repo search").length).toBe(
      5,
    );

    await Promise.all(waitUntil.splice(0));

    const third = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week&lang=TypeScript"),
      env,
      context,
    );
    expect(third.status).toBe(200);
    const hydrated = (await third.json()) as DashboardPayload;
    expect(hydrated.cache?.state).toBe("fresh");
    expect(hydrated.cache?.progress?.done).toBe(true);
    expect(hydrated.cache?.progress?.scanned).toBe(searchItems.length);
    expect(hydrated.projects.filter((project) => project.version === "repo search").length).toBe(0);
    expect(hydrated.projects[0]?.version).toBe("v1.2.3");
    expect(hydrated.projects[0]?.commitsSinceRelease).toBe(null);
    expect(hydrated.projects[0]?.openPullRequests).toBe(0);
    expect(hydrated.projects[12]?.version).toBe("unreleased");
    expect(hydrated.projects[12]?.releaseDate).toBe(null);
    expect(searchCalls).toBe(1);
    expect(hydratedPaths.length).toBe(searchItems.length);
    expect(hydratedPaths.every((path) => /^\/repos\/acme\/[^/]+\/releases$/.test(path))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not rehydrate completed GitHub discovery cache", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: new Date().toISOString(),
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: new Date().toISOString(),
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async () => {
    throw new Error("discovery cache should not fetch");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/_discover?period=week"),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(body.projects[0]?.version).toBe("v2.0.0");
    expect(body.cache?.state).toBe("fresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale discovery caches to crawlers without searching GitHub", async () => {
  const originalFetch = globalThis.fetch;
  const cached = testDashboard("cached", [
    testProject({
      owner: "cached",
      name: "repo",
      version: "v2.0.0",
      releaseDate: "2026-05-16T00:00:00Z",
      commitsSinceRelease: 2,
    }),
  ]);
  const waits: Array<Promise<unknown>> = [];
  const env = {
    DASHBOARD_CACHE: kvStore({
      "discover:v4:week:all": JSON.stringify({
        ...cached,
        title: "GitHub Hot",
        owners: [],
        generatedAt: "2026-05-15T12:00:00Z",
        cache: {
          ...(cached.cache ?? {
            capped: false,
            repoLimit: 40,
            generatedAt: cached.generatedAt,
          }),
          state: "fresh",
          stale: false,
          generatedAt: "2026-05-15T12:00:00Z",
          progress: { scanned: 1, limit: 1, done: true },
        },
      }),
    }),
  };
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh discovery ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/_discover?period=week", "SemrushBot/7~bl", null),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as DashboardPayload;
    expect(body.projects[0]?.version).toBe("v2.0.0");
    expect(body.cache?.state).toBe("stale");
    expect(body.cache?.message).toBe("showing cached discovery results");
    expect(waits.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
