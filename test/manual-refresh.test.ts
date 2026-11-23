import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshJob } from "../src/types.ts";
import {
  kvStore,
  ownerMetadataMutator,
  type TestEnv,
  testDashboard,
  testProject,
  worker,
} from "./dashboard-test-harness.ts";

test("worker manual dashboard refresh returns metadata before release hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const repoNode = (issues: number, pullRequests: number) => ({
    owner: { login: "owner", __typename: "User" },
    name: "repo",
    nameWithOwner: "owner/repo",
    description: "Manual refresh repo",
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [] },
    stargazerCount: 42,
    forkCount: 2,
    issues: { totalCount: issues },
    pullRequests: { totalCount: pullRequests },
    isArchived: false,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    releases: {
      nodes: [
        {
          tagName: "v1.0.0",
          name: null,
          url: "https://github.com/owner/repo/releases/tag/v1.0.0",
          isDraft: false,
          publishedAt: "2026-05-01T00:00:00Z",
        },
      ],
    },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; includeReleases?: boolean };
      };
      expect(body.variables?.first).toBe(100);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [repoNode(9, 4)],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("partial");
    expect(body.cache?.progress?.done).toBe(false);
    expect(body.cache?.message ?? "").toMatch(/repository metadata refreshed/);
    expect(body.projects[0]?.openIssues).toBe(9);
    expect(body.projects[0]?.openPullRequests).toBe(4);
    expect(body.projects[0]?.version).toBe("repo search");

    const repeated = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(repeated.status).toBe(202);
    const repeatedBody = (await repeated.json()) as DashboardPayload;
    expect(repeatedBody.cache?.message ?? "").toMatch(/manual refresh recently started/);
    expect(repeatedBody.projects[0]?.openIssues).toBe(9);

    await Promise.all(waits);
    const cached = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
      waitUntil: () => undefined,
    });
    const hydrated = (await cached.json()) as DashboardPayload;
    expect(hydrated.cache?.state).toBe("fresh");
    expect(hydrated.projects[0]?.version).toBe("v1.0.0");
    expect(hydrated.projects[0]?.commitsSinceRelease).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual refreshes merge owner removals observed during the build before caching", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: { send: async () => undefined },
  };
  let removalRecorded = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({ login: "owner", type: "User" });
    }
    if (url.pathname === "/graphql") {
      if (!removalRecorded) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        const removed = await ownerMetadataMutator(
          env,
          "owner",
        )({
          kind: "remove",
          fullName: "owner/repo",
          observedAt: new Date().toISOString(),
        });
        assert(removed);
        removalRecorded = true;
      }
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "removed during build",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 1,
                  forkCount: 0,
                  issues: { totalCount: 1 },
                  pullRequests: { totalCount: 0 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-06-11T00:00:00Z",
                  updatedAt: "2026-06-11T00:00:00Z",
                  releases: { nodes: [] },
                },
              ],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    expect(body.projects.length).toBe(0);
    const cached = JSON.parse(
      (await cache.get(
        dashboardCacheKey({
          owner: "owner",
          includeUnreleased: true,
          includeReleaseData: true,
          schemaVersion: 6,
        }),
      )) ?? "{}",
    ) as DashboardPayload;
    expect(cached.projects.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves repository cap metadata", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const sentJobs: RefreshJob[] = [];
  let graphqlCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/wide") {
      return Response.json({ login: "wide", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { after?: string | null };
      };
      const offset = body.variables?.after ? 100 : 0;
      const nodes = Array.from({ length: 100 }, (_, index) => {
        const number = offset + index + 1;
        const name = `repo-${number}`;
        return {
          owner: { login: "wide", __typename: "User" },
          name,
          nameWithOwner: `wide/${name}`,
          description: null,
          url: `https://github.com/wide/${name}`,
          defaultBranchRef: { name: "main" },
          primaryLanguage: null,
          repositoryTopics: { nodes: [] },
          stargazerCount: 0,
          forkCount: 0,
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          isArchived: false,
          isFork: false,
          isPrivate: false,
          pushedAt: "2026-05-15T00:00:00Z",
          updatedAt: "2026-05-15T00:00:00Z",
        };
      });
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: {
                hasNextPage: true,
                endCursor: offset === 0 ? "page-2" : "page-3",
              },
              nodes,
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/wide", { method: "POST" }),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(graphqlCalls).toBe(2);
    expect(body.projects.length).toBe(200);
    expect(body.cache?.capped).toBe(true);
    expect(body.cache?.repoLimit).toBe(200);
    expect(sentJobs.length).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker limits cold metadata to one small page before queue hydration", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  const sentJobs: RefreshJob[] = [];
  let graphqlCalls = 0;
  const nodes = Array.from({ length: 25 }, (_, index) => {
    const name = `repo-${index + 1}`;
    return {
      owner: { login: "wide", __typename: "User" },
      name,
      nameWithOwner: `wide/${name}`,
      description: null,
      url: `https://github.com/wide/${name}`,
      defaultBranchRef: { name: "main" },
      primaryLanguage: { name: "TypeScript" },
      repositoryTopics: { nodes: [] },
      stargazerCount: index,
      forkCount: 0,
      issues: { totalCount: index + 1 },
      pullRequests: { totalCount: index },
      isArchived: false,
      isFork: index === 0,
      isPrivate: false,
      pushedAt: "2026-05-15T00:00:00Z",
      updatedAt: "2026-05-15T00:00:00Z",
    };
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/wide") {
      return Response.json({ login: "wide", type: "User" });
    }
    if (url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { first?: number; after?: string | null; includeReleases?: boolean };
      };
      expect(body.variables?.first).toBe(25);
      expect(body.variables?.after).toBe(null);
      expect(body.variables?.includeReleases).toBe(false);
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: true, endCursor: "next-page" },
              nodes,
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/wide"),
      {
        DASHBOARD_CACHE: kvStore(),
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(graphqlCalls).toBe(1);
    expect(body.cache?.state).toBe("partial");
    expect(body.cache?.progress?.done).toBe(false);
    expect(body.cache?.repoLimit).toBe(200);
    expect(body.options?.repoLimit).toBe(200);
    expect(body.projects.length).toBe(24);
    expect(body.projects.some((project) => project.name === "repo-1")).toBe(false);
    expect(body.projects.find((project) => project.name === "repo-25")?.openIssues).toBe(25);
    expect(body.projects.find((project) => project.name === "repo-25")?.openPullRequests).toBe(24);
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("cold-metadata");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh returns structured GitHub errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "30" },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const env = { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("error");
    expect(body.cache?.message ?? "").toMatch(/GitHub shared API quota is exhausted/);

    const key = dashboardCacheKey({ owner: "owner", includeUnreleased: true, schemaVersion: 6 });
    const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
    dashboard.generatedAt = new Date().toISOString();
    if (dashboard.cache && dashboard.options) {
      dashboard.cache.generatedAt = dashboard.generatedAt;
      dashboard.options.includeUnreleased = true;
    }
    const cache = kvStore({ [key]: JSON.stringify(dashboard) });
    const cachedResponse = await worker.fetch(
      new Request("https://release.bar/api/owner", { method: "POST" }),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(cachedResponse.status).toBe(429);
    const cached = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    expect(cached.cache?.state).toBe("fresh");
    expect(cached.projects.length).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL backoff does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore({
    "github:backoff:v2:graphql:shared:_:ReleaseBarOwnerRepos.metadata": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(429);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("error");
    expect(paths).toStrictEqual(["/users/owner"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker GraphQL upstream failure does not fall through to shared REST scans", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname === "/users/owner") {
      return Response.json({
        login: "owner",
        type: "User",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/owner",
      });
    }
    if (url.pathname === "/graphql") {
      return Response.json(
        { message: "upstream unavailable" },
        {
          status: 503,
          headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "800",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      );
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const cache = kvStore();
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(429);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("error");
    expect(paths).toStrictEqual(["/users/owner", "/graphql"]);
    assert.ok(await cache.get("github:backoff:v2:graphql:shared:_:ReleaseBarOwnerRepos.metadata"));
    assert.ok(await cache.get("github:budget:v1:shared:graphql"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker manual dashboard refresh preserves released-only cache while rebuilding", async () => {
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "User",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  owner: { login: "owner", __typename: "User" },
                  name: "repo",
                  nameWithOwner: "owner/repo",
                  description: "Released repo",
                  url: "https://github.com/owner/repo",
                  defaultBranchRef: { name: "main" },
                  primaryLanguage: { name: "TypeScript" },
                  repositoryTopics: { nodes: [] },
                  stargazerCount: 42,
                  forkCount: 2,
                  issues: { totalCount: 7 },
                  pullRequests: { totalCount: 3 },
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  pushedAt: "2026-05-15T00:00:00Z",
                  updatedAt: "2026-05-15T00:00:00Z",
                  releases: {
                    nodes: [
                      {
                        tagName: "v1.0.0",
                        name: null,
                        url: "https://github.com/owner/repo/releases/tag/v1.0.0",
                        isDraft: false,
                        publishedAt: "2026-05-01T00:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (url.pathname === "/repos/owner/repo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 3,
        html_url: "https://github.com/owner/repo/compare/v1.0.0...main",
      });
    }
    if (url.pathname === "/repos/owner/repo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const key = dashboardCacheKey({ owner: "owner", includeUnreleased: false, schemaVersion: 6 });
  const dashboard = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  dashboard.generatedAt = new Date().toISOString();
  if (dashboard.cache) {
    dashboard.cache.generatedAt = dashboard.generatedAt;
  }
  const env = {
    DASHBOARD_CACHE: kvStore({ [key]: JSON.stringify(dashboard) }),
    GITHUB_TOKEN: "shared-token",
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false", { method: "POST" }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    expect(body.projects.length).toBe(1);
    expect(body.projects[0]?.version).toBe("v1.0.0");
    expect(body.cache?.message ?? "").toMatch(/release data updating/);

    await Promise.all(waits);
    const cached = await worker.fetch(
      new Request("https://release.bar/api/owner?unreleased=false"),
      env,
      { waitUntil: () => undefined },
    );
    const hydrated = (await cached.json()) as DashboardPayload;
    expect(hydrated.projects[0]?.openIssues).toBe(7);
    expect(hydrated.projects[0]?.openPullRequests).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
