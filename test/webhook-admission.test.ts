import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshJob, RefreshTarget } from "../src/types.ts";
import { durableRefreshTargetIndexLimit, refreshTargetSourceLimit } from "../worker/config.ts";
import {
  fillTargetIndex,
  kvStore,
  targetIndex,
  testDashboard,
  type TestEnv,
  testEnv,
  testProject,
  webhookSignature,
  worker,
} from "./dashboard-test-harness.ts";

test("GitHub push webhooks prioritize recent targets beyond the durable hot-cache limit", async () => {
  type QueuedWebhook = {
    kind: "github-webhook";
    id: string;
    event: string;
    delivery: string;
    payload: Record<string, unknown>;
    createdAt: string;
    attempts?: number;
  };
  type QueuedFanout = {
    kind: "github-webhook-fanout";
    id: string;
    event: string;
    delivery: string;
    payload: Record<string, unknown>;
    createdAt: string;
    action: {
      reason: string;
      includeReleaseDataOnly: boolean;
      invalidateDashboard: boolean;
      recentTargetsOnly?: boolean;
      prioritizedTargetKeys?: string[];
    };
    source: "indexed" | "owner" | "repo" | "kv-owner" | "kv-repo" | "legacy";
    priorityBatchStartedAt?: string;
    cursor?: string;
  };
  const secret = "fanout-webhook-secret";
  const owner = "fanout";
  const now = new Date().toISOString();
  const fallbackTargetIndex = 0;
  const staleTargetIndex = 204;
  const firstReleaseTargetIndex = 26;
  const movedTargetIndex = 201;
  const newestTargetIndex = 202;
  const durableOnlyTargetIndex = 203;
  const metadataOnlyTargetIndexes = new Set(Array.from({ length: 25 }, (_, index) => index + 1));
  const project = testProject({ owner, name: "repo" });
  const degradedRepoTarget = {
    key: "dashboard:v6:custom:noforks-noarchived-unreleased-release:sources-degraded",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: [`${owner}/repo`],
    includeReleaseData: true,
    path: `/?repos=${owner}/repo`,
    priority: 60,
    lastSeenAt: new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  } satisfies RefreshTarget;
  const targets = Array.from({ length: 205 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    const key = `dashboard:v6:${owner}:noforks-noarchived-unreleased-release:sources-${suffix}`;
    return {
      key,
      kind: "dashboard",
      owner,
      owners: [owner],
      repos: [],
      includeReleaseData: !metadataOnlyTargetIndexes.has(index),
      path: `/${owner}?variant=${suffix}`,
      priority: 60,
      lastSeenAt:
        index === staleTargetIndex
          ? new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString()
          : index === fallbackTargetIndex
            ? new Date(Date.parse(now) - 23 * 60 * 60 * 1_000).toISOString()
            : metadataOnlyTargetIndexes.has(index)
              ? new Date(Date.parse(now) + 3_000).toISOString()
              : index === newestTargetIndex
                ? new Date(Date.parse(now) + 2_000).toISOString()
                : now,
      lastAttemptAt: null,
      lastSuccessAt: now,
      nextDueAt: "2999-01-01T00:00:00Z",
      failureCount: 0,
      indexVersion: 2,
    } satisfies RefreshTarget;
  });
  const cache = kvStore({
    "refresh:target-index:v1:ready": "2",
    ...Object.fromEntries(
      targets.flatMap((target, index) => [
        [`refresh:target:v1:${target.key}`, JSON.stringify(target)],
        [
          `refresh:target-index:v1:owner:${owner}:${String(index).padStart(3, "0")}`,
          JSON.stringify(target.key),
        ],
        [target.key, JSON.stringify(testDashboard(owner, [project]))],
      ]),
    ),
    [`refresh:target:v1:${degradedRepoTarget.key}`]: JSON.stringify(degradedRepoTarget),
    [degradedRepoTarget.key]: JSON.stringify(testDashboard("custom", [project])),
  });
  await cache.put(
    `refresh:target-index:v1:repo:${encodeURIComponent(`${owner}/repo`)}:duplicate`,
    JSON.stringify(targets[0].key),
  );
  await cache.put(
    `refresh:target-index:v1:repo:${encodeURIComponent(`${owner}/repo`)}:degraded`,
    JSON.stringify(degradedRepoTarget.key),
  );
  const queued: Array<RefreshJob | QueuedWebhook | QueuedFanout> = [];
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    REFRESH_QUEUE: {
      send: async (message) => {
        queued.push(message);
      },
    },
  };
  const durableOwnerIndex = targetIndex(env, "owner", owner);
  for (const [index, target] of targets.entries()) {
    const indexedTarget =
      index === fallbackTargetIndex
        ? {
            ...target,
            lastSeenAt: new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString(),
          }
        : target;
    expect(await durableOwnerIndex.upsert(indexedTarget)).toBe("created");
  }
  await cache.delete(`refresh:target:v1:${targets[durableOnlyTargetIndex].key}`);
  const durableRepoIndex = targetIndex(env, "repo", `${owner}/repo`);
  const staleRepoDuplicate = {
    ...targets[newestTargetIndex],
    lastSeenAt: new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000).toISOString(),
  };
  expect(await durableRepoIndex.upsert(staleRepoDuplicate)).toBe("created");
  const payload = {
    ref: "refs/heads/main",
    after: "abcdef1234567890",
    repository: {
      full_name: `${owner}/repo`,
      archived: false,
      default_branch: "main",
      pushed_at: now,
      updated_at: now,
    },
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": "delivery-fanout",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(202);
  const webhookJob = queued.find(
    (message): message is QueuedWebhook => message.kind === "github-webhook",
  );
  assert.ok(webhookJob);
  let acknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: webhookJob,
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
  const initialDashboardJobs = queued.filter(
    (message): message is RefreshJob => message.kind === "dashboard",
  );
  const firstFanout = queued.find(
    (message): message is QueuedFanout => message.kind === "github-webhook-fanout",
  );
  assert.ok(firstFanout);
  expect(initialDashboardJobs.length).toBe(25);
  expect(firstFanout.action.prioritizedTargetKeys?.length).toBe(25);
  expect(typeof firstFanout.priorityBatchStartedAt).toBe("string");
  firstFanout.createdAt = new Date(Date.now() - 3 * 60 * 1_000).toISOString();
  await cache.put(
    "github:budget:v1:shared:_",
    JSON.stringify({
      active: true,
      resource: "graphql",
      remaining: 0,
      limit: 5_000,
      resetAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      reason: "test cooldown",
    }),
  );
  let fanoutAcknowledged = false;
  let fanoutRetryDelaySeconds: number | undefined;
  await worker.queue(
    {
      messages: [
        {
          body: firstFanout,
          attempts: 1,
          ack: () => {
            fanoutAcknowledged = true;
          },
          retry: (options) => {
            fanoutRetryDelaySeconds = options?.delaySeconds;
          },
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );
  expect(fanoutAcknowledged).toBe(false);
  expect(fanoutRetryDelaySeconds).toBe(20);
  await cache.delete("github:budget:v1:shared:_");
  for (const job of initialDashboardJobs) {
    await testEnv(env).BUILD_COORDINATOR.getByName(job.targetKey).releaseJob(job.id, false);
  }
  const movedTarget = targets[movedTargetIndex];
  const newestTarget = targets[newestTargetIndex];
  const staleTarget = targets[staleTargetIndex];
  const fallbackTarget = targets[fallbackTargetIndex];
  const durableOnlyTarget = targets[durableOnlyTargetIndex];
  const firstReleaseTarget = targets[firstReleaseTargetIndex];
  const secondTarget = targets[1];
  const lastTarget = targets.at(-1);
  assert.ok(movedTarget);
  assert.ok(newestTarget);
  assert.ok(staleTarget);
  assert.ok(fallbackTarget);
  assert.ok(durableOnlyTarget);
  assert.ok(firstReleaseTarget);
  assert.ok(secondTarget);
  assert.ok(lastTarget);
  const moved = await durableOwnerIndex.upsert({
    ...movedTarget,
    lastSeenAt: new Date(Date.parse(now) + 4_000).toISOString(),
  });
  expect(moved).toBe("updated");
  const rebuiltPrioritizedCache = JSON.stringify(testDashboard(owner, [project]));
  await cache.put(newestTarget.key, rebuiltPrioritizedCache);
  const pageSizes = [
    queued.filter((message): message is RefreshJob => message.kind === "dashboard").length,
  ];
  while (true) {
    const fanoutIndex = queued.findIndex(
      (message): message is QueuedFanout => message.kind === "github-webhook-fanout",
    );
    if (fanoutIndex < 0) break;
    const [fanout] = queued.splice(fanoutIndex, 1);
    assert.ok(fanout);
    const before = queued.filter(
      (message): message is RefreshJob => message.kind === "dashboard",
    ).length;
    await worker.queue(
      {
        messages: [
          {
            body: fanout,
            attempts: 1,
            ack: () => undefined,
            retry: () => undefined,
          },
        ],
      },
      env,
      { waitUntil: () => undefined },
    );
    const after = queued.filter(
      (message): message is RefreshJob => message.kind === "dashboard",
    ).length;
    pageSizes.push(after - before);
  }

  const dashboardJobs = queued.filter(
    (message): message is RefreshJob => message.kind === "dashboard",
  );
  expect(acknowledged).toBe(true);
  expect(pageSizes.length >= 2).toBe(true);
  expect(Math.max(...pageSizes) <= 200).toBe(true);
  expect(new Set(dashboardJobs.map((job) => job.targetKey)).size).toBe(
    targets.length - metadataOnlyTargetIndexes.size,
  );
  expect(dashboardJobs.some((job) => job.targetKey === staleTarget.key)).toBe(false);
  expect(dashboardJobs.some((job) => job.targetKey === fallbackTarget.key)).toBe(true);
  expect(dashboardJobs.some((job) => job.targetKey === movedTarget.key)).toBe(true);
  expect(dashboardJobs.some((job) => job.targetKey === durableOnlyTarget.key)).toBe(true);
  expect(dashboardJobs.some((job) => job.targetKey === degradedRepoTarget.key)).toBe(true);
  expect(dashboardJobs[0]?.targetKey).toBe(newestTarget.key);
  const firstJob = dashboardJobs.find((job) => job.targetKey === firstReleaseTarget.key);
  assert.ok(firstJob);
  // No webhook marked the target dirty while its job ran.
  const dirty = await testEnv(env)
    .BUILD_COORDINATOR.getByName(firstReleaseTarget.key)
    .releaseJob(firstJob.id, true);
  expect(dirty).toBe(null);
  expect(await cache.get(staleTarget.key)).toBe(null);
  expect(await cache.get(secondTarget.key)).not.toBe(null);
  expect(await cache.get(firstReleaseTarget.key)).toBe(null);
  expect(await cache.get(newestTarget.key)).toBe(rebuiltPrioritizedCache);
  expect(await cache.get(lastTarget.key)).toBe(null);
  expect(await cache.get(degradedRepoTarget.key)).toBe(null);
});

test("durable target indexes cap persistent variants per source", async () => {
  const now = new Date().toISOString();
  const cache = kvStore();
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
  };
  const index = targetIndex(env, "owner", "owner");
  const variant = (name: string): RefreshTarget => ({
    key: `dashboard:v6:owner:variant-${name}`,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: `/owner?variant=${name}`,
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: now,
    failureCount: 0,
  });
  for (let count = 0; count < refreshTargetSourceLimit; count += 1) {
    expect(await index.upsert(variant(String(count)))).toBe("created");
  }
  expect(await index.upsert(variant("overflow"))).toBe("full");
  // A target the index holds already is still updated, and removing one makes room.
  expect(await index.upsert(variant("0"))).toBe("updated");
  await index.remove(variant("1").key);
  expect(await index.upsert(variant("overflow"))).toBe("created");
  expect((await index.list()).length).toBe(durableRefreshTargetIndexLimit);
});

test("durable target indexes reject oversized entries and serialized source state", async () => {
  const now = new Date().toISOString();
  const cache = kvStore();
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
  };
  const index = targetIndex(env, "owner", "owner");
  const target = (index: number, padding: number): RefreshTarget => ({
    key: `dashboard:v6:owner:large-${index}`,
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: [],
    includeReleaseData: true,
    path: `/owner?padding=${"x".repeat(padding)}&variant=${index}`,
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: now,
    failureCount: 0,
  });
  expect(await index.upsert(target(0, 9 * 1024))).toBe("too-large");

  let accepted = 0;
  let rejected = 0;
  for (let count = 1; count <= 512; count += 1) {
    const result = await index.upsert(target(count, 4 * 1024));
    if (result === "created") accepted += 1;
    if (result === "full") {
      rejected = count;
      break;
    }
  }
  expect(accepted > 0).toBe(true);
  expect(rejected > 0 && rejected < 512).toBe(true);
});

