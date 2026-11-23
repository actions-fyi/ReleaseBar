import { generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, Project, RefreshJob } from "../src/types.ts";
import { ownerMetadataObjectName } from "../worker/runtime.ts";
import {
  BuildCoordinator,
  buildLocksHeld,
  kvStore,
  testDashboard,
  testEnv,
  testProject,
  worker,
} from "./dashboard-test-harness.ts";

test("worker filters shared owner snapshots for cold combined dashboards", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    if (url.pathname === "/users/stale") {
      return Response.json({ login: "stale", type: "User" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  buildLocksHeld();
  const now = new Date().toISOString();
  const snapshot = (
    owner: string,
    projects: Project[],
    projectMetadataUpdatedAt: Record<string, string> = {},
  ) =>
    JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      projectMetadataUpdatedAt: Object.fromEntries(
        projects.map((project) => [
          project.fullName.toLowerCase(),
          projectMetadataUpdatedAt[project.fullName.toLowerCase()] ?? now,
        ]),
      ),
      projects,
    });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta,stale&unreleased=false"),
      {
        DASHBOARD_CACHE: kvStore({
          "owner-metadata:v1:alpha": snapshot(
            "alpha",
            [
              testProject({ owner: "alpha", name: "released", fork: false }),
              testProject({ owner: "alpha", name: "fork", fork: true }),
              testProject({
                owner: "alpha",
                name: "unreleased",
                fork: false,
                releaseDate: null,
                version: "unreleased",
              }),
              testProject({ owner: "alpha", name: "expired", fork: false }),
            ],
            {
              "alpha/expired": new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            },
          ),
          "owner-metadata:v1:beta": snapshot("beta", [
            testProject({ owner: "beta", name: "released", fork: false }),
          ]),
          "owner-metadata:v1:stale": JSON.stringify({
            owner: "stale",
            generatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            metadataUpdatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
            countsUpdatedAt: now,
            projects: [testProject({ owner: "stale", name: "private-now", fork: false })],
          }),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(body.projects.map((project) => project.fullName).sort()).toStrictEqual([
      "alpha/released",
      "beta/released",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker uses explicit repository owner snapshots for cold dashboards", async () => {
  const now = new Date().toISOString();
  const project = testProject({ owner: "other", name: "repo" });
  buildLocksHeld();
  const response = await worker.fetch(
    new Request("https://release.bar/api/dashboard?repos=other/repo"),
    {
      DASHBOARD_CACHE: kvStore({
        "owner-metadata:v1:other": JSON.stringify({
          owner: "other",
          generatedAt: now,
          metadataUpdatedAt: now,
          countsUpdatedAt: now,
          knownRepos: ["other/repo"],
          projectMetadataUpdatedAt: { "other/repo": now },
          projectCountsUpdatedAt: { "other/repo": now },
          projects: [project],
        }),
      }),
    },
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.map((candidate) => candidate.fullName)).toStrictEqual(["other/repo"]);
});

test("cold partial dashboards honor durable privatization tombstones over stale KV", async () => {
  const now = new Date().toISOString();
  const project = testProject({ owner: "owner", name: "repo" });
  const privateSnapshot = {
    owner: "owner",
    generatedAt: now,
    metadataUpdatedAt: now,
    countsUpdatedAt: now,
    countsAttemptedAt: now,
    releaseDataComplete: true,
    knownRepos: [],
    privateRepos: { "owner/repo": now },
    removedRepos: { "owner/repo": now },
    projectMetadataUpdatedAt: { "owner/repo": now },
    projectCountsUpdatedAt: {},
    countOverlays: {},
    projects: [],
  };
  // The owner's Durable Object learns of the privatization from a cache that has it; the cache
  // the Worker then runs with is older.
  await testEnv({
    DASHBOARD_CACHE: kvStore({ "owner-metadata:v1:owner": JSON.stringify(privateSnapshot) }),
  })
    .OWNER_METADATA.getByName(ownerMetadataObjectName("owner"))
    .read("owner");
  buildLocksHeld();
  const response = await worker.fetch(
    new Request("https://release.bar/api/dashboard?repos=owner/repo"),
    {
      DASHBOARD_CACHE: kvStore({
        "owner-metadata:v1:owner": JSON.stringify({
          ...privateSnapshot,
          privateRepos: {},
          removedRepos: {},
          knownRepos: ["owner/repo"],
          projectCountsUpdatedAt: { "owner/repo": now },
          projects: [project],
        }),
      }),
    },
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects).toStrictEqual([]);
});

test("metadata-only partial dashboards strip hydrated release and CI fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/users/alpha") {
      return Response.json({ login: "alpha", type: "User" });
    }
    if (url.pathname === "/users/beta") {
      return Response.json({ login: "beta", type: "Organization" });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  buildLocksHeld();
  const now = new Date().toISOString();
  const snapshot = (owner: string) =>
    JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      releaseDataComplete: true,
      projects: [testProject({ owner, name: "repo", ciState: "failure" })],
    });
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/alpha?owners=beta"),
      {
        DASHBOARD_CACHE: kvStore({
          "owner-metadata:v1:alpha": snapshot("alpha"),
          "owner-metadata:v1:beta": snapshot("beta"),
        }),
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("partial");
    expect(body.projects.length).toBe(2);
    for (const project of body.projects) {
      expect(project.version).toBe("repo search");
      expect(project.releaseDate).toBe(null);
      expect(project.latestCommitSha).toBe(null);
      expect(project.commitsSinceRelease).toBe(null);
      expect(project.ciState).toBe("unknown");
      expect(project.ciConclusion).toBe(null);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker progressively resumes large owner dashboard builds from partial cache", async () => {
  const originalFetch = globalThis.fetch;
  const repos = Array.from({ length: 25 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "big" },
      name,
      full_name: `big/${name}`,
      description: null,
      html_url: `https://github.com/big/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      fork: false,
      private: false,
    };
  });
  const waitUntil: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => {
      waitUntil.push(promise);
    },
  };
  const env = { DASHBOARD_CACHE: kvStore() };

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/users/big") {
      return Response.json({ login: "big", type: "User" });
    }
    if (path === "/users/big/repos") {
      return Response.json(repos);
    }
    if (path.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/big/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-02T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/big/repo/compare",
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

  try {
    const first = await worker.fetch(new Request("https://release.bar/api/big"), env, context);
    const firstBody = (await first.json()) as DashboardPayload;
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(firstBody.cache?.state).toBe("partial");
    expect(firstBody.cache?.progress?.scanned).toBe(0);
    expect(firstBody.cache?.progress?.done).toBe(false);
    expect(firstBody.projects.length).toBe(25);
    expect(firstBody.projects.filter((project) => project.version === "repo search").length).toBe(
      25,
    );

    await Promise.all(waitUntil.splice(0));

    const second = await worker.fetch(new Request("https://release.bar/api/big"), env, context);
    const secondBody = (await second.json()) as DashboardPayload;
    expect(secondBody.cache?.state).toBe("fresh");
    expect(secondBody.cache?.progress?.done).toBe(true);
    expect(secondBody.projects.length).toBe(25);
    expect(typeof secondBody.cache?.releasesUpdatedAt).toBe("string");
    expect(secondBody.cache?.ciUpdatedAt).toBe(secondBody.cache?.releasesUpdatedAt);
    expect(secondBody.projects.filter((project) => project.version === "repo search").length).toBe(
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker bounds cold owner resolution by the response deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  let deliveryDelaySeconds: number | undefined;
  let ownerAborted = false;
  let releaseOwner: (() => void) | undefined;
  const ownerGate = new Promise<void>((resolve) => {
    releaseOwner = resolve;
  });
  let ownerStarted = false;
  const cache = kvStore();

  // The owner deadline is the cold-build wait minus the time the request has already taken, so
  // it is 15 seconds or a few milliseconds less.
  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    originalSetTimeout(
      callback,
      delay !== undefined && delay > 14_000 && delay <= 15_000 ? 0 : delay,
    )) as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/slowmeta") {
      ownerStarted = true;
      await new Promise<void>((resolve, reject) => {
        if (init?.signal?.aborted) {
          ownerAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        init?.signal?.addEventListener(
          "abort",
          () => {
            ownerAborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
        void ownerGate.then(resolve);
      });
      return Response.json({ login: "slowmeta", type: "User" });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/slowmeta"),
      {
        DASHBOARD_CACHE: cache,
        REFRESH_QUEUE: {
          async send(job: RefreshJob, options?: { delaySeconds?: number }) {
            sentJobs.push(job);
            deliveryDelaySeconds = options?.delaySeconds;
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(ownerStarted).toBe(true);
    expect(response.status).toBe(202);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("rebuilding");
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    expect(ownerAborted).toBe(true);
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("cold-metadata");
    expect(deliveryDelaySeconds).toBe(2);
  } finally {
    releaseOwner?.();
    await Promise.all(waits);
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("worker bounds cold GitHub App token lookup by the response deadline", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  let credentialAborted = false;
  const cache = kvStore();

  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    originalSetTimeout(callback, delay === 15_000 ? 0 : delay)) as typeof setTimeout;
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
    if (path === "/users/slowtoken") {
      throw new DOMException("Aborted", "AbortError");
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/slowtoken"),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        REFRESH_QUEUE: {
          async send(job: RefreshJob) {
            sentJobs.push(job);
          },
        },
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    expect(credentialAborted).toBe(true);
    await Promise.all(waits);
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("cold-build");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("worker resumes durable progress on cold metadata cache misses", async () => {
  const originalFetch = globalThis.fetch;
  const cache = kvStore();
  const waits: Promise<unknown>[] = [];
  const sentJobs: RefreshJob[] = [];
  const project = testProject({ owner: "checkpoint", name: "repo" });
  const progress = {
    scannedRepos: Array.from({ length: 43 }, (_, index) => `checkpoint/repo-${index}`),
    projects: [project],
    updatedAt: new Date().toISOString(),
  };
  // The dashboard's coordinator object holds the progress of an earlier build.
  vi.spyOn(BuildCoordinator.prototype, "progress").mockReturnValue(progress);
  const progressDeletes = vi.spyOn(BuildCoordinator.prototype, "deleteProgress");
  const progressWrites = vi.spyOn(BuildCoordinator.prototype, "putProgress");
  const releases = vi.spyOn(BuildCoordinator.prototype, "releaseLock");

  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/checkpoint") {
      return Response.json({ login: "checkpoint", type: "User" });
    }
    throw new Error(`unexpected fetch ${path}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/checkpoint"),
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
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(body.cache?.state).toBe("partial");
    expect(body.cache?.progress?.scanned).toBe(43);
    expect(body.projects).toStrictEqual([project]);
    await Promise.all(waits);
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("cold-metadata");
    expect(progressDeletes).not.toHaveBeenCalled();
    expect(progressWrites).not.toHaveBeenCalled();
    expect(releases).toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker chains direct progressive continuation after a cold build timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const repos = Array.from({ length: 13 }, (_, index) => {
    const name = `repo-${String(index + 1).padStart(2, "0")}`;
    return {
      owner: { login: "slow" },
      name,
      full_name: `slow/${name}`,
      description: null,
      html_url: `https://github.com/slow/${name}`,
      default_branch: "main",
      language: null,
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      archived: false,
      pushed_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-05-${String(25 - index).padStart(2, "0")}T00:00:00Z`,
      fork: false,
      private: false,
    };
  });
  const waits: Promise<unknown>[] = [];
  let releaseFirstRepo: (() => void) | undefined;
  const firstRepoGate = new Promise<void>((resolve) => {
    releaseFirstRepo = resolve;
  });
  let firstRepoStarted: (() => void) | undefined;
  const firstRepoFetch = new Promise<void>((resolve) => {
    firstRepoStarted = resolve;
  });
  let gated = false;
  const cache = kvStore();
  const key = dashboardCacheKey({
    owner: "slow",
    includeUnreleased: false,
    includeReleaseData: true,
    schemaVersion: 6,
  });

  globalThis.setTimeout = ((callback: () => void, delay?: number) =>
    originalSetTimeout(callback, delay === 15_000 ? 0 : delay)) as typeof setTimeout;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/users/slow") {
      return Response.json({ login: "slow", type: "User" });
    }
    if (path === "/users/slow/repos") {
      return Response.json(repos);
    }
    if (path.endsWith("/releases")) {
      if (!gated) {
        gated = true;
        firstRepoStarted?.();
        await firstRepoGate;
      }
      return Response.json([
        {
          tag_name: "v1.0.0",
          name: null,
          html_url: "https://github.com/slow/repo/releases/v1.0.0",
          draft: false,
          published_at: "2026-05-01T00:00:00Z",
        },
      ]);
    }
    if (path.endsWith("/commits/main")) {
      return Response.json({
        sha: "abcdef123456",
        commit: { committer: { date: "2026-05-02T00:00:00Z" } },
      });
    }
    if (path.includes("/compare/")) {
      return Response.json({
        total_commits: 0,
        html_url: "https://github.com/slow/repo/compare",
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

  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/slow?unreleased=false"),
      { DASHBOARD_CACHE: cache },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(202);
    await firstRepoFetch;
    releaseFirstRepo?.();
    while (waits.length > 0) {
      await Promise.all(waits.splice(0));
    }

    const stored = JSON.parse((await cache.get(key)) ?? "{}") as DashboardPayload;
    expect(stored.cache?.state).toBe("fresh");
    expect(stored.cache?.progress?.done).toBe(true);
    expect(stored.cache?.progress?.scanned).toBe(13);
    expect(stored.projects.length).toBe(13);
  } finally {
    releaseFirstRepo?.();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("worker deduplicates queued refreshes for partial dashboards", async () => {
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cached: DashboardPayload = {
    ...testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]),
    cache: {
      state: "partial",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt: new Date().toISOString(),
      progress: {
        scanned: 12,
        limit: 200,
        done: false,
      },
    },
  };
  const backingCache = kvStore({ [key]: JSON.stringify(cached) });
  let targetReads = 0;
  const cache = {
    ...backingCache,
    async get(storageKey: string) {
      if (storageKey.startsWith("refresh:target:v1:")) {
        targetReads += 1;
      }
      return backingCache.get(storageKey);
    },
  };
  const sentJobs: RefreshJob[] = [];
  let deliveryDelaySeconds: number | undefined;
  const env = {
    DASHBOARD_CACHE: cache,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      async send(job: RefreshJob, options?: { delaySeconds?: number }) {
        sentJobs.push(job);
        deliveryDelaySeconds = options?.delaySeconds;
      },
    },
  };

  await Promise.all(
    Array.from({ length: 2 }, async () => {
      const waits: Promise<unknown>[] = [];
      const response = await worker.fetch(new Request("https://release.bar/api/owner"), env, {
        waitUntil: (promise) => waits.push(promise),
      });
      expect(response.status).toBe(200);
      await Promise.all(waits);
    }),
  );

  expect(sentJobs.length).toBe(1);
  expect(sentJobs[0]?.reason).toBe("partial-cache");
  expect(sentJobs[0]?.target).toBe(undefined);
  expect(sentJobs[0]?.targetSnapshotKey ?? "").toMatch(/^refresh:jobs:v2:/);
  expect(deliveryDelaySeconds).toBe(2);
  expect(targetReads).toBe(2);
  const indexedJobs = await cache.list({ prefix: "refresh:jobs:v2:" });
  expect(indexedJobs.keys.length).toBe(1);
  const snapshot = JSON.parse(
    (await cache.get(sentJobs[0]?.targetSnapshotKey ?? "")) ?? "{}",
  ) as RefreshJob;
  expect(snapshot.target?.key).toBe(key);
  expect((await cache.list({ prefix: "refresh:job:v1:" })).keys.length).toBe(0);
});
