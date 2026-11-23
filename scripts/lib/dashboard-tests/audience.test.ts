import { generateKeyPairSync } from "node:crypto";
import { assert, expect, test } from "vitest";
import type { AudienceRange, RepoAudiencePayload } from "../../../src/types.js";
import { crawlerRequest, kvStore, signedJson, worker } from "../dashboard-test-harness.js";

test("worker builds cached repository audience from public stargazers", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/releasebar") {
      return Response.json({
        owner: { login: "acme" },
        name: "releasebar",
        full_name: "acme/releasebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/releasebar",
        description: "Release dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { owner?: string; name?: string; first?: number };
      };
      expect(body.variables?.owner).toBe("acme");
      expect(body.variables?.name).toBe("releasebar");
      expect(body.variables?.first).toBe(30);
      return Response.json({
        data: {
          repository: {
            stargazers: {
              edges: [
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "cabot",
                    avatarUrl: "https://avatars.githubusercontent.com/u/13",
                    url: "https://github.com/cabot",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "User",
                    login: "quiet",
                    avatarUrl: "https://avatars.githubusercontent.com/u/11",
                    url: "https://github.com/quiet",
                  },
                },
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    __typename: "Bot",
                    login: "renovate-bot",
                    avatarUrl: "https://avatars.githubusercontent.com/u/12",
                    url: "https://github.com/renovate-bot",
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/repos/acme/releasebar/stargazers") {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers instanceof Headers).toBe(false);
      expect(String(headers?.accept)).toMatch(/star\+json/);
      if (url.searchParams.get("page") !== "3") {
        return Response.json(
          [
            {
              starred_at: "2020-01-01T00:00:00Z",
              user: {
                login: "old",
                avatar_url: "https://avatars.githubusercontent.com/u/9",
                html_url: "https://github.com/old",
              },
            },
          ],
          {
            headers: {
              link: '<https://api.github.com/repos/acme/releasebar/stargazers?per_page=30&page=3>; rel="last"',
            },
          },
        );
      }
      return Response.json([
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "principal",
            avatar_url: "https://avatars.githubusercontent.com/u/10",
            html_url: "https://github.com/principal",
          },
        },
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "quiet",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/quiet",
          },
        },
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "renovate-bot",
            avatar_url: "https://avatars.githubusercontent.com/u/12",
            html_url: "https://github.com/renovate-bot",
          },
        },
      ]);
    }
    if (path === "/users/principal") {
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/cabot") {
      return Response.json({
        login: "cabot",
        avatar_url: "https://avatars.githubusercontent.com/u/13",
        html_url: "https://github.com/cabot",
        type: "User",
        name: "C. Abot",
        company: "GitHub",
        bio: "Principal engineer building developer tools",
        location: "San Francisco",
        blog: "https://cabot.dev",
        twitter_username: "cabot",
        followers: 5000,
        following: 50,
        public_repos: 80,
        public_gists: 2,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/cabot/orgs") {
      return Response.json([]);
    }
    if (path === "/users/cabot/repos") {
      return Response.json([]);
    }
    if (path === "/users/principal/orgs") {
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
        {
          login: "acme",
          avatar_url: "https://avatars.githubusercontent.com/u/20",
          description: "Developer tools",
        },
      ]);
    }
    if (path === "/users/principal/repos") {
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 350,
          forks_count: 24,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    if (path === "/users/quiet") {
      return Response.json({
        login: "quiet",
        avatar_url: "https://avatars.githubusercontent.com/u/11",
        html_url: "https://github.com/quiet",
        type: "User",
        name: null,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: 2,
        following: 0,
        public_repos: 1,
        public_gists: 0,
        created_at: "2026-05-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/quiet/orgs") {
      return Response.json([]);
    }
    if (path === "/users/quiet/repos") {
      return Response.json([]);
    }
    if (path === "/users/renovate-bot") {
      return Response.json({
        login: "renovate-bot",
        avatar_url: "https://avatars.githubusercontent.com/u/12",
        html_url: "https://github.com/renovate-bot",
        type: "Bot",
        name: null,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: 1000,
        following: 0,
        public_repos: 100,
        public_gists: 0,
        created_at: "2015-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = {
    DASHBOARD_CACHE: kvStore({
      "trust-profile:v4:principal": JSON.stringify({
        login: "principal",
        profileKind: "user_trust",
        scoreLabel: "trust score",
        score: 88,
        tier: "high",
        generatedAt: "2026-05-16T12:00:00Z",
      }),
    }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RepoAudiencePayload;
    expect(body.fullName).toBe("acme/releasebar");
    expect(body.range).toBe("month");
    expect(body.users[0]?.login).toBe("principal");
    expect(body.users[0]?.tier).toBe("high");
    expect(body.users[0]?.trustScore).toBe(88);
    expect(body.users[0]?.trustTier).toBe("high");
    assert.ok((body.users[0]?.dimensions.trust ?? 0) >= 80);
    expect(body.users[0]?.orgs[0]?.login).toBe("github");
    expect(body.users[0]?.topRepositories[0]?.fullName).toBe("principal/release-tools");
    expect(body.users[0]?.reasons.join(" ") ?? "").toMatch(/notable org: github/);
    const cabot = body.users.find((user) => user.login === "cabot");
    expect(cabot?.tier).not.toBe("bot");
    assert.ok((cabot?.score ?? 0) > 0);
    expect(body.totals.stargazers).toBe(1234);
    expect(body.totals.highSignal).toBe(1);
    expect(body.totals.mediumSignal).toBe(1);
    expect(body.totals.bots).toBe(1);
    expect(body.totals.highSignalPercent).toBe(25);
    expect(body.totals.mediumSignalPercent).toBe(25);
    expect(body.totals.lowSignalPercent).toBe(25);
    expect(body.totals.botPercent).toBe(25);
    expect(body.cache.quota?.source).toBe("shared");

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      env,
      { waitUntil: () => undefined },
    );
    expect(cached.status).toBe(200);
    expect(calls).toBe(12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker REST stargazer fallback samples newest stargazers", async () => {
  const originalFetch = globalThis.fetch;
  const stargazerPages: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/restbar") {
      return Response.json({
        owner: { login: "acme" },
        name: "restbar",
        full_name: "acme/restbar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/restbar",
        description: "REST fallback",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 31,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/repos/acme/restbar/stargazers") {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(String(headers?.accept)).toMatch(/star\+json/);
      stargazerPages.push(url.searchParams.get("page") ?? "first");
      if (url.searchParams.get("page") !== "2") {
        return Response.json(
          [
            {
              starred_at: new Date().toISOString(),
              user: {
                login: "previous",
                avatar_url: "https://avatars.githubusercontent.com/u/10",
                html_url: "https://github.com/previous",
              },
            },
          ],
          !url.searchParams.has("page")
            ? {
                headers: {
                  link: '<https://api.github.com/repos/acme/restbar/stargazers?per_page=30&page=2>; rel="last"',
                },
              }
            : undefined,
        );
      }
      return Response.json([
        {
          starred_at: new Date().toISOString(),
          user: {
            login: "newest",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/newest",
          },
        },
      ]);
    }
    const user = path.match(/^\/users\/([^/]+)$/)?.[1];
    if (user === "previous" || user === "newest") {
      return Response.json({
        login: user,
        avatar_url: `https://avatars.githubusercontent.com/u/${user === "previous" ? "10" : "11"}`,
        html_url: `https://github.com/${user}`,
        type: "User",
        name: user,
        company: null,
        bio: null,
        location: null,
        blog: null,
        twitter_username: null,
        followers: user === "newest" ? 20 : 10,
        following: 1,
        public_repos: 2,
        public_gists: 0,
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/previous/orgs" || path === "/users/newest/orgs") {
      return Response.json([]);
    }
    if (path === "/users/previous/repos" || path === "/users/newest/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/restbar/audience"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RepoAudiencePayload;
    expect(stargazerPages).toStrictEqual(["first", "2", "1"]);
    expect(body.users.map((user) => user.login).sort()).toStrictEqual(["newest", "previous"]);
    expect(body.totals.stargazers).toBe(31);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale repository audience caches to crawlers without refreshing", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const cache = kvStore({
    "repo-audience:v5:acme/releasebar:month": JSON.stringify({
      fullName: "acme/releasebar",
      range: "month",
      generatedAt,
      cache: {
        state: "fresh",
        stale: false,
        generatedAt,
      },
      totals: {
        stargazers: 10,
        stargazersSampled: 1,
        highSignal: 1,
        mediumSignal: 0,
        lowSignal: 0,
        bots: 0,
        highSignalPercent: 100,
        mediumSignalPercent: 0,
        lowSignalPercent: 0,
        botPercent: 0,
      },
      users: [],
    } satisfies RepoAudiencePayload),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler stale audience cache should not call GitHub ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/repos/acme/releasebar/audience"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RepoAudiencePayload;
    expect(body.cache.state).toBe("stale");
    expect(body.cache.message).toBe("showing cached repository audience signals");
    expect(body.totals.stargazers).toBe(10);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves OpenAPI spec aliases for Swagger tooling", async () => {
  const env = { DASHBOARD_CACHE: kvStore() };
  for (const path of ["/openapi.json", "/api/openapi.json", "/api/swagger.json"]) {
    const response = await worker.fetch(new Request(`https://release.bar${path}`), env, {
      waitUntil: () => undefined,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      openapi?: string;
      info?: { version?: string };
      paths?: Record<string, unknown>;
      components?: {
        schemas?: {
          CacheState?: {
            properties?: Record<string, unknown>;
          };
          OwnerActivity?: unknown;
        };
      };
    };
    expect(body.openapi).toBe("3.1.0");
    expect(body.info?.version).toBe("0.2.3");
    assert.ok(body.paths?.["/api/{owner}/activity"]);
    assert.ok(body.paths?.["/api/users/{login}/trust"]);
    assert.ok(body.paths?.["/api/repos/{owner}/{repo}/audience"]);
    assert.ok(body.components?.schemas?.OwnerActivity);
    assert.ok(body.components?.schemas?.CacheState?.properties?.countsUpdatedAt);
    assert.ok(body.components?.schemas?.CacheState?.properties?.releasesUpdatedAt);
    assert.ok(body.components?.schemas?.CacheState?.properties?.ciUpdatedAt);
  }
});

test("worker rejects malformed nested owner API paths", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/openclaw/openclaw/audience"),
      { DASHBOARD_CACHE: kvStore() },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("not found");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps unsynced app-configured audience GETs off shared quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience"),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "private-key",
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/GitHub App/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only backfills repository audience caches with GitHub App quota", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const denied = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience/backfill", {
        method: "POST",
      }),
      { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(denied.status).toBe(403);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "audience-backfill";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
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
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  let appCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const authorization = new Headers(init?.headers).get("authorization");
    if (path === "/user/installations") {
      expect(authorization).toBe("Bearer user-token");
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "acme",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/acme",
            },
            html_url: "https://github.com/organizations/acme/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (path === "/app/installations/1/access_tokens") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
    }
    if (path === "/repos/acme/releasebar") {
      appCalls += 1;
      expect(authorization).toBe("Bearer installation-token");
      return Response.json({
        owner: { login: "acme" },
        name: "releasebar",
        full_name: "acme/releasebar",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/releasebar",
        description: "Release dashboard",
        default_branch: "main",
        language: "TypeScript",
        topics: ["developer-tools"],
        stargazers_count: 1234,
        forks_count: 45,
        open_issues_count: 9,
        pushed_at: "2026-05-16T12:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/graphql") {
      appCalls += 1;
      expect(authorization).toBe("Bearer installation-token");
      return Response.json({
        data: {
          repository: {
            stargazers: {
              edges: [
                {
                  starredAt: new Date().toISOString(),
                  node: {
                    login: "principal",
                    avatarUrl: "https://avatars.githubusercontent.com/u/10",
                    url: "https://github.com/principal",
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (path === "/users/principal") {
      appCalls += 1;
      expect(authorization).toBe("Bearer installation-token");
      return Response.json({
        login: "principal",
        avatar_url: "https://avatars.githubusercontent.com/u/10",
        html_url: "https://github.com/principal",
        type: "User",
        name: "Principal Engineer",
        company: "GitHub",
        bio: "Principal software engineer building developer tools",
        location: "San Francisco",
        blog: "https://principal.dev",
        twitter_username: "principal",
        followers: 2500,
        following: 120,
        public_repos: 80,
        public_gists: 9,
        created_at: "2012-01-01T00:00:00Z",
        updated_at: "2026-05-16T12:00:00Z",
      });
    }
    if (path === "/users/principal/orgs") {
      appCalls += 1;
      expect(authorization).toBe("Bearer installation-token");
      return Response.json([
        {
          login: "github",
          avatar_url: "https://avatars.githubusercontent.com/u/9919",
          description: "How people build software",
        },
      ]);
    }
    if (path === "/users/principal/repos") {
      appCalls += 1;
      expect(authorization).toBe("Bearer installation-token");
      return Response.json([
        {
          full_name: "principal/release-tools",
          html_url: "https://github.com/principal/release-tools",
          description: "Release tooling",
          language: "TypeScript",
          stargazers_count: 350,
          forks_count: 24,
          fork: false,
          archived: false,
          topics: ["release", "developer-tools"],
          pushed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience/backfill", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fullName: string;
      ranges: Array<{ range: AudienceRange; state: string; users: number }>;
      quota: { source: string; account: string | null };
    };
    expect(body.fullName).toBe("acme/releasebar");
    expect(
      body.ranges.map((range) => `${range.range}:${range.state}:${range.users}`),
    ).toStrictEqual(["week:rebuilt:1", "month:rebuilt:1"]);
    expect(body.quota).toStrictEqual({ source: "app", account: "acme" });
    assert.ok(appCalls > 0);

    const cached = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar/audience?range=week"),
      env,
      { waitUntil: () => undefined },
    );
    const audience = (await cached.json()) as RepoAudiencePayload;
    expect(audience.cache.quota?.source).toBe("app");
    expect(audience.users[0]?.factors.length).toBe(7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
