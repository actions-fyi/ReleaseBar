import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../src/types.ts";
import {
  buildLockTtlMs,
  refreshJobReservationTtlMs,
  type RefreshTargetMutation,
} from "../worker/config.ts";
import { mutateRefreshTargetState } from "../worker/refresh-targets.ts";
import {
  BuildCoordinator,
  kvStore,
  objectsUnavailable,
  RefreshTargetIndex,
  testEnv,
  testDashboard,
  testProject,
  worker,
  seedOwnerMetadata,
} from "./dashboard-test-harness.ts";

test("worker Queue messages stay bounded when profile filters are large", async () => {
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
    hiddenRepos: Array.from(
      { length: 5000 },
      (_, index) => `profiled/repository-${String(index).padStart(4, "0")}`,
    ),
    updatedAt: "2026-06-11T07:00:00Z",
    updatedBy: "profiled",
  };
  const profileSnapshotKey = `refresh:profile-snapshot:v1:profiled:${encodeURIComponent(
    profile.updatedAt,
  )}`;
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
    nextDueAt: "2000-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [profileSnapshotKey]: JSON.stringify(profile),
  });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];

  await (
    worker as unknown as {
      scheduled(
        event: { cron: string },
        env: unknown,
        context: { waitUntil(promise: Promise<unknown>): void },
      ): Promise<void>;
    }
  ).scheduled(
    { cron: "*/15 * * * *" },
    {
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    },
    { waitUntil: (promise) => waits.push(promise) },
  );
  await Promise.all(waits);

  expect(sentJobs.length).toBe(1);
  expect(sentJobs[0]?.target).toBe(undefined);
  expect(JSON.stringify(sentJobs[0]).length < 4096).toBe(true);
  const snapshot = JSON.parse(
    (await cache.get(sentJobs[0]?.targetSnapshotKey ?? "")) ?? "{}",
  ) as RefreshJob;
  expect(snapshot.target?.profileSnapshotKey).toBe(profileSnapshotKey);
  expect(JSON.stringify(snapshot.target).length < 4096).toBe(true);
  expect(await cache.get("refresh:target-index:v1:ready")).toBe(null);
  const storedProfile = JSON.parse((await cache.get(profileSnapshotKey)) ?? "{}") as {
    hiddenRepos?: string[];
  };
  expect(storedProfile.hiddenRepos?.length).toBe(5000);
});