test("repo-only refresh targets do not consume a shared custom-owner index", async () => {
  const now = new Date().toISOString();
  const target: RefreshTarget = {
    key: "dashboard:v6:repo-only-index",
    kind: "dashboard",
    owner: "custom",
    owners: [],
    repos: ["owner/repo"],
    includeReleaseData: true,
    path: "/?repos=owner/repo",
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [target.key]: JSON.stringify(
      testDashboard("custom", [testProject({ owner: "owner", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
  };
  const waits: Promise<unknown>[] = [];

  await worker.scheduled({ cron: "0 * * * *" } as never, env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  expect(await targetIndex(env, "owner", "custom").list()).toStrictEqual([]);
  expect((await targetIndex(env, "repo", "owner/repo").list())[0]?.key).toBe(target.key);
});

test("multi-source target admission rolls back newly-created durable indexes", async () => {
  const now = new Date().toISOString();
  const target: RefreshTarget = {
    key: "dashboard:v6:atomic-index",
    kind: "dashboard",
    owner: "owner",
    owners: ["owner"],
    repos: ["other/repo"],
    includeReleaseData: true,
    path: "/owner?repos=other/repo",
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [target.key]: JSON.stringify(
      testDashboard("owner", [testProject({ owner: "other", name: "repo" })]),
    ),
    [`refresh:target:v1:${target.key}`]: JSON.stringify(target),
  });
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
  };
  // The repository's index is full; the owner's has room.
  await fillTargetIndex(env, "repo", "other/repo");
  const waits: Promise<unknown>[] = [];

  await worker.scheduled({ cron: "0 * * * *" } as never, env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  expect(await targetIndex(env, "owner", "owner").list()).toStrictEqual([]);
  expect(await cache.get(`refresh:target:v1:${target.key}`)).toBe(null);
});

test("rejected target admission does not persist or queue the target", async () => {
  const owner = "capped";
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const generatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cached = {
    ...testDashboard(owner, [testProject({ owner, name: "repo" })]),
    generatedAt,
    cache: {
      state: "stale",
      stale: true,
      capped: false,
      repoLimit: 200,
      generatedAt,
      countsUpdatedAt: generatedAt,
      projectCountsUpdatedAt: { [`${owner}/repo`]: generatedAt },
      releasesUpdatedAt: generatedAt,
      ciUpdatedAt: generatedAt,
    },
  } satisfies DashboardPayload;
  const cache = kvStore({
    [key]: JSON.stringify(cached),
    [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
  });
  const queued: unknown[] = [];
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      async send(message) {
        queued.push(message);
      },
    },
  };
  await fillTargetIndex(env, "owner", owner);
  const waits: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(`https://release.bar/api/${owner}`), env, {
    waitUntil: (promise) => waits.push(promise),
  });
  await Promise.all(waits);

  expect(response.status).toBe(200);
  expect(queued.length).toBe(0);
  expect(await cache.get(`refresh:target:v1:${key}`)).toBe(null);
});

test("archive webhooks invalidate caches when owner snapshots omit the repository", async () => {
  const secret = "archive-no-snapshot-secret";
  const owner = "coldowner";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const dashboard = testDashboard(owner, [testProject({ owner, name: "repo" })]);
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
  const cache = kvStore({
    [key]: JSON.stringify(dashboard),
    [`refresh:target:v1:${key}`]: JSON.stringify(target),
    [`repo-detail:aux:v2:${encodeURIComponent(`${owner}/repo`)}:repository:${encodeURIComponent(`/repos/${owner}/repo`)}`]:
      JSON.stringify({ generatedAt: now, data: { name: "repo" } }),
    [`owner-metadata:v1:${owner}`]: JSON.stringify({
      owner,
      generatedAt: now,
      metadataUpdatedAt: now,
      countsUpdatedAt: now,
      releaseDataComplete: true,
      projects: [testProject({ owner, name: "sibling" })],
    }),
  });
  const queued: unknown[] = [];
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_TOKEN: "shared-token",
    REFRESH_QUEUE: {
      send: async (message) => {
        queued.push(message);
      },
    },
  };
  const payload = {
    action: "archived",
    repository: {
      full_name: `${owner}/repo`,
      archived: true,
      default_branch: "main",
      updated_at: now,
    },
  };
  const body = JSON.stringify(payload);
  const response = await worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "repository",
        "x-github-delivery": "delivery-archive-no-snapshot",
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
      body,
    }),
    env,
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(202);
  const webhookJob = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown }).kind === "github-webhook",
  );
  assert.ok(webhookJob);
  await worker.queue(
    {
      messages: [
        {
          body: webhookJob as never,
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        },
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  expect(await cache.get(key)).toBe(null);
  expect(
    await cache.get(
      `repo-detail:aux:v2:${encodeURIComponent(`${owner}/repo`)}:repository:${encodeURIComponent(`/repos/${owner}/repo`)}`,
    ),
  ).toBe(null);
});
