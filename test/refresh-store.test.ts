// The refresh data in D1: what KV did by itself and D1 does not (expiry), the pages of the
// listings, and how many statements a scheduler tick sends.
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { DashboardProfile, RefreshJob, RefreshTarget } from "../src/types.ts";
import {
  dashboardStorageTtlSeconds,
  refreshExpiryBatchLimit,
  schedulerBatchLimit,
} from "../worker/config.ts";
import { deleteExpiredRefreshData } from "../worker/refresh-targets.ts";
import { refreshJobBatchRows } from "../worker/store/refresh-jobs.ts";
import {
  deleteExpiredRefreshTargets,
  indexedRefreshTargetPage,
  listStoredRefreshTargets,
} from "../worker/store/refresh-targets.ts";
import {
  indexedTargets,
  kvStore,
  observedDatabase,
  refreshAuditEvents,
  storedProfileSnapshot,
  storedRefreshJob,
  storedRefreshJobDeliveries,
  storedRefreshJobs,
  storedRefreshJobSnapshot,
  storedRefreshTarget,
  storedSchedulerState,
  storeProfileSnapshot,
  storeRefreshJob,
  storeRefreshJobSnapshot,
  storeRefreshTarget,
  storeRefreshTargets,
  testDashboard,
  worker,
} from "./dashboard-test-harness.ts";

const day = 24 * 60 * 60 * 1000;

function target(owner: string, overrides: Partial<RefreshTarget> = {}): RefreshTarget {
  const now = new Date().toISOString();
  return {
    key: `dashboard:v6:${owner}`,
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: false,
    path: `/${owner}`,
    priority: 60,
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    ...overrides,
  };
}

function job(id: string, at: number, overrides: Partial<RefreshJob> = {}): RefreshJob {
  return {
    id,
    targetKey: "dashboard:v6:owner",
    kind: "dashboard",
    status: "succeeded",
    reason: "scheduled",
    createdAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 1,
    durationMs: null,
    ...overrides,
  };
}

async function tick(testEnv: Parameters<typeof worker.scheduled>[1]): Promise<void> {
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() }, testEnv, {
    waitUntil: (promise) => void waits.push(promise),
  });
  await Promise.all(waits);
}

test("a scheduler tick deletes the refresh data that is past its lifetime", async () => {
  const storageLifetime = dashboardStorageTtlSeconds * 1000;
  const seen = (age: number) => new Date(Date.now() - age).toISOString();
  await storeRefreshTargets([
    target("fresh"),
    target("unseen", { lastSeenAt: seen(storageLifetime + day), repos: ["unseen/repo"] }),
  ]);
  await storeRefreshJob(job("job-recent", Date.now() - day));
  await storeRefreshJob(job("job-old", Date.now() - 15 * day));
  await storeRefreshJobSnapshot(job("job-old-snapshot", Date.now() - 15 * day));
  // A delivery record of each age.
  for (const [id, age] of [
    ["job-recent", day],
    ["job-old", 15 * day],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO refresh_job_deliveries (job_id, attempt, updated_at, value) VALUES (?, 1, ?, ?)",
    )
      .bind(id, Date.now() - age, JSON.stringify(job(id, Date.now() - age)))
      .run();
  }
  const profile = (owner: string): DashboardProfile => ({
    owner,
    includeOwners: [],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: [],
    updatedAt: "2026-06-11T07:00:00Z",
    updatedBy: owner,
  });
  const recentSnapshot = await storeProfileSnapshot(profile("recent"));
  const oldSnapshot = await storeProfileSnapshot(profile("old"));
  await env.DB.prepare("UPDATE profile_snapshots SET created_at = ? WHERE key = ?")
    .bind(Date.now() - storageLifetime - day, oldSnapshot)
    .run();

  await tick({
    DASHBOARD_CACHE: kvStore({
      "dashboard:v6:fresh": JSON.stringify(testDashboard("fresh", [])),
    }),
  });

  expect((await storedRefreshTarget("dashboard:v6:fresh"))?.owner).toBe("fresh");
  expect(await storedRefreshTarget("dashboard:v6:unseen")).toBe(null);
  expect((await indexedTargets("owner", "fresh")).length).toBe(1);
  const sources = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM refresh_target_sources WHERE target_key = ?",
  )
    .bind("dashboard:v6:unseen")
    .first<{ total: number }>();
  expect(sources?.total).toBe(0);
  expect((await storedRefreshJob("job-recent"))?.id).toBe("job-recent");
  expect(await storedRefreshJob("job-old")).toBe(null);
  expect(await storedRefreshJobSnapshot("refresh-job:job-old-snapshot")).toBe(null);
  const jobs = (await storedRefreshJobs()).map((stored) => stored.id);
  expect(jobs.includes("job-recent")).toBe(true);
  expect(jobs.includes("job-old")).toBe(false);
  expect(jobs.includes("job-old-snapshot")).toBe(false);
  expect((await storedRefreshJobDeliveries()).map((stored) => stored.id)).toStrictEqual([
    "job-recent",
  ]);
  expect((await storedProfileSnapshot(recentSnapshot))?.owner).toBe("recent");
  expect(await storedProfileSnapshot(oldSnapshot)).toBe(null);
});