test("owner count scheduling rotates beyond a deferred owner cap", async () => {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const owners = Array.from({ length: 21 }, (_, index) => `owner${String(index).padStart(3, "0")}`);
  const entries = Object.fromEntries(
    owners.flatMap((owner) => {
      const key = dashboardCacheKey({
        owner,
        includeUnreleased: true,
        includeReleaseData: true,
        schemaVersion: 6,
      });
      const project = testProject({ owner, name: "repo" });
      const target: RefreshTarget = {
        key,
        kind: "dashboard",
        owner,
        owners: [owner],
        repos: [],
        includeReleaseData: true,
        path: `/${owner}`,
        priority: 100,
        lastSeenAt: now,
        lastAttemptAt: null,
        lastSuccessAt: now,
        nextDueAt: "2999-01-01T00:00:00Z",
        failureCount: 0,
      };
      return [
        [`refresh:target:v1:${key}`, JSON.stringify(target)],
        [key, JSON.stringify(testDashboard(owner, [project]))],
      ];
    }),
  );
  for (const owner of owners) {
    const project = testProject({ owner, name: "repo" });
    await seedOwnerMetadata(owner, {
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: staleAt,
      releaseDataComplete: true,
      knownRepos: [project.fullName.toLowerCase()],
      removedRepos: {},
      projectMetadataUpdatedAt: { [project.fullName.toLowerCase()]: now },
      projectCountsUpdatedAt: { [project.fullName.toLowerCase()]: staleAt },
      projects: [project],
    });
  }
  const cache = kvStore(entries);
  const run = async () => {
    const waits: Promise<unknown>[] = [];
    await (
      worker as unknown as {
        scheduled(
          event: { cron: string },
          env: unknown,
          context: { waitUntil(promise: Promise<unknown>): void },
        ): Promise<void>;
      }
    ).scheduled(
      { cron: "*/15 * * * *" },
      { DASHBOARD_CACHE: cache },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  };

  await run();
  expect(await cache.get("refresh:owner-count-cursor:v1")).toBe("owner019");
  await run();
  expect(await cache.get("refresh:owner-count-cursor:v1")).toBe("owner018");
});

test("owner count scheduling throttles recent incomplete scans", async () => {
  const now = new Date().toISOString();
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "large-owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "large-owner", name: "repo" });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "large-owner",
    owners: ["large-owner"],
    repos: [],
    includeReleaseData: true,
    path: "/large-owner",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  await seedOwnerMetadata(
    "large-owner",
    JSON.stringify({
      owner: "large-owner",
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: staleAt,
      countsAttemptedAt: now,
      releaseDataComplete: true,
      knownRepos: [project.fullName.toLowerCase()],
      removedRepos: {},
      projectMetadataUpdatedAt: { [project.fullName.toLowerCase()]: now },
      projectCountsUpdatedAt: { [project.fullName.toLowerCase()]: staleAt },
      projects: [project],
    }),
  );
  const cache = kvStore({
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [key]: JSON.stringify(testDashboard("large-owner", [project])),
  });
  const originalFetch = globalThis.fetch;
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    if (new URL(String(input)).pathname === "/graphql") graphqlRequests += 1;
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/15 * * * *" } as never,
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(graphqlRequests).toBe(0);
  expect(await cache.get("refresh:owner-count-cursor:v1")).toBe(null);
});

// Runs `check` with the clock moved forward.
async function later(ms: number, check: () => Promise<void>): Promise<void> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    await check();
  } finally {
    Date.now = realNow;
  }
}

test("dashboard build lock only releases the matching lease token", async () => {
  const coordinator = env.BUILD_COORDINATOR.getByName("lease-token");

  expect(await coordinator.acquireLock("first")).toBe(true);
  expect(await coordinator.acquireLock("second")).toBe(false);

  // The first lease expires unreleased.
  await later(buildLockTtlMs + 1, async () => {
    expect(await coordinator.acquireLock("second")).toBe(true);
    expect(await coordinator.refreshLock("first")).toBe(false);
    expect(await coordinator.refreshLock("second")).toBe(true);
    await coordinator.releaseLock("first");
    expect(await coordinator.acquireLock("third")).toBe(false);
    await coordinator.releaseLock("second");
    expect(await coordinator.acquireLock("third")).toBe(true);
  });
});

test("dashboard build lock reserves one refresh job per dashboard", async () => {
  const coordinator = env.BUILD_COORDINATOR.getByName("one-job");

  expect(await coordinator.jobActive()).toBe(false);
  expect(await coordinator.reserveJob("first")).toBe(true);
  expect(await coordinator.jobActive()).toBe(true);
  expect(await coordinator.reserveJob("second")).toBe(false);
  expect(await coordinator.reserveJob("first")).toBe(true);
  await coordinator.releaseJob("second", false);
  expect(await coordinator.reserveJob("second")).toBe(false);
  await coordinator.releaseJob("first", false);
  expect(await coordinator.jobActive()).toBe(false);
  expect(await coordinator.reserveJob("second")).toBe(true);

  // A reservation that is never released expires.
  await later(refreshJobReservationTtlMs + 1, async () => {
    expect(await coordinator.jobActive()).toBe(false);
    expect(await coordinator.reserveJob("third")).toBe(true);
  });
});

