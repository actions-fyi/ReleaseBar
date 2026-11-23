import { expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { RefreshJob, RefreshTarget } from "../src/types.ts";
import {
  kvStore,
  objectsUnavailable,
  observedDatabase,
  signedJson,
  storedRefreshJob,
  storedRefreshJobs,
  storeRefreshJob,
  storeRefreshTarget,
  testDashboard,
  testProject,
  worker,
  seedInstallation,
} from "./dashboard-test-harness.ts";

test("worker scheduler preserves queued backlog jobs until reservation expiry", async () => {
  const sessionId = "session-admin-stale-queued";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=stale-queued",
    kind: "dashboard",
    owner: "stale-queued",
    owners: ["stale-queued"],
    repos: [],
    includeReleaseData: false,
    path: "/stale-queued",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const queuedJob: RefreshJob = {
    id: "queued-backlog-job",
    targetKey: target.key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    durationMs: null,
    error: "dashboard incomplete",
  };
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
  await storeRefreshTarget(target);
  await storeRefreshJob(queuedJob);
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
  const request = () =>
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    });

  const activeResponse = await worker.fetch(request(), env, { waitUntil: () => undefined });
  expect(activeResponse.status).toBe(200);
  const activeBody = (await activeResponse.json()) as { due: number; enqueued: number };
  expect(activeBody.due).toBe(0);
  expect(activeBody.enqueued).toBe(0);
  expect(sentJobs.length).toBe(0);

  const expiredJob = {
    ...queuedJob,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  };
  await storeRefreshJob(expiredJob);

  const expiredResponse = await worker.fetch(request(), env, { waitUntil: () => undefined });

  expect(expiredResponse.status).toBe(200);
  const expiredBody = (await expiredResponse.json()) as { due: number; enqueued: number };
  expect(expiredBody.due).toBe(1);
  expect(expiredBody.enqueued).toBe(1);
  expect(sentJobs.length).toBe(1);
  expect(sentJobs[0]?.id).not.toBe(queuedJob.id);
});

test("worker clears fallback reservations after active-job scans fail", async () => {
  const sessionId = "session-admin-reservation-scan-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=reservation-scan-failure",
    kind: "dashboard",
    owner: "reservation-scan-failure",
    owners: ["reservation-scan-failure"],
    repos: [],
    includeReleaseData: false,
    path: "/reservation-scan-failure",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
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
  await storeRefreshTarget(target);
  // A tick lists the jobs and the delivery records; the third listing is the scan for an active
  // job that stands in for the reservation.
  let refreshJobListCalls = 0;
  const { database } = observedDatabase((sql) => {
    if (sql.includes("FROM refresh_job") && sql.trimStart().startsWith("SELECT")) {
      refreshJobListCalls += 1;
      if (refreshJobListCalls === 3) throw new Error("active job scan failed");
    }
    return false;
  });
  objectsUnavailable();
  const sentJobs: RefreshJob[] = [];
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    DB: database,
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const request = () =>
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    });

  await expect(worker.fetch(request(), env, { waitUntil: () => undefined })).rejects.toThrow(
    /active job scan failed/,
  );
  expect(sentJobs.length).toBe(0);

  const response = await worker.fetch(request(), env, { waitUntil: () => undefined });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(1);
  expect(body.enqueued).toBe(1);
  expect(sentJobs.length).toBe(1);
});

test("worker scheduler falls back when the reservation Durable Object is unavailable", async () => {
  const sessionId = "session-admin-reservation-fallback";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=reservation-fallback",
    kind: "dashboard",
    owner: "reservation-fallback",
    owners: ["reservation-fallback"],
    repos: [],
    includeReleaseData: false,
    path: "/reservation-fallback",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
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
  await storeRefreshTarget(target);
  const sentJobs: RefreshJob[] = [];
  objectsUnavailable();

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(1);
  expect(body.enqueued).toBe(1);
  expect(sentJobs.length).toBe(1);
});