test("expired refresh targets are deleted a bounded number at a time, the longest unseen first", async () => {
  const lifetime = dashboardStorageTtlSeconds * 1000;
  await storeRefreshTargets(
    Array.from({ length: 5 }, (_, index) =>
      target(`unseen-${index}`, {
        lastSeenAt: new Date(Date.now() - lifetime - (index + 1) * day).toISOString(),
      }),
    ),
  );

  expect(await deleteExpiredRefreshTargets(env, 2)).toBe(2);

  expect(await storedRefreshTarget("dashboard:v6:unseen-4")).toBe(null);
  expect(await storedRefreshTarget("dashboard:v6:unseen-3")).toBe(null);
  expect((await storedRefreshTarget("dashboard:v6:unseen-2"))?.owner).toBe("unseen-2");
  expect((await indexedTargets("owner", "unseen-4")).length).toBe(0);
  // A target that is past its lifetime and not deleted yet is not handed to a webhook.
  expect((await indexedTargets("owner", "unseen-2")).length).toBe(0);
  expect(
    (await indexedRefreshTargetPage(env, { kind: "owner", value: "unseen-2" })).targets,
  ).toStrictEqual([]);
  await deleteExpiredRefreshData(env);
  expect(await storedRefreshTarget("dashboard:v6:unseen-0")).toBe(null);
  expect(refreshExpiryBatchLimit >= 3).toBe(true);
});

test("the target listings page by key", async () => {
  const targets = Array.from({ length: 5 }, (_, index) =>
    target(`paged-${index}`, { owners: ["shared-owner"] }),
  );
  await storeRefreshTargets([...targets, target("other", { key: "dashboard:v5:obsolete" })]);

  const first = await listStoredRefreshTargets(env, 2);
  expect(first.targets.map((stored) => stored.owner)).toStrictEqual(["paged-0", "paged-1"]);
  expect(first.nextCursor).toBe("dashboard:v6:paged-1");
  const second = await listStoredRefreshTargets(env, 2, first.nextCursor);
  const last = await listStoredRefreshTargets(env, 2, second.nextCursor);
  // The last page has no cursor, and no page holds the target of an obsolete cache key version.
  expect(last.targets.map((stored) => stored.owner)).toStrictEqual(["paged-4"]);
  expect(last.nextCursor).toBe(undefined);

  const indexed = await indexedRefreshTargetPage(env, { kind: "owner", value: "shared-owner" });
  expect(indexed.targets.length).toBe(5);
  expect(indexed.nextCursor).toBe(undefined);
  expect(
    (await indexedRefreshTargetPage(env, { kind: "owner", value: "shared-owner" }, targets[3]?.key))
      .targets.length,
  ).toBe(1);
});