test("a refused refresh job reservation leaves its newest dirty marker for the holder", async () => {
  const coordinator = env.BUILD_COORDINATOR.getByName("dirty-marker");
  const newer = { observedAt: "2026-06-11T12:02:00Z", reason: "webhook:push" };
  const older = { observedAt: "2026-06-11T12:01:00Z", reason: "webhook:release" };

  expect(await coordinator.reserveJob("first")).toBe(true);
  expect(await coordinator.reserveJob("second", newer)).toBe(false);
  expect(await coordinator.reserveJob("third", older)).toBe(false);
  // Only the job that holds the reservation takes the marker, and only when it asks for it.
  expect(await coordinator.releaseJob("second", true)).toBe(null);
  expect(await coordinator.releaseJob("first", true)).toStrictEqual(newer);
  expect(await coordinator.reserveJob("second")).toBe(true);
  expect(await coordinator.releaseJob("second", true)).toBe(null);
});

test("dashboard target mutations preserve terminal backoff across stale observations", async () => {
  const cache = kvStore();
  const mutationEnv = testEnv({ DASHBOARD_CACHE: cache });
  const input = {
    key: "dashboard:v6:owner=target-race",
    owner: "target-race",
    owners: ["target-race"],
    repos: [],
    includeReleaseData: true,
    path: "/target-race",
    priority: 100,
  };
  const mutate = async (snapshot: RefreshTarget | null, mutation: RefreshTargetMutation) => {
    const updated = await mutateRefreshTargetState(mutationEnv, snapshot, mutation);
    assert(updated);
    return updated;
  };

  const observed = await mutate(null, {
    kind: "observe",
    input,
    observedAt: "2026-06-11T12:00:00Z",
    profileProvided: false,
  });
  const failed = await mutate(observed, {
    kind: "failure",
    at: "2026-06-11T12:01:00Z",
    message: "terminal failure",
    terminal: true,
  });
  // The cache loses the target; the object still knows it.
  await cache.delete(`refresh:target:v1:${input.key}`);
  const observedAgain = await mutate(null, {
    kind: "observe",
    input,
    observedAt: "2026-06-11T12:02:00Z",
    profileProvided: false,
  });

  expect(observedAgain.failureCount).toBe(1);
  expect(observedAgain.nextDueAt).toBe(failed.nextDueAt);
  expect(observedAgain.terminalBackoffUntil).toBe(failed.nextDueAt);
  expect(observedAgain.message).toBe("terminal failure");
  const stored = JSON.parse(
    (await cache.get(`refresh:target:v1:${input.key}`)) ?? "{}",
  ) as RefreshTarget;
  expect(stored.terminalBackoffUntil).toBe(failed.nextDueAt);
});

test("a refresh target the object does not know yet starts from the cached one", async () => {
  const coordinator = env.BUILD_COORDINATOR.getByName("target-seed");
  const target: RefreshTarget = {
    key: "target-seed",
    kind: "dashboard",
    owner: "seed",
    owners: ["seed"],
    repos: [],
    includeReleaseData: true,
    path: "/seed",
    priority: 100,
    lastSeenAt: "2026-06-11T12:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T13:00:00Z",
    failureCount: 3,
  };
  const stale = { ...target, failureCount: 0 };
  const defer: RefreshTargetMutation = {
    kind: "defer",
    at: "2026-06-11T12:30:00Z",
    nextDueAt: "2026-06-11T14:00:00Z",
    message: "deferred",
  };

  // Without state of its own the object asks for the cached target, and changes nothing.
  expect(await coordinator.mutateTarget(stale, defer)).toBe(null);
  const seeded = await coordinator.mutateTarget(stale, defer, { current: target });
  expect(seeded?.failureCount).toBe(3);
  expect(seeded?.nextDueAt).toBe("2026-06-11T14:00:00Z");
  // From then on its own state counts, not the caller's snapshot.
  const again = await coordinator.mutateTarget(stale, { ...defer, message: "again" });
  expect(again?.failureCount).toBe(3);
  expect(again?.message).toBe("again");
});

