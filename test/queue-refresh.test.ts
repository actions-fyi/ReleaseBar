import { generateKeyPairSync } from "node:crypto";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../src/types.ts";
import {
  buildLocksHeld,
  jobStateWrites,
  observedDatabase,
  refreshAuditEvents,
  storedRefreshJob,
  storedRefreshJobDeliveries,
  storedRefreshTarget,
  storeProfileSnapshot,
  storeRefreshJob,
  storeRefreshJobSnapshot,
  storeRefreshTarget,
  testDashboard,
  testProject,
  worker,
  cacheWith,
} from "./dashboard-test-harness.ts";

test("worker refresh jobs can use shared quota when no source app token exists", async () => {
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
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-shared",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  await cacheWith({});
  await storeRefreshJob(job);
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shared-token");
    if (url.pathname === "/users/openclaw") {
      return Response.json({ login: "openclaw", type: "Organization" });
    }
    if (url.pathname === "/graphql") {
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
    if (url.pathname === "/orgs/openclaw/repos") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  let acked = false;
  try {
    await worker.queue(
      {
        messages: [
          {
            body: job,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("job should not retry");
            },
          },
        ],
      },
      { GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(acked).toBe(true);
  const updated = ((await storedRefreshJob(job.id)) ?? {}) as RefreshJob;
  expect(updated.status).toBe("succeeded");
  const auditEvents = await refreshAuditEvents();
  expect(auditEvents.some((event) => event.event === "job_start")).toBe(true);
  expect(auditEvents.some((event) => event.event === "dashboard_build_start")).toBe(true);
  const buildDone = auditEvents.find((event) => event.event === "dashboard_build_done");
  expect(buildDone?.status).toBe("fresh");
  expect(buildDone?.projects).toBe(0);
  expect(paths).toStrictEqual(["/users/openclaw", "/graphql"]);
});

test("worker refresh jobs preserve profile filters from the queued target snapshot", async () => {
  const key = dashboardCacheKey({
    owner: "profiled",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const profile = {
    owner: "profiled",
    includeOwners: [],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: ["profiled/secret"],
    updatedAt: "2026-06-11T07:00:00Z",
    updatedBy: "profiled",
  };
  const profileSnapshotKey = await storeProfileSnapshot(profile);
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "profiled",
    owners: ["profiled"],
    repos: [],
    profileSnapshotKey,
    includeReleaseData: false,
    path: "/profiled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const targetSnapshotKey = "refresh-job:job-profile-snapshot";
  const job: RefreshJob = {
    id: "job-profile-snapshot",
    targetKey: key,
    target,
    targetSnapshotKey,
    kind: "dashboard",
    status: "queued",
    reason: "cold-metadata",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const latestLastSeenAt = "2026-06-11T07:30:00Z";
  const latestPath = "/profiled?sort=prs&dir=desc";
  const cache = await cacheWith();
  await storeRefreshJobSnapshot(job);
  await storeRefreshTarget(target);
  const { database, counts } = observedDatabase();
  const originalFetch = globalThis.fetch;
  let releaseOwnerFetch: (() => void) | undefined;
  const ownerFetchGate = new Promise<void>((resolve) => {
    releaseOwnerFetch = resolve;
  });
  let markOwnerFetchStarted: (() => void) | undefined;
  const ownerFetchStarted = new Promise<void>((resolve) => {
    markOwnerFetchStarted = resolve;
  });
  const repo = (name: string) => ({
    owner: { login: "profiled" },
    name,
    full_name: `profiled/${name}`,
    description: null,
    html_url: `https://github.com/profiled/${name}`,
    default_branch: "main",
    language: "TypeScript",
    stargazers_count: 1,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T06:00:00Z",
    updated_at: "2026-06-11T06:00:00Z",
    fork: false,
    private: false,
  });
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/profiled") {
        await storeRefreshTarget({
          ...target,
          lastSeenAt: latestLastSeenAt,
          path: latestPath,
        });
        markOwnerFetchStarted?.();
        await ownerFetchGate;
        return Response.json({ login: "profiled", type: "User" });
      }
      if (url.pathname === "/users/profiled/repos") {
        return Response.json([repo("visible"), repo("secret")]);
      }
      throw new Error(`unexpected fetch ${url.pathname}`);
    };

    const processing = worker.queue(
      {
        messages: [
          {
            body: { ...job, target: undefined },
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("profile snapshot job should not retry");
            },
          },
        ],
      },
      { DB: database },
      { waitUntil: () => undefined },
    );
    await ownerFetchStarted;
    const deliveries = await storedRefreshJobDeliveries();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.status).toBe("running");
    expect(deliveries[0]?.startedAt).not.toBe(null);
    releaseOwnerFetch?.();
    await processing;
  } finally {
    releaseOwnerFetch?.();
    globalThis.fetch = originalFetch;
  }

  expect(acked).toBe(true);
  expect(jobStateWrites(counts.sql)).toBe(1);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  expect(dashboard.profile).toStrictEqual(profile);
  expect(dashboard.projects.map((project) => project.fullName)).toStrictEqual(["profiled/visible"]);
  const updatedTarget = ((await storedRefreshTarget(key)) ?? {}) as RefreshTarget;
  expect(updatedTarget.lastSeenAt).toBe(latestLastSeenAt);
  expect(updatedTarget.path).toBe(latestPath);
});

test("worker retries refresh jobs when the dashboard build lock is busy", async () => {
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
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-05-15T13:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-locked",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-05-15T13:00:00Z",
    updatedAt: "2026-05-15T13:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  await cacheWith({
    [key]: JSON.stringify(
      testDashboard("openclaw", [testProject({ owner: "openclaw", name: "repo" })]),
    ),
  });
  await storeRefreshTarget(target);
  await storeRefreshJob(job);
  buildLocksHeld();
  let acked = false;
  let retryDelaySeconds: number | undefined;

  await worker.queue(
    {
      messages: [
        {
          body: job,
          ack() {
            acked = true;
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    {},
    { waitUntil: () => undefined },
  );

  expect(acked).toBe(false);
  expect(retryDelaySeconds).toBe(60);
  const updated = ((await storedRefreshJob(job.id)) ?? {}) as RefreshJob;
  expect(updated.status).toBe("queued");
  expect(updated.startedAt).toBe(null);
  expect(updated.finishedAt).toBe(null);
  expect(updated.durationMs).toBe(null);
  expect(updated.error).toBe("dashboard locked");
});

test("worker stops and retries stalled progressive dashboard scans", async () => {
  const key = dashboardCacheKey({
    owner: "stalled",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const projects = Array.from({ length: 100 }, (_, index) =>
    testProject({
      owner: "stalled",
      name: `repo-${String(index + 1).padStart(3, "0")}`,
    }),
  );
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "stalled",
    owners: ["stalled"],
    repos: [],
    includeReleaseData: true,
    path: "/stalled",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-stalled",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const dashboard = {
    ...testDashboard("stalled", projects),
    cache: {
      state: "partial" as const,
      stale: true,
      generatedAt: "2026-06-11T07:00:00Z",
      progress: { scanned: 100, limit: 200, done: false },
    },
  };
  await cacheWith({
    [key]: JSON.stringify(dashboard),
  });
  await storeRefreshTarget(target);
  await storeRefreshJob(job);
  await env.BUILD_COORDINATOR.getByName(key).putProgress({
    scannedRepos: projects.map((project) => project.fullName.toLowerCase()),
    projects,
    updatedAt: "2026-06-11T07:00:00Z",
  });
  const repoRows = projects.map((project) => ({
    owner: { login: "stalled" },
    name: project.name,
    full_name: project.fullName,
    description: null,
    html_url: project.url,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-06-11T06:00:00Z",
    updated_at: "2026-06-11T06:00:00Z",
    fork: false,
    private: false,
  }));
  const originalFetch = globalThis.fetch;
  let repoPages = 0;
  let retryDelaySeconds: number | undefined;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/stalled/repos") {
        repoPages += 1;
        return Response.json(repoRows);
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    await worker.queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("stalled job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      {},
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(repoPages).toBe(2);
  expect(retryDelaySeconds).toBe(60);
  const updated = ((await storedRefreshJob(job.id)) ?? {}) as RefreshJob;
  expect(updated.status).toBe("queued");
  expect(updated.error).toBe("dashboard stalled");
});

test("worker aborts Queue hydration at the delivery deadline", async () => {
  const key = dashboardCacheKey({
    owner: "deadline",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "deadline",
    owners: ["deadline"],
    repos: [],
    includeReleaseData: true,
    path: "/deadline",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-deadline",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const cached = {
    ...testDashboard("deadline", []),
    cache: {
      state: "partial" as const,
      stale: true,
      generatedAt: "2026-06-11T07:00:00Z",
      progress: { scanned: 0, limit: 200, done: false },
    },
  };
  await cacheWith({
    [key]: JSON.stringify(cached),
  });
  await storeRefreshTarget(target);
  await storeRefreshJob(job);
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let aborted = false;
  let retryDelaySeconds: number | undefined;
  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    originalSetTimeout(callback, delay === 12 * 60 * 1000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/deadline/repos") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await worker.queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("deadline job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      {},
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  expect(aborted).toBe(true);
  expect(retryDelaySeconds).toBe(60);
  const updated = ((await storedRefreshJob(job.id)) ?? {}) as RefreshJob;
  expect(updated.status).toBe("queued");
  expect(updated.error).toBe("dashboard deadline reached");
  expect(updated.finishedAt).toBe(null);
});

test("worker aborts Queue GitHub App token lookup at the delivery deadline", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = dashboardCacheKey({
    owner: "credential-deadline",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "credential-deadline",
    owners: ["credential-deadline"],
    repos: [],
    includeReleaseData: true,
    path: "/credential-deadline",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-credential-deadline",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: "2026-06-11T07:00:00Z",
    updatedAt: "2026-06-11T07:00:00Z",
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  await cacheWith({});
  await storeRefreshTarget(target);
  await storeRefreshJob(job);
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let credentialAborted = false;
  let retryDelaySeconds: number | undefined;
  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    originalSetTimeout(callback, delay === 12 * 60 * 1000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/app/installations") {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          credentialAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            credentialAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    await worker.queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              throw new Error("credential deadline job should not be acknowledged");
            },
            retry(options) {
              retryDelaySeconds = options?.delaySeconds;
            },
          },
        ],
      },
      {
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }

  expect(credentialAborted).toBe(true);
  expect(retryDelaySeconds).toBe(60);
  const updated = ((await storedRefreshJob(job.id)) ?? {}) as RefreshJob;
  expect(updated.status).toBe("queued");
  expect(updated.error).toBe("dashboard deadline reached");
});
