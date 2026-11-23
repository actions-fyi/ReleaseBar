import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import type {
  AuthFunnelSummary,
  DashboardPayload,
  GitHubAccessSummary,
  RefreshJob,
  RefreshTarget,
  SchedulerAdminPayload,
} from "../src/types.ts";
import { kvStore, signedJson, testDashboard, worker } from "./dashboard-test-harness.ts";

test("worker discovers and stores source-owned app installs for anonymous dashboards", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore();
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const waits: Promise<unknown>[] = [];
  console.log = () => undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 7,
          account: {
            login: "openclaw",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/2",
            html_url: "https://github.com/openclaw",
          },
          html_url: "https://github.com/organizations/openclaw/settings/installations/7",
          repository_selection: "all",
          target_type: "Organization",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ token: "installation-token" });
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
    expect(body.cache?.quota?.source).toBe("app");
    expect(body.cache?.quota?.account).toBe("openclaw");
    const stored = JSON.parse((await cache.get("auth:installation:v1:openclaw")) ?? "{}");
    expect(stored.id).toBe(7);
    expect(stored.repositorySelection).toBe("all");
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
});

test("worker saves owner public defaults and applies them to clean owner URLs", async () => {
  const sessionId = "session-profile";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
  };
  const originalFetch = globalThis.fetch;
  const waits: Promise<unknown>[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/users/steipete") {
      return Response.json({ login: "steipete", type: "User" });
    }
    if (path === "/graphql") {
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
    if (path === "/users/steipete/repos") {
      return Response.json([]);
    }
    if (path === "/repos/openclaw/peekaboo") {
      return Response.json({
        owner: { login: "openclaw" },
        name: "peekaboo",
        full_name: "openclaw/peekaboo",
        description: null,
        html_url: "https://github.com/openclaw/peekaboo",
        default_branch: "main",
        language: "Swift",
        stargazers_count: 5,
        forks_count: 0,
        open_issues_count: 0,
        archived: false,
        pushed_at: "2026-05-15T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
        fork: false,
        private: false,
      });
    }
    if (path === "/repos/openclaw/peekaboo/releases") {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/openclaw/peekaboo/releases/tag/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path === "/repos/openclaw/peekaboo/commits/main") {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-15T00:00:00Z" } },
      });
    }
    if (path === "/repos/openclaw/peekaboo/compare/v1.0.0...main") {
      return Response.json({
        total_commits: 2,
        html_url: "https://github.com/openclaw/peekaboo/compare/v1.0.0...main",
      });
    }
    if (path === "/repos/openclaw/peekaboo/pulls") {
      return Response.json([]);
    }
    if (path === "/repos/openclaw/peekaboo/commits/abcdef123456/check-runs") {
      return Response.json({ check_runs: [] });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const save = await worker.fetch(
      new Request("https://release.bar/api/profile/steipete", {
        method: "POST",
        headers: {
          cookie: `rd_session=${authCookie}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          includeRepos: ["openclaw/peekaboo"],
          hiddenRepos: [],
        }),
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(save.status).toBe(200);
    const saved = await save.json<any>();
    expect(saved.profile.includeRepos).toStrictEqual(["openclaw/peekaboo"]);

    const response = await worker.fetch(new Request("https://release.bar/api/steipete"), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    await Promise.all(waits);
    expect(body.profile?.owner).toBe("steipete");
    expect(body.projects[0]?.fullName).toBe("openclaw/peekaboo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker only lets the dashboard owner save public defaults", async () => {
  const sessionId = "session-profile-forbidden";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    ADMIN_LOGINS: "steipete",
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
  };
  const response = await worker.fetch(
    new Request("https://release.bar/api/profile/steipete", {
      method: "POST",
      headers: {
        cookie: `rd_session=${authCookie}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ includeRepos: ["openclaw/peekaboo"] }),
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(403);
});

test("worker logout deletes the stored session and clears the cookie", async () => {
  const sessionId = "session-logout";
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
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/logout?returnTo=/openclaw", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/openclaw");
  expect(response.headers.get("set-cookie") ?? "").toMatch(/rd_session=;.*Max-Age=0/);
  expect(await cache.get(`auth:session:${sessionId}`)).toBe(null);
});

test("worker login returns 503 when GitHub App is not configured", async () => {
  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/login"),
    { DASHBOARD_CACHE: kvStore() },
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(503);
});