test("worker admin GitHub access ignores expired shared quota cooldowns", async () => {
  const sessionId = "session-admin-expired-cooldown";
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
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "2000-01-01T00:00:00.000Z",
      reason: "expired",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
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
  const body = (await response.json()) as { cooldown?: { active?: boolean } };
  expect(body.cooldown?.active).toBe(false);
  expect(await cache.get("github:budget:v1:shared:_")).toBe(null);
});

test("worker admin GitHub access keeps longest active shared quota cooldown", async () => {
  const sessionId = "session-admin-longest-cooldown";
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
    "github:budget:v1:shared:_": JSON.stringify({
      active: true,
      resource: "core",
      remaining: 10,
      limit: 5000,
      resetAt: "2999-01-01T00:00:00.000Z",
      reason: "shorter",
    }),
    "github:budget:v1:shared:graphql": JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5000,
      resetAt: "3000-01-01T00:00:00.000Z",
      reason: "longer",
    }),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/github-access?hours=1", {
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
  const body = (await response.json()) as { cooldown?: { resource?: string | null } };
  expect(body.cooldown?.resource).toBe("graphql");
});

test("worker admin scheduler defers shared quota paused targets even with missing cache", async () => {
  const sessionId = "session-admin-shared-quota-defer";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
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
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
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
  await storeRefreshTarget(target);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(0);
  expect(body.enqueued).toBe(0);
  expect(sentJobs).toStrictEqual([]);
});

test("worker admin scheduler lets app-token targets bypass shared quota pauses", async () => {
  const sessionId = "session-admin-shared-quota-app-bypass";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
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
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  await seedInstallation(
    JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
  );
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
    "auth:installation-token:42": "installation-token",
  });
  await storeRefreshTarget(target);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(1);
  expect(body.enqueued).toBe(1);
  expect(sentJobs[0]?.reason).toBe("app-quota");
});

test("worker admin scheduler uses app registry coverage without minting tokens", async () => {
  const sessionId = "session-admin-shared-quota-app-registry";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
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
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  await seedInstallation(
    JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
  );
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
  await storeRefreshTarget(target);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(1);
  expect(body.enqueued).toBe(1);
  expect(sentJobs[0]?.reason).toBe("app-quota");
});

test("worker admin scheduler bypasses shared quota defer time with app coverage", async () => {
  const sessionId = "session-admin-shared-quota-app-stale";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const key = dashboardCacheKey({
    owner: "openclaw",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "openclaw",
    owners: ["openclaw"],
    repos: [],
    includeReleaseData: true,
    path: "/openclaw",
    priority: 100,
    lastSeenAt: "2026-05-15T12:00:00Z",
    lastAttemptAt: "2026-05-15T13:00:00Z",
    lastSuccessAt: "2026-05-15T13:00:00Z",
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    message: "shared GitHub quota paused until 2999-01-01T00:00:00Z",
  };
  const sentJobs: RefreshJob[] = [];
  await seedInstallation(
    JSON.stringify({
      id: 42,
      accountLogin: "openclaw",
      accountType: "org",
      accountUrl: "https://github.com/openclaw",
      avatarUrl: "https://avatars.githubusercontent.com/u/2",
      repositorySelection: "all",
      repositories: [],
      updatedAt: new Date().toISOString(),
    }),
  );
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
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
  });
  await storeRefreshTarget(target);

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(1);
  expect(body.enqueued).toBe(1);
  expect(sentJobs[0]?.reason).toBe("app-quota");
});

test("worker scheduler marks jobs failed when queue delivery fails", async () => {
  const sessionId = "session-admin-queue-failure";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
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
  await storeRefreshTarget(target);

  await expect(
    worker.fetch(
      new Request("https://release.bar/api/admin/scheduler/run", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      {
        ADMIN_LOGINS: "steipete",
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: cache,
        REFRESH_QUEUE: {
          async send() {
            throw new Error("queue unavailable");
          },
        },
      },
      { waitUntil: () => undefined },
    ),
  ).rejects.toThrow(/queue unavailable/);

  const jobs = await storedRefreshJobs();
  expect(jobs.length).toBe(1);
  const stored = ((await storedRefreshJob(jobs[0]?.id ?? "")) ?? {}) as RefreshJob;
  expect(stored.status).toBe("failed");
  expect(stored.error ?? "").toMatch(/queue unavailable/);
});
