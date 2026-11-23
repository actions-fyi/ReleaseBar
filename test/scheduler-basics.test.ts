import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { RefreshJob, RefreshTarget, SchedulerAdminPayload } from "../src/types.ts";
import {
  kvStore,
  signedJson,
  storedRefreshJob,
  storeRefreshJob,
  storeRefreshTarget,
  testDashboard,
  worker,
  seedInstallation,
  storedInstallationJson,
} from "./dashboard-test-harness.ts";

test("worker queue skips jobs from obsolete dashboard schemas", async () => {
  const key = "dashboard:v5:owner=legacy";
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "legacy",
    owners: ["legacy"],
    repos: [],
    includeReleaseData: true,
    path: "/legacy",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: new Date().toISOString(),
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-obsolete-schema",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cache = kvStore({});
  await storeRefreshJob(job);
  let acked = false;

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: RefreshJob;
            ack(): void;
            retry(options?: { delaySeconds?: number }): void;
          }>;
        },
        env: unknown,
        context: unknown,
      ): Promise<void>;
    }
  ).queue(
    {
      messages: [
        {
          body: job,
          ack() {
            acked = true;
          },
          retry() {
            throw new Error("obsolete jobs should not retry");
          },
        },
      ],
    },
    { DASHBOARD_CACHE: cache },
    { waitUntil: () => undefined },
  );

  expect(acked).toBe(true);
  const stored = ((await storedRefreshJob(job.id)) ?? {}) as RefreshJob;
  expect(stored.status).toBe("skipped");
  expect(stored.error).toBe("obsolete dashboard schema");
});