test("worker admin scheduler requires an admin session and reports refresh targets", async () => {
  const sessionId = "session-admin";
  const otherSessionId = "session-admin-other";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const activeAt = new Date().toISOString();
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const otherAuthCookie = await signedJson("test-secret", { id: otherSessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=openclaw",
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const legacyTarget = { ...target, key: "dashboard:v5:owner=legacy", owner: "legacy" };
  const activeJob: RefreshJob = {
    id: "job-active",
    targetKey: target.key,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: activeAt,
    updatedAt: activeAt,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const accessHour = new Date().toISOString().slice(0, 13);
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`auth:session:${otherSessionId}`]: JSON.stringify({
      user: {
        id: 2,
        login: "octocat",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/2",
        url: "https://github.com/octocat",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
    [`refresh:target:v1:${legacyTarget.key}`]: JSON.stringify(legacyTarget),
    [`refresh:job:v1:${activeJob.id}`]: JSON.stringify(activeJob),
    "refresh:jobs:index:v1": JSON.stringify([activeJob.id]),
    [`github:access:v1:${accessHour}:dashboard:shared:_:graphql:200:graphql`]: JSON.stringify({
      area: "dashboard",
      route: "graphql",
      status: 200,
      source: "shared",
      account: null,
      resource: "graphql",
      count: 3,
      lastPath: "/graphql",
      lastAt: `${accessHour}:00:00.000Z`,
    }),
  });
  const sentJobs: RefreshJob[] = [];
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };

  const anonymous = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler"),
    env,
    { waitUntil: () => undefined },
  );
  expect(anonymous.status).toBe(401);

  const nonAdmin = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${otherAuthCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(nonAdmin.status).toBe(403);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as SchedulerAdminPayload;
  expect(body.status.targets).toBe(1);
  expect(body.status.scannedTargets).toBe(1);
  expect(body.status.dueTargets).toBe(0);
  expect(body.status.queuedJobs).toBe(1);
  expect(body.targets[0]?.owner).toBe("openclaw");
  expect("githubAccess" in body).toBe(false);
  expect("auth" in body).toBe(false);

  const access = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(access.status).toBe(200);
  const accessBody = (await access.json()) as GitHubAccessSummary;
  expect(accessBody.total).toBe(3);
  expect(accessBody.topRoutes[0]?.route).toBe("graphql");

  const installations = await worker.fetch(
    new Request("https://release.bar/api/admin/installations", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(installations.status).toBe(200);
  const installationBody = (await installations.json()) as AuthFunnelSummary;
  expect(installationBody.installationCount).toBe(0);
  expect(installationBody.counterCount).toBe(0);

  const run = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(run.status).toBe(200);
  const runBody = (await run.json()) as { enqueued: number; due: number };
  expect(runBody.enqueued).toBe(0);
  expect(runBody.due).toBe(0);
  expect(sentJobs).toStrictEqual([]);
});

test("worker admin installation summary bounds record and counter reads", async () => {
  const sessionId = "session-admin-installation-bounds";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const entries: Record<string, string> = {
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  };
  for (let index = 0; index < 121; index += 1) {
    const account = `account-${String(index).padStart(3, "0")}`;
    entries[`auth:installation:v1:${account}`] = JSON.stringify({
      id: index + 1,
      accountLogin: account,
      accountType: "user",
      accountUrl: `https://github.com/${account}`,
      avatarUrl: `https://avatars.githubusercontent.com/u/${index + 1}`,
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date(index * 1000).toISOString(),
    });
    entries[`auth:funnel-counter:v1:2026-06-13:event-${String(index).padStart(3, "0")}:_:ok`] =
      String(index + 1);
  }
  const baseCache = kvStore(entries);
  let installationReads = 0;
  let counterReads = 0;
  const cache = {
    ...baseCache,
    async get(key: string) {
      if (key.startsWith("auth:installation:v1:")) installationReads += 1;
      if (key.startsWith("auth:funnel-counter:v1:")) counterReads += 1;
      return baseCache.get(key);
    },
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/installations", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as AuthFunnelSummary;
  expect(body.installationCount).toBe(121);
  expect(body.installations.length).toBe(80);
  expect(body.counterCount).toBe(121);
  expect(body.counts.length).toBe(80);
  expect(installationReads).toBe(80);
  expect(counterReads).toBe(80);
});

test("worker scheduler rotates bounded current-schema target pages", async () => {
  const sessionId = "session-admin-pagination";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = new Date().toISOString();
  const entries: Record<string, string> = {
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  };
  for (let index = 0; index < 121; index += 1) {
    const owner = `page-${String(index).padStart(3, "0")}`;
    const key = `dashboard:v6:${owner}`;
    const target: RefreshTarget = {
      key,
      kind: "dashboard",
      indexVersion: 2,
      owner,
      owners: [],
      repos: [],
      includeReleaseData: false,
      path: `/${owner}`,
      priority: 60,
      lastSeenAt: now,
      lastAttemptAt: now,
      lastSuccessAt: now,
      nextDueAt: "2999-01-01T00:00:00Z",
      failureCount: 0,
    };
    entries[`refresh:target:v1:${key}`] = JSON.stringify(target);
    entries[key] = JSON.stringify(testDashboard(owner, []));
  }
  entries["refresh:target:v1:dashboard:v5:obsolete"] = JSON.stringify({
    key: "dashboard:v5:obsolete",
    kind: "dashboard",
    owner: "obsolete",
    owners: [],
    repos: [],
    includeReleaseData: false,
    path: "/obsolete",
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  } satisfies RefreshTarget);
  const cache = kvStore(entries);
  const run = async () => {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/scheduler/run", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      {
        ADMIN_LOGINS: "steipete",
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: cache,
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { considered: number; due: number; enqueued: number };
  };

  expect(await run()).toStrictEqual({ ok: true, considered: 120, due: 0, enqueued: 0 });
  const firstState = JSON.parse((await cache.get("refresh:state:v1")) ?? "{}") as {
    targetCursor?: string;
  };
  expect(firstState.targetCursor).toBe("120");

  expect(await run()).toStrictEqual({ ok: true, considered: 1, due: 0, enqueued: 0 });
  const secondState = JSON.parse((await cache.get("refresh:state:v1")) ?? "{}") as {
    targetCursor?: string;
  };
  expect(secondState.targetCursor).toBe(undefined);

  const admin = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler", {
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
    },
    { waitUntil: () => undefined },
  );
  expect(admin.status).toBe(200);
  const adminBody = (await admin.json()) as SchedulerAdminPayload;
  expect(adminBody.status.targets).toBe(121);
  expect(adminBody.status.scannedTargets).toBe(1);
  expect(adminBody.targets.length).toBe(120);
});
