import { generateKeyPairSync } from "node:crypto";
import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../dashboard.js";
import type { DashboardPayload, RefreshJob } from "../../../src/types.js";
import {
  kvStore,
  signedJson,
  testDashboard,
  testProject,
  worker,
} from "../dashboard-test-harness.js";

test("worker only exposes public selected installation repositories", async () => {
  const sessionId = "session-public-repos";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
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
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "steipete",
              type: "User",
              avatar_url: "https://avatars.githubusercontent.com/u/58493",
              html_url: "https://github.com/steipete",
            },
            html_url: "https://github.com/settings/installations/1",
            repository_selection: "selected",
            target_type: "User",
          },
        ],
      });
    }
    if (url.pathname === "/user/installations/1/repositories") {
      return Response.json({
        repositories: [
          {
            full_name: "steipete/public-repo",
            private: false,
            visibility: "public",
          },
          {
            full_name: "steipete/private-repo",
            private: true,
            visibility: "private",
          },
          {
            full_name: "steipete/contradictory-private-repo",
            private: true,
            visibility: "public",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/?repos=steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.installations[0].repositories).toStrictEqual(["steipete/public-repo"]);
    expect(body.installNeeded).toBe(false);

    const repoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    expect(repoRoute.status).toBe(200);
    const repoRouteBody = await repoRoute.json<any>();
    expect(repoRouteBody.installNeeded).toBe(false);

    const escapedRepoRoute = await worker.fetch(
      new Request(
        `https://release.bar/api/me?returnTo=${encodeURIComponent("/-/steipete/public-repo")}`,
        {
          headers: { cookie: `rd_session=${authCookie}` },
        },
      ),
      env,
      { waitUntil: () => undefined },
    );
    expect(escapedRepoRoute.status).toBe(200);
    const escapedRepoRouteBody = await escapedRepoRoute.json<any>();
    expect(escapedRepoRouteBody.installNeeded).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker allows mixed-account dashboards to use partitioned App quota", async () => {
  const sessionId = "session-2";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
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
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: ["openclaw", "steipete"].map((login, index) => ({
          id: index + 1,
          account: {
            login,
            type: index === 0 ? "Organization" : "User",
            avatar_url: `https://avatars.githubusercontent.com/u/${index + 2}`,
            html_url: `https://github.com/${login}`,
          },
          html_url: `https://github.com/settings/installations/${index + 1}`,
          repository_selection: "all",
          target_type: index === 0 ? "Organization" : "User",
        })),
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.installNeeded).toBe(false);
    expect(body.installReason).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps signed-in mixed-account dashboards on shared release scans", async () => {
  const sessionId = "session-mixed-dashboard";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
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
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const graphqlIncludeReleases: boolean[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      expect(authorization).toBe("Bearer user-token");
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/users/openclaw") {
      expect(authorization).toBe("Bearer shared-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/users/steipete") {
      expect(authorization).toBe("Bearer shared-token");
      return Response.json({ login: "steipete", type: "User" });
    }
    if (url.pathname === "/graphql") {
      expect(authorization).toBe("Bearer shared-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { includeReleases?: boolean };
      };
      graphqlIncludeReleases.push(Boolean(body.variables?.includeReleases));
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
            "x-ratelimit-remaining": "4996",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw?owners=steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(graphqlIncludeReleases).toStrictEqual([false, false]);
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("cold-metadata");
    expect(body.cache?.quota?.source).toBe("shared");
    expect(body.cache?.quota?.remaining).toBe(4996);
    expect(body.cache?.message ?? "").not.toMatch(/release scan skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured owner dashboards metadata-only", async () => {
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
  const env = {
    DASHBOARD_CACHE: kvStore({
      [releaseKey]: JSON.stringify(releasePayload),
    }),
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  };
  const fetchedPaths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    fetchedPaths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/users/owner/repos") {
      return Response.json([
        {
          owner: { login: "owner" },
          name: "repo",
          full_name: "owner/repo",
          description: null,
          html_url: "https://github.com/owner/repo",
          default_branch: "main",
          language: "TypeScript",
          topics: ["releasebar"],
          stargazers_count: 10,
          forks_count: 1,
          open_issues_count: 2,
          archived: false,
          pushed_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(fetchedPaths).toStrictEqual(["/users/owner", "/users/owner/repos"]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("cookie");
    expect(body.projects[0]?.version).toBe("repo search");
    expect(body.projects[0]?.commitsSinceRelease).toBe(null);
    expect(body.projects[0]?.openIssues).toBe(null);
    expect(body.projects[0]?.openPullRequests).toBe(null);
    expect(body.cache?.countsUpdatedAt).toBe(null);
    expect(body.cache?.message ?? "").toMatch(/release scan skipped/);
    expect(body.projects[0]?.releaseName).not.toBe("hydrated release cache");
    expect(await env.DASHBOARD_CACHE.get("hot:index:v3")).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses GitHub App installation token for cold owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-3";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
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
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  let ownerResolvedWithInstallationToken = false;
  let appRestFallbacks = 0;
  const appReleasePageSizes: number[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      expect(authorization).toBe("Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/1/access_tokens") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      expect(authorization).toBe("Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/orgs/openclaw/repos") {
      expect(authorization).toBe("Bearer installation-token");
      appRestFallbacks += 1;
      return Response.json([]);
    }
    if (url.pathname === "/graphql") {
      expect(authorization).toBe("Bearer installation-token");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; includeReleases?: boolean };
      };
      if (!body.variables?.includeReleases) {
        return Response.json({ message: "upstream unavailable" }, { status: 502 });
      }
      if (body.variables?.includeReleases && body.variables.first) {
        appReleasePageSizes.push(body.variables.first);
      }
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
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
            "x-ratelimit-remaining": "4997",
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(200);
    expect(ownerResolvedWithInstallationToken).toBe(true);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(body.cache?.quota?.source).toBe("app");
    expect(body.cache?.quota?.account).toBe("openclaw");
    expect(body.cache?.quota?.remaining).toBe(null);
    expect(appRestFallbacks).toBe(1);
    expect(appReleasePageSizes).toStrictEqual([50]);
    assert.ok(
      await env.DASHBOARD_CACHE.get(
        "github:backoff:v2:graphql:app:openclaw:ReleaseBarOwnerRepos.metadata",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses registered source-owned app tokens for anonymous owner dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const auditLogs: unknown[] = [];
  const waits: Promise<unknown>[] = [];
  let ownerResolvedWithInstallationToken = false;
  console.log = (message?: unknown) => {
    if (typeof message === "string" && message.includes("github_token_use")) {
      auditLogs.push(JSON.parse(message));
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/1/access_tokens") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/users/openclaw") {
      expect(authorization).toBe("Bearer installation-token");
      ownerResolvedWithInstallationToken = true;
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      expect(authorization).toBe("Bearer installation-token");
      return Response.json(
        {
          data: {
            repositoryOwner: {
              __typename: "Organization",
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
            "x-ratelimit-reset": String(Math.floor(Date.parse("2026-05-15T13:00:00Z") / 1000)),
            "x-ratelimit-resource": "graphql",
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(response.status).toBe(200);
    expect(ownerResolvedWithInstallationToken).toBe(true);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(body.cache?.quota?.source).toBe("app");
    expect(body.cache?.quota?.account).toBe("openclaw");
    expect(body.cache?.quota?.remaining).toBe(4998);
    expect(
      auditLogs.some(
        (entry) =>
          (entry as { event?: string; quota?: { source?: string; account?: string } }).event ===
            "github_token_use" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.source === "app" &&
          (entry as { quota?: { source?: string; account?: string } }).quota?.account ===
            "openclaw",
      ),
    ).toBe(true);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps stale source installation coverage when discovery fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore({
    "auth:installation:v1:openclaw": JSON.stringify({
      id: 1,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
    }),
    "auth:installation-token:1": "installation-token",
  });
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  let discoveryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      discoveryCalls += 1;
      return Response.json({ message: "temporarily unavailable" }, { status: 503 });
    }
    if (url.pathname === "/users/openclaw") {
      expect(authorization).toBe("Bearer installation-token");
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      expect(authorization).toBe("Bearer installation-token");
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
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

  try {
    const response = await worker.fetch(new Request("https://release.bar/api/openclaw"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(discoveryCalls).toBe(1);
    expect(body.cache?.quota?.source).toBe("app");
    expect(body.cache?.quota?.account).toBe("openclaw");
    expect(await cache.get("auth:installation-miss:v1:openclaw")).toBe(null);
    expect(await cache.get("auth:installation:v1:openclaw")).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