test("dashboard build lock stores strongly consistent build progress", async () => {
  const coordinator = env.BUILD_COORDINATOR.getByName("build-progress");
  const progress = {
    scannedRepos: ["owner/repo"],
    projects: [testProject({ owner: "owner", name: "repo" })],
    updatedAt: new Date().toISOString(),
  };

  expect(await coordinator.progress()).toBe(null);
  await coordinator.putProgress(progress);
  expect(await coordinator.progress()).toStrictEqual(progress);
  await coordinator.deleteProgress();
  expect(await coordinator.progress()).toBe(null);

  // Expired progress is dropped when it is read.
  await coordinator.putProgress({ ...progress, updatedAt: "2020-01-01T00:00:00Z" });
  expect(await coordinator.progress()).toBe(null);
  const rows = await runInDurableObject(coordinator, (_instance, state) =>
    state.storage.sql.exec("SELECT value FROM build_progress").toArray(),
  );
  expect(rows).toStrictEqual([]);
});

test("worker falls back to KV progress when the Durable Object is unavailable", async () => {
  const cache = kvStore();
  const waits: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/owner") {
      return Response.json({ login: "owner", type: "User" });
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
    throw new Error(`unexpected fetch ${path}`);
  };
  objectsUnavailable(BuildCoordinator, RefreshTargetIndex);
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: {
          send: async () => undefined,
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(200);
    const fallback = JSON.parse((await cache.get(`progress:v1:${key}`)) ?? "{}") as {
      durableFallback?: boolean;
    };
    expect(fallback.durableFallback).toBe(true);
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker resumes marked KV progress after an authoritative Durable Object miss", async () => {
  const key = dashboardCacheKey({
    owner: "fallback",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner: "fallback",
    owners: ["fallback"],
    repos: [],
    includeReleaseData: true,
    path: "/fallback",
    priority: 100,
    lastSeenAt: "2026-06-11T07:00:00Z",
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2026-06-11T07:00:00Z",
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-kv-progress-fallback",
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
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "fallback" },
      name,
      full_name: `fallback/${name}`,
      description: null,
      html_url: `https://github.com/fallback/${name}`,
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
    };
  });
  const progressProjects = repos.slice(0, 12).map((repo) =>
    testProject({
      owner: "fallback",
      name: repo.name,
      pushedAt: repo.pushed_at,
      updatedAt: repo.updated_at,
      latestCommitDate: repo.updated_at,
    }),
  );
  const cache = kvStore({
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: progressProjects.map((project) => project.fullName.toLowerCase()),
      projects: progressProjects,
      updatedAt: "2026-06-11T07:00:00Z",
      durableFallback: true,
    }),
    [`refresh:job:v1:${job.id}`]: JSON.stringify(job),
  });
  const originalFetch = globalThis.fetch;
  const hydratedRepos: string[] = [];
  let acked = false;
  try {
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/users/fallback") {
        return Response.json({ login: "fallback", type: "User" });
      }
      if (path === "/users/fallback/repos") {
        return Response.json(repos);
      }
      if (path.endsWith("/releases")) {
        hydratedRepos.push(path.split("/")[3] ?? "");
        return Response.json([]);
      }
      if (path.endsWith("/commits/main")) {
        return Response.json({
          sha: "abcdef123456",
          commit: { committer: { date: "2026-06-11T07:00:00Z" } },
        });
      }
      if (path.endsWith("/pulls")) {
        return Response.json([]);
      }
      if (path.endsWith("/check-runs")) {
        return Response.json({ check_runs: [] });
      }
      throw new Error(`unexpected fetch ${path}`);
    };
    await (
      worker as unknown as {
        queue(
          batch: {
            messages: Array<{
              body: RefreshJob;
              attempts?: number;
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
            attempts: 1,
            ack() {
              acked = true;
            },
            retry() {
              throw new Error("KV fallback progress should complete");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(acked).toBe(true);
  expect(hydratedRepos).toStrictEqual(["repo-13"]);
  const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
  expect(dashboard.projects.length).toBe(13);
  expect(dashboard.cache?.progress?.done).toBe(true);
});