test("worker admin installation sync removes stale registry entries", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  await seedInstallation(
    JSON.stringify({
      id: 7,
      accountLogin: "stale-org",
      accountType: "org",
      accountUrl: "https://github.com/stale-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
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
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 11,
          account: {
            login: "fresh-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/11",
            html_url: "https://github.com/fresh-org",
          },
          html_url: "https://github.com/organizations/fresh-org/settings/installations/11",
          repository_selection: "all",
          target_type: "Organization",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { count?: number };
    expect(body.count).toBe(1);
    expect(await storedInstallationJson("stale-org")).toBe(null);
    const fresh = JSON.parse((await storedInstallationJson("fresh-org")) ?? "{}");
    expect(fresh.id).toBe(11);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin installation sync keeps registry when GitHub listing fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync-failed";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  await seedInstallation(
    JSON.stringify({
      id: 7,
      accountLogin: "known-org",
      accountType: "org",
      accountUrl: "https://github.com/known-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "all",
      repositories: [],
      updatedAt: "2026-05-15T12:00:00Z",
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
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations") {
      return Response.json({ message: "try later" }, { status: 503 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(400);
    expect(await storedInstallationJson("known-org")).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin installation sync keeps selected repos when repository listing fails", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-admin-install-sync-selected-failed";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  await seedInstallation(
    JSON.stringify({
      id: 7,
      accountLogin: "known-org",
      accountType: "org",
      accountUrl: "https://github.com/known-org",
      avatarUrl: "https://avatars.githubusercontent.com/u/7",
      repositorySelection: "selected",
      repositories: ["known-org/releasebar"],
      updatedAt: "2026-05-15T12:00:00Z",
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
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 7,
          account: {
            login: "known-org",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/7",
            html_url: "https://github.com/known-org",
          },
          html_url: "https://github.com/organizations/known-org/settings/installations/7",
          repository_selection: "selected",
          target_type: "Organization",
        },
      ]);
    }
    if (url.pathname === "/app/installations/7/access_tokens") {
      return Response.json({ token: "installation-token" });
    }
    if (url.pathname === "/installation/repositories") {
      expect(authorization).toBe("Bearer installation-token");
      return Response.json({ message: "try later" }, { status: 503 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/admin/installations/sync", {
        method: "POST",
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(400);
    const preserved = JSON.parse((await storedInstallationJson("known-org")) ?? "{}");
    expect(preserved.repositories).toStrictEqual(["known-org/releasebar"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker admin scheduler counts missing caches as due even before nextDueAt", async () => {
  const sessionId = "session-admin-due";
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
    nextDueAt: "2999-01-01T00:00:00Z",
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

  const response = await worker.fetch(
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

  expect(response.status).toBe(200);
  const body = (await response.json()) as SchedulerAdminPayload;
  expect(body.status.dueTargets).toBe(1);
});

test("worker admin scheduler respects transient failure retry delay", async () => {
  const sessionId = "session-admin-retry-delay";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=retrying",
    kind: "dashboard",
    owner: "retrying",
    owners: ["retrying"],
    repos: [],
    includeReleaseData: true,
    path: "/retrying",
    priority: 100,
    lastSeenAt: new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 1,
    terminalBackoffUntil: null,
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

  const response = await worker.fetch(
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

  expect(response.status).toBe(200);
  const body = (await response.json()) as SchedulerAdminPayload;
  expect(body.status.dueTargets).toBe(0);
});

test("worker scheduler skips shared cold targets while GraphQL is backed off", async () => {
  const sessionId = "session-admin-graphql-backoff";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=backedoff",
    kind: "dashboard",
    owner: "backedoff",
    owners: ["backedoff"],
    repos: [],
    includeReleaseData: true,
    path: "/backedoff",
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
    "github:backoff:v2:graphql:shared:_:ReleaseBarRepoDetails": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  await storeRefreshTarget(target);
  const sentJobs: RefreshJob[] = [];
  const env = {
    ADMIN_LOGINS: "steipete",
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    env,
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { due: number; enqueued: number };
  expect(body.due).toBe(0);
  expect(body.enqueued).toBe(0);
  expect(sentJobs).toStrictEqual([]);
});

test("worker scheduler keeps repo-only targets runnable during RepoDetails backoff", async () => {
  const sessionId = "session-admin-repo-only-graphql-backoff";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const target: RefreshTarget = {
    key: "dashboard:v6:repo-only",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: ["acme/releasebar"],
    includeReleaseData: true,
    path: "/custom",
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
    "github:backoff:v2:graphql:shared:_:ReleaseBarRepoDetails": JSON.stringify({
      active: true,
      status: 502,
      source: "shared",
      account: null,
      at: new Date().toISOString(),
    }),
  });
  await storeRefreshTarget(target);
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
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
  expect(sentJobs[0]?.targetKey).toBe(target.key);
});

test("worker scheduler keeps dormant shared targets on weekly cadence after success", async () => {
  const sessionId = "session-admin-dormant-shared-cadence";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = Date.now();
  const key = dashboardCacheKey({
    owner: "sleepy",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const lastRefreshAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "sleepy",
    owners: ["sleepy"],
    repos: [],
    includeReleaseData: false,
    path: "/sleepy",
    priority: 100,
    lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: lastRefreshAt,
    lastSuccessAt: lastRefreshAt,
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
    [key]: JSON.stringify(testDashboard("sleepy", [])),
  });
  await storeRefreshTarget(target);
  const sentJobs: RefreshJob[] = [];

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
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

test("worker scheduler still rebuilds missing dormant shared caches", async () => {
  const sessionId = "session-admin-dormant-shared-missing";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const now = Date.now();
  const target: RefreshTarget = {
    key: "dashboard:v6:owner=sleepy-missing",
    kind: "dashboard",
    owner: "sleepy-missing",
    owners: ["sleepy-missing"],
    repos: [],
    includeReleaseData: false,
    path: "/sleepy-missing",
    priority: 100,
    lastSeenAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    lastAttemptAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    lastSuccessAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    nextDueAt: "2999-01-01T00:00:00Z",
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

  const response = await worker.fetch(
    new Request("https://release.bar/api/admin/scheduler/run", {
      method: "POST",
      headers: { cookie: `rd_session=${authCookie}` },
    }),
    {
      ADMIN_LOGINS: "steipete",
      AUTH_COOKIE_SECRET: "test-secret",
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
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