test("a target with more sources than one statement takes is stored and replaced whole", async () => {
  const repos = Array.from({ length: 70 }, (_, index) => `owner-${index}/repo`);
  const wide = target("wide", { repos });

  expect(await storeRefreshTarget(wide)).toBe("created");
  expect((await indexedTargets("repo", "owner-69/repo")).length).toBe(1);

  expect(await storeRefreshTarget({ ...wide, repos: repos.slice(0, 2) })).toBe("updated");
  expect((await indexedTargets("repo", "owner-69/repo")).length).toBe(0);
  expect((await indexedTargets("repo", "owner-1/repo")).length).toBe(1);
});

test("a scheduler tick sends D1 a bounded number of statements", async () => {
  const entries: Record<string, string> = {};
  const targets = Array.from({ length: 120 }, (_, index) => {
    const owner = `page-${String(index).padStart(3, "0")}`;
    entries[`dashboard:v6:${owner}`] = JSON.stringify(testDashboard(owner, []));
    return target(owner, {
      owners: [],
      nextDueAt: index < schedulerBatchLimit ? "2020-01-01T00:00:00Z" : "2999-01-01T00:00:00Z",
    });
  });
  await storeRefreshTargets(targets);
  const { database, counts } = observedDatabase();
  const sent: unknown[] = [];
  const testEnv = {
    DASHBOARD_CACHE: kvStore(entries),
    DB: database,
    REFRESH_QUEUE: { send: async (message: never) => void sent.push(message) },
  };
  const measured = async () => {
    counts.statements = 0;
    counts.batches = 0;
    counts.queries = 0;
    counts.sql.length = 0;
    await tick(testEnv);
    return { statements: counts.statements, batches: counts.batches, queries: counts.queries };
  };

  // A page of 120 targets, as many of them due as a tick enqueues. What D1 limits per invocation
  // is the queries, and a batch is one, whatever it holds.
  // - Reads, a query each: the last tick's state, the jobs, the delivery records, the page of
  //   targets, the owner count cursor.
  // - The enqueued jobs: one batch.
  // - The tick's state: one statement.
  // - The five deletions of expired refresh rows: two batches and a statement.
  // - The audit events, one per enqueued job and one for the tick: one batch.
  // - The deletions of expired audit rows, five rounds for each of four tables: three batches.
  const jobs = schedulerBatchLimit;
  expect(await measured()).toStrictEqual({
    statements: 5 + jobs + 1 + 5 + (jobs + 1) + 20,
    batches: 1 + 2 + 1 + 3,
    queries: 5 + 1 + 1 + 3 + 1 + 3,
  });
  expect(sent.length).toBe(jobs);
  expect((await storedSchedulerState())?.due).toBe(jobs);
  expect((await refreshAuditEvents()).filter((event) => event.event === "job_enqueue").length).toBe(
    jobs,
  );
  // The ceiling: well under the 50 queries the Workers free plan allows an invocation.
  expect(counts.queries <= 20).toBe(true);

  // The same page with the jobs active: nothing is enqueued.
  expect(await measured()).toStrictEqual({
    statements: 5 + 1 + 5 + 1 + 20,
    batches: 2 + 1 + 3,
    queries: 5 + 1 + 3 + 1 + 3,
  });
  expect(sent.length).toBe(jobs);
});

