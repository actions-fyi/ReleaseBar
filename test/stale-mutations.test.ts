import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, Project, RefreshJob, RefreshTarget } from "../src/types.ts";
import {
  DashboardBuildLock,
  durableLocks,
  kvStore,
  testDashboard,
  testProject,
  webhookSignature,
  worker,
} from "./dashboard-test-harness.ts";

test("older owner count refreshes cannot replace newer snapshots", async () => {
  const metadataAt = "2026-06-11T02:00:00Z";
  const olderAt = "2026-06-11T03:00:00Z";
  const newerAt = "2026-06-11T04:00:00Z";
  const repo = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const sibling = testProject({ owner: "owner", name: "sibling", openIssues: 2 });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({
    kind: "merge",
    generatedAt: metadataAt,
    observedAt: metadataAt,
    countsUpdatedAt: metadataAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [repo, sibling],
    removedRepos: [],
  });
  await mutate({
    kind: "counts",
    updatedAt: newerAt,
    complete: true,
    counts: [
      {
        fullName: repo.fullName,
        openIssues: 7,
        openPullRequests: 3,
        archived: false,
        fork: false,
        private: false,
        pushedAt: newerAt,
        updatedAt: newerAt,
      },
      {
        fullName: sibling.fullName,
        openIssues: 9,
        openPullRequests: 4,
        archived: false,
        fork: false,
        private: false,
        pushedAt: newerAt,
        updatedAt: newerAt,
      },
    ],
  });
  await mutate({
    kind: "counts",
    updatedAt: olderAt,
    complete: true,
    counts: [
      {
        fullName: repo.fullName,
        openIssues: 5,
        openPullRequests: 2,
        archived: false,
        fork: false,
        private: false,
        pushedAt: olderAt,
        updatedAt: olderAt,
      },
    ],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    countsUpdatedAt?: string;
    knownRepos?: string[];
    projects?: Project[];
  };
  expect(snapshot.countsUpdatedAt).toBe(newerAt);
  expect(snapshot.knownRepos?.sort()).toStrictEqual(["owner/repo", "owner/sibling"]);
  expect(snapshot.projects?.find((project) => project.fullName === repo.fullName)?.openIssues).toBe(
    7,
  );
  expect(
    snapshot.projects?.find((project) => project.fullName === sibling.fullName)?.openIssues,
  ).toBe(9);
});

test("older complete count scans preserve newer repository metadata", async () => {
  const countsAt = "2026-06-11T03:00:00Z";
  const metadataAt = "2026-06-11T04:00:00Z";
  const project = testProject({ owner: "owner", name: "repo", updatedAt: metadataAt });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({
    kind: "merge",
    generatedAt: metadataAt,
    observedAt: metadataAt,
    countsUpdatedAt: "2026-06-11T02:00:00Z",
    countsComplete: false,
    releaseDataComplete: false,
    mode: "metadata",
    projects: [project],
    removedRepos: [],
  });
  await mutate({
    kind: "counts",
    updatedAt: countsAt,
    complete: true,
    counts: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    knownRepos?: string[];
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  expect(snapshot.knownRepos).toStrictEqual(["owner/repo"]);
  expect(snapshot.removedRepos?.["owner/repo"]).toBe(undefined);
  expect(snapshot.projects?.[0]?.fullName).toBe("owner/repo");
});

test("newer metadata merges preserve counts without restoring stale repository state", async () => {
  const countsAt = "2026-06-11T03:00:00Z";
  const metadataAt = "2026-06-11T04:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    archived: false,
    openIssues: 7,
    openPullRequests: 3,
    pushedAt: countsAt,
    updatedAt: countsAt,
  });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({
    kind: "merge",
    generatedAt: countsAt,
    observedAt: countsAt,
    countsUpdatedAt: countsAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  await mutate({
    kind: "merge",
    generatedAt: metadataAt,
    observedAt: metadataAt,
    countsUpdatedAt: null,
    countsComplete: false,
    releaseDataComplete: false,
    mode: "metadata",
    projects: [
      {
        ...project,
        archived: true,
        openIssues: null,
        openPullRequests: null,
        pushedAt: metadataAt,
        updatedAt: metadataAt,
      },
    ],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    projects?: Project[];
  };
  expect(snapshot.projects?.[0]?.archived).toBe(true);
  expect(snapshot.projects?.[0]?.pushedAt).toBe(metadataAt);
  expect(snapshot.projects?.[0]?.updatedAt).toBe(metadataAt);
  expect(snapshot.projects?.[0]?.openIssues).toBe(7);
  expect(snapshot.projects?.[0]?.openPullRequests).toBe(3);

  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  await cache.put(
    key,
    JSON.stringify({
      ...testDashboard("owner", [{ ...project, openIssues: 1, openPullRequests: 1 }]),
      generatedAt: countsAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: countsAt,
        countsUpdatedAt: "2026-06-11T02:00:00Z",
        projectCountsUpdatedAt: { "owner/repo": "2026-06-11T02:00:00Z" },
        releasesUpdatedAt: countsAt,
        ciUpdatedAt: countsAt,
      },
    } satisfies DashboardPayload),
  );
  const dashboard = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
    waitUntil: () => undefined,
  });
  expect(dashboard.status).toBe(200);
  expect(((await dashboard.json()) as DashboardPayload).projects.length).toBe(0);
});

test("older dashboard builds cannot restore repositories removed by newer counts", async () => {
  const buildStartedAt = "2026-06-11T02:00:00Z";
  const countsUpdatedAt = "2026-06-11T03:00:00Z";
  const project = testProject({ owner: "owner", name: "repo" });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({
    kind: "merge",
    generatedAt: buildStartedAt,
    observedAt: buildStartedAt,
    countsUpdatedAt: buildStartedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  await mutate({
    kind: "counts",
    updatedAt: countsUpdatedAt,
    complete: true,
    counts: [],
  });
  await mutate({
    kind: "merge",
    generatedAt: countsUpdatedAt,
    observedAt: buildStartedAt,
    countsUpdatedAt: buildStartedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    knownRepos?: string[];
    projects?: Project[];
  };
  expect(snapshot.knownRepos).toStrictEqual([]);
  expect(snapshot.projects?.length).toBe(0);
});

test("complete metadata scans tombstone absent repositories across cached variants", async () => {
  const initialAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const staleBuildAt = new Date(Date.now() - 60 * 1000).toISOString();
  const removedAt = new Date().toISOString();
  const repo = testProject({ owner: "owner", name: "repo" });
  const sibling = testProject({ owner: "owner", name: "sibling" });
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cache = kvStore({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: initialAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: initialAt,
        countsUpdatedAt: initialAt,
      },
    } satisfies DashboardPayload),
    "owner-metadata:v1:owner": JSON.stringify({
      owner: "owner",
      generatedAt: initialAt,
      metadataUpdatedAt: initialAt,
      countsUpdatedAt: initialAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo", "owner/sibling"],
      removedRepos: {},
      projectMetadataUpdatedAt: {
        "owner/repo": initialAt,
        "owner/sibling": initialAt,
      },
      projects: [repo, sibling],
    }),
  });
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({
    kind: "merge",
    generatedAt: removedAt,
    observedAt: removedAt,
    countsUpdatedAt: removedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [sibling],
    removedRepos: ["owner/repo"],
  });
  await mutate({
    kind: "merge",
    generatedAt: removedAt,
    observedAt: staleBuildAt,
    countsUpdatedAt: staleBuildAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [repo, sibling],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    knownRepos?: string[];
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  expect(snapshot.knownRepos).toStrictEqual(["owner/sibling"]);
  expect(snapshot.removedRepos?.["owner/repo"]).toBe(removedAt);
  expect(snapshot.projects?.some((project) => project.fullName === "owner/repo")).toBe(false);

  const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
    waitUntil: () => undefined,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.map((project) => project.fullName)).toStrictEqual(["owner/sibling"]);
});

test("stale repository removals cannot hide newer public metadata", async () => {
  const removedAt = "2026-06-11T03:00:00Z";
  const publicAt = "2026-06-11T04:00:00Z";
  const project = testProject({
    owner: "owner",
    name: "repo",
    updatedAt: publicAt,
  });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({
    kind: "merge",
    generatedAt: publicAt,
    observedAt: publicAt,
    countsUpdatedAt: publicAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  await mutate({ kind: "remove", fullName: project.fullName.toLowerCase(), observedAt: removedAt });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  expect(snapshot.removedRepos?.[project.fullName.toLowerCase()]).toBe(undefined);
  expect(snapshot.projects?.some((candidate) => candidate.fullName === project.fullName)).toBe(
    true,
  );
});

test("newer owner metadata merges cannot clear privacy tombstones", async () => {
  const removedAt = "2026-06-11T03:00:00Z";
  const observedAt = "2026-06-11T04:00:00Z";
  const project = testProject({ owner: "owner", name: "repo" });
  const cache = kvStore();
  const env: ConstructorParameters<typeof DashboardBuildLock>[1] = {
    DASHBOARD_CACHE: cache,
  };
  const locks = durableLocks(env);
  env.DASHBOARD_LOCKS = {
    idFromName: locks.idFromName,
    get: locks.get,
  };
  const stub = env.DASHBOARD_LOCKS.get(env.DASHBOARD_LOCKS.idFromName("owner-metadata:owner"));
  const mutate = async (mutation: Record<string, unknown>) => {
    const response = await stub.fetch(
      new Request("https://releasebar.internal/owner-metadata/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: "owner", mutation }),
      }),
    );
    expect(response.ok || response.status === 204).toBe(true);
  };

  await mutate({ kind: "remove", fullName: "owner/repo", observedAt: removedAt });
  await mutate({
    kind: "merge",
    generatedAt: observedAt,
    observedAt,
    countsUpdatedAt: observedAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });

  const snapshot = JSON.parse((await cache.get("owner-metadata:v1:owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
    projects?: Project[];
  };
  expect(snapshot.removedRepos?.["owner/repo"]).toBe(removedAt);
  expect(snapshot.projects?.some((candidate) => candidate.fullName === "owner/repo")).toBe(false);
});

test("worker persists archived observations without showing archived repositories", async () => {
  const owner = "archived-observation";
  const generatedAt = "2026-06-11T01:00:00Z";
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({
    owner,
    name: "repo",
    archived: false,
    updatedAt: generatedAt,
  });
  const cache = kvStore({
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: [],
      projects: [project],
      updatedAt: generatedAt,
      durableFallback: true,
    }),
  });
  const target: RefreshTarget = {
    key,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: generatedAt,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: generatedAt,
    failureCount: 0,
  };
  const job: RefreshJob = {
    id: "job-archived-observation",
    targetKey: key,
    target,
    kind: "dashboard",
    status: "queued",
    reason: "partial-cache",
    createdAt: generatedAt,
    updatedAt: generatedAt,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/users/${owner}/repos`) {
      return Response.json([
        {
          owner: { login: owner },
          name: "repo",
          full_name: `${owner}/repo`,
          description: "archived repository",
          html_url: `https://github.com/${owner}/repo`,
          default_branch: "main",
          language: "TypeScript",
          topics: [],
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 0,
          archived: true,
          pushed_at: "2026-06-11T02:00:00Z",
          updated_at: "2026-06-11T02:00:00Z",
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    let acknowledged = false;
    await worker.queue(
      {
        messages: [
          {
            body: job,
            attempts: 1,
            ack() {
              acknowledged = true;
            },
            retry() {
              throw new Error("archived observation refresh should not retry");
            },
          },
        ],
      },
      { DASHBOARD_CACHE: cache },
      { waitUntil: () => undefined },
    );
    expect(acknowledged).toBe(true);
    const dashboard = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    expect(dashboard.projects.length).toBe(0);
    const snapshot = JSON.parse((await cache.get(`owner-metadata:v1:${owner}`)) ?? "{}") as {
      projects?: Project[];
      removedRepos?: Record<string, string>;
    };
    expect(snapshot.projects?.[0]?.archived).toBe(true);
    expect(snapshot.removedRepos?.[`${owner}/repo`]).toBe(undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker preserves field freshness when resuming an older progress checkpoint", async () => {
  const originalFetch = globalThis.fetch;
  const owner = "freshness-checkpoint";
  const now = new Date();
  const generatedAt = now.toISOString();
  const generationStartedAt = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const removedAt = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const releasesUpdatedAt = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const ciUpdatedAt = new Date(now.getTime() - 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner, name: "repo" });
  const cache = kvStore({
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
    [`progress:v1:${key}`]: JSON.stringify({
      scannedRepos: [project.fullName.toLowerCase()],
      projects: [project],
      generationStartedAt,
      countsUpdatedAt: generatedAt,
      releasesUpdatedAt,
      ciUpdatedAt,
      updatedAt: generatedAt,
      durableFallback: true,
    }),
    [`owner-metadata:v1:${owner}`]: JSON.stringify({
      owner,
      generatedAt: removedAt,
      metadataUpdatedAt: removedAt,
      countsUpdatedAt: null,
      releaseDataComplete: false,
      knownRepos: [],
      removedRepos: { [project.fullName.toLowerCase()]: removedAt },
      projectMetadataUpdatedAt: {},
      projectCountsUpdatedAt: {},
      countOverlays: {},
      projects: [],
    }),
  });
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === `/users/${owner}/repos`) {
      return Response.json([
        {
          owner: { login: owner },
          name: project.name,
          full_name: project.fullName,
          description: null,
          html_url: project.url,
          default_branch: project.defaultBranch,
          language: null,
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          archived: false,
          pushed_at: project.pushedAt,
          updated_at: project.updatedAt,
          fork: false,
          private: false,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const env = {
      DASHBOARD_CACHE: cache,
      REFRESH_QUEUE: {
        async send(job: RefreshJob) {
          sentJobs.push(job);
        },
      },
    };
    const response = await worker.fetch(new Request(`https://release.bar/api/${owner}`), env, {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(response.status).toBe(200);
    const resumed = (await response.json()) as DashboardPayload;
    expect(resumed.cache?.countsUpdatedAt).toBe(generatedAt);
    expect(resumed.cache?.releasesUpdatedAt).toBe(releasesUpdatedAt);
    expect(resumed.cache?.ciUpdatedAt).toBe(ciUpdatedAt);
    await Promise.all(waits);
    expect(sentJobs.length).toBe(1);
    assert.ok(sentJobs[0]);

    let acknowledged = false;
    await worker.queue(
      {
        messages: [
          {
            body: sentJobs[0],
            attempts: 1,
            ack: () => {
              acknowledged = true;
            },
            retry: () => undefined,
          },
        ],
      },
      env,
      { waitUntil: () => undefined },
    );
    expect(acknowledged).toBe(true);
    const completed = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    expect(completed.projects.length).toBe(0);
    expect(completed.cache?.releasesUpdatedAt).toBe(releasesUpdatedAt);
    expect(completed.cache?.ciUpdatedAt).toBe(ciUpdatedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signed repository-less GitHub App webhooks are acknowledged", async () => {
  const secret = "webhook-secret";
  const body = JSON.stringify({
    action: "created",
    installation: { id: 42 },
    sender: { login: "owner" },
  });
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-installation",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    { GITHUB_WEBHOOK_SECRET: secret },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toStrictEqual({ ok: true, ignored: true });
});

test("signed private repository webhooks are ignored before durable admission", async () => {
  const secret = "webhook-secret";
  const body = JSON.stringify({
    ref: "refs/heads/main",
    repository: {
      full_name: "owner/private-repo",
      private: true,
      default_branch: "main",
      updated_at: "2026-06-11T04:00:00Z",
    },
  });
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-private-push",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    { GITHUB_WEBHOOK_SECRET: secret },
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toStrictEqual({ ok: true, ignored: true });
});