test("a tick stores a job the queue did not take as failed and enqueues the others", async () => {
  const entries: Record<string, string> = {};
  const owners = ["due-a", "due-b", "due-c"];
  await storeRefreshTargets(
    owners.map((owner) => {
      entries[`dashboard:v6:${owner}`] = JSON.stringify(testDashboard(owner, []));
      return target(owner, { owners: [], nextDueAt: "2020-01-01T00:00:00Z" });
    }),
  );
  const sent: RefreshJob[] = [];
  let queueDown = true;
  const testEnv = {
    DASHBOARD_CACHE: kvStore(entries),
    REFRESH_QUEUE: {
      send: async (message: RefreshJob) => {
        if (queueDown && message.targetKey === "dashboard:v6:due-b") {
          throw new Error("queue unavailable");
        }
        sent.push(message);
      },
    },
  };

  await expect(tick(testEnv)).rejects.toThrow("queue unavailable");

  expect(sent.map((message) => message.targetKey)).toStrictEqual([
    "dashboard:v6:due-a",
    "dashboard:v6:due-c",
  ]);
  const stored = await storedRefreshJobs();
  expect(stored.length).toBe(3);
  const failed = stored.filter((job) => job.status === "failed");
  expect(failed.map((job) => [job.targetKey, job.error])).toStrictEqual([
    ["dashboard:v6:due-b", "queue unavailable"],
  ]);
  expect(stored.filter((job) => job.status === "queued").length).toBe(2);

  // Its reservation is released: the next tick enqueues it, and only it.
  queueDown = false;
  await tick(testEnv);
  expect(sent.map((message) => message.targetKey).slice(2)).toStrictEqual(["dashboard:v6:due-b"]);
});

test("a webhook fan-out page stores its jobs in batches and audits them in one", async () => {
  const count = 60;
  await storeRefreshTargets(
    Array.from({ length: count }, (_, index) =>
      target(`fan-${String(index).padStart(2, "0")}`, { owners: ["fan-owner"] }),
    ),
  );
  const { database, counts } = observedDatabase();
  const sent: Array<{ kind: string }> = [];
  const waits: Promise<unknown>[] = [];
  let acknowledged = false;

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-1",
            event: "repository",
            delivery: "delivery-1",
            payload: { repository: { full_name: "fan-owner/repo" } },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:repository",
              includeReleaseDataOnly: false,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 1,
          ack: () => {
            acknowledged = true;
          },
          retry: () => undefined,
        },
      ],
    },
    {
      DASHBOARD_CACHE: kvStore(),
      DB: database,
      REFRESH_QUEUE: { send: async (message: never) => void sent.push(message) },
    },
    { waitUntil: (promise) => void waits.push(promise) },
  );
  await Promise.all(waits);

  expect(acknowledged).toBe(true);
  expect(sent.filter((message) => message.kind === "dashboard").length).toBe(count);
  expect((await refreshAuditEvents()).filter((event) => event.event === "job_enqueue").length).toBe(
    count,
  );
  // The page of targets, the jobs in batches of `refreshJobBatchRows`, the audit events.
  expect(counts.queries).toBe(1 + Math.ceil(count / refreshJobBatchRows) + 1);
});

test("a job whose snapshot is gone is retried, not run without its target", async () => {
  const queued = job("job-no-snapshot", Date.now(), {
    targetKey: "dashboard:v6:no-snapshot",
    status: "queued",
    attempts: 0,
    targetSnapshotKey: "refresh-job:job-no-snapshot",
  });
  let acknowledged = false;
  let retried = false;
  const { database, counts } = observedDatabase();
  const waits: Promise<unknown>[] = [];

  await worker.queue(
    {
      messages: [
        {
          body: queued,
          attempts: 1,
          ack: () => {
            acknowledged = true;
          },
          retry: () => {
            retried = true;
          },
        },
      ],
    },
    { DASHBOARD_CACHE: kvStore(), DB: database },
    { waitUntil: (promise) => void waits.push(promise) },
  );
  await Promise.all(waits);

  expect(acknowledged).toBe(false);
  expect(retried).toBe(true);
  // The job and its snapshot are read, its state is stored, and its audit events are one batch,
  // written once the handler is done.
  expect(counts.queries).toBe(2 + 1 + 1);
  expect(counts.sql.at(-1)?.startsWith("INSERT INTO refresh_audit_events")).toBe(true);
  expect((await refreshAuditEvents()).map((event) => event.event)).toStrictEqual(["job_retry"]);
  const stored = await storedRefreshJob(queued.id);
  expect(stored?.status).toBe("queued");
  expect(stored?.error).toBe("target snapshot unavailable");
  expect(stored?.attempts).toBe(1);
});
