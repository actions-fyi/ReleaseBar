import { runInDurableObject } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { assert, expect, test, vi } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshTarget } from "../src/types.ts";
import type { StoredWebhookPending } from "../worker/runtime.ts";
import { webhookProcessorObjectName } from "../worker/runtime.ts";
import {
  kvStore,
  objectsUnavailable,
  observedDatabase,
  storeRefreshTarget,
  testDashboard,
  type TestEnv,
  testEnv,
  testProject,
  WebhookAdmission,
  WebhookProcessor,
  worker,
} from "./dashboard-test-harness.ts";

test("push webhooks bypass terminal target backoff before invalidating caches", async () => {
  const owner = "backedoff";
  const now = new Date().toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
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
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 11,
    terminalBackoffUntil: "2999-01-01T00:00:00Z",
  };
  const cache = kvStore({
    [key]: JSON.stringify(testDashboard(owner, [testProject({ owner, name: "repo" })])),
    "hot:v3": JSON.stringify(
      testDashboard("hot", [testProject({ owner, name: "repo", commitsSinceRelease: 5 })]),
    ),
  });
  await storeRefreshTarget(target);
  const queued: unknown[] = [];
  const queuedDelays: Array<number | undefined> = [];
  const dashboardCacheAtEnqueue: Array<string | null> = [];
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        queuedDelays.push(options?.delaySeconds);
        if (
          message &&
          typeof message === "object" &&
          (message as { kind?: unknown }).kind === "dashboard"
        ) {
          dashboardCacheAtEnqueue.push(await cache.get(key));
        }
      },
    },
  };

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-backedoff-push",
            event: "push",
            delivery: "delivery-backedoff-push",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: `${owner}/repo`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
          },
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  expect(await cache.get(key)).toBe(null);
  const invalidatedHot = JSON.parse((await cache.get("hot:v3")) ?? "{}") as DashboardPayload;
  expect(invalidatedHot.cache?.state).toBe("fresh");
  assert.ok(Date.parse((await cache.get("hot:v3:invalidated-at")) ?? "") > 0);
  expect(dashboardCacheAtEnqueue).toStrictEqual([null]);
  expect(
    queued.some(
      (message) =>
        Boolean(message) &&
        typeof message === "object" &&
        (message as { kind?: unknown; targetKey?: unknown }).kind === "dashboard" &&
        (message as { targetKey?: unknown }).targetKey === key,
    ),
  ).toBe(true);

  const activeJob = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown }).kind === "dashboard",
  ) as { id?: string } | undefined;
  expect(typeof activeJob?.id).toBe("string");
  assert.ok(activeJob);
  queued.length = 0;
  await cache.put(
    key,
    JSON.stringify(testDashboard(owner, [testProject({ owner, name: "repo" })])),
  );
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-reserved-push",
            event: "push",
            delivery: "delivery-reserved-push",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: `${owner}/repo`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
          },
          attempts: 1,
          ack: () => undefined,
          retry: () => undefined,
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  expect(await cache.get(key)).toBe(null);
  const requeued = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
      (message as { delivery?: unknown }).delivery === "delivery-reserved-push",
  );
  expect(requeued).toBe(undefined);
  const dirty = await testEnv(env).BUILD_COORDINATOR.getByName(key).releaseJob(activeJob.id, true);
  expect(dirty?.reason).toBe("webhook:push");
});

test("reserved webhook refreshes queue one follow-up after the active job", async () => {
  const owner = "reserved-fallback";
  const now = new Date().toISOString();
  const finalDeliveryStartedAt = new Date(Date.parse(now) + 60_000).toISOString();
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
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
    lastSeenAt: now,
    lastAttemptAt: now,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
  };
  const cache = kvStore({
    [key]: JSON.stringify(testDashboard(owner, [testProject({ owner, name: "sibling" })])),
  });
  await storeRefreshTarget(target);
  const queued: unknown[] = [];
  const delays: Array<number | undefined> = [];
  const env: TestEnv = {
    DASHBOARD_CACHE: cache,
    REFRESH_QUEUE: {
      send: async (message, options) => {
        queued.push(message);
        delays.push(options?.delaySeconds);
      },
    },
  };
  const coordinator = testEnv(env).BUILD_COORDINATOR.getByName(key);
  expect(await coordinator.reserveJob("existing-job")).toBe(true);

  let acknowledged = false;
  let retried = false;
  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-reserved-fallback",
            event: "repository",
            delivery: "delivery-reserved-fallback",
            payload: {
              action: "publicized",
              repository: {
                full_name: `${owner}/missing`,
                default_branch: "main",
                updated_at: now,
              },
            },
            createdAt: now,
            attempts: 0,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  const requeuedWebhook = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; delivery?: unknown }).kind === "github-webhook" &&
      (message as { delivery?: unknown }).delivery === "delivery-reserved-fallback",
  );
  expect(requeuedWebhook).toBe(undefined);
  expect(acknowledged).toBe(true);
  expect(retried).toBe(false);

  let activeAcknowledged = false;
  await worker.queue(
    {
      messages: [
        {
          body: {
            id: "existing-job",
            targetKey: key,
            target,
            kind: "dashboard",
            status: "succeeded",
            reason: "existing refresh",
            createdAt: "2026-06-11T00:00:00Z",
            updatedAt: now,
            startedAt: finalDeliveryStartedAt,
            finishedAt: now,
            attempts: 1,
            durationMs: 1,
          },
          attempts: 1,
          ack() {
            activeAcknowledged = true;
          },
          retry() {
            throw new Error("completed active job should not retry");
          },
        } as never,
      ],
    },
    env,
    { waitUntil: () => undefined },
  );

  expect(activeAcknowledged).toBe(true);
  const followup = queued.find(
    (message) =>
      Boolean(message) &&
      typeof message === "object" &&
      (message as { kind?: unknown; reason?: unknown }).kind === "dashboard" &&
      String((message as { reason?: unknown }).reason).includes("repository-publicized:follow-up"),
  ) as { targetKey?: string } | undefined;
  expect(followup?.targetKey).toBe(key);
  expect(delays.at(-1)).toBe(0);
  expect(await cache.get(key)).toBe(null);
});

test("worker acknowledges webhook jobs after the durable requeue limit", async () => {
  let acknowledged = false;
  let retried = false;
  vi.spyOn(WebhookProcessor.prototype, "process").mockRejectedValue(
    new Error("webhook processing failed"),
  );
  const admissionAbandons = vi.spyOn(WebhookAdmission.prototype, "abandon");
  const processorAbandons = vi.spyOn(WebhookProcessor.prototype, "abandon");

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: unknown;
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
          body: {
            kind: "github-webhook",
            id: "job-terminal",
            event: "issues",
            delivery: "delivery-terminal",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        },
      ],
    },
    {},
    { waitUntil: () => undefined },
  );

  expect(admissionAbandons).toHaveBeenCalledWith("delivery-terminal");
  expect(processorAbandons).toHaveBeenCalledWith("delivery-terminal");
  expect(acknowledged).toBe(true);
  expect(retried).toBe(false);
});

test("processed webhook retries take over followers behind a stale matching lease", async () => {
  const now = new Date().toISOString();
  const follower: StoredWebhookPending = {
    key: "delivery:delivery-follower",
    revision: "follower-revision",
    job: {
      kind: "github-webhook",
      id: "job-follower",
      event: "status",
      delivery: "delivery-follower",
      payload: {
        repository: {
          full_name: "owner/repo",
          default_branch: "main",
        },
      },
      createdAt: now,
      attempts: 0,
    },
    deliveries: ["delivery-follower"],
  };
  const objectName = webhookProcessorObjectName("owner");
  const processor = testEnv({ DASHBOARD_CACHE: kvStore() }).WEBHOOK_PROCESSOR.getByName(objectName);
  // The same object, as the runtime's own stub: only that one opens its storage to a test.
  const storage = runtimeEnv.WEBHOOK_PROCESSOR.getByName(objectName);
  // The leader's delivery is processed, but its earlier attempt still holds the lease, and a
  // follower is pending behind it.
  await runInDurableObject(storage, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT INTO processed_deliveries (id, processed_at) VALUES (?, ?)",
      "delivery-leader",
      Date.now(),
    );
    sql.exec(
      `INSERT INTO active_processing (id, job_id, lease_id, delivery, expires_at)
       VALUES (1, ?, ?, ?, ?)`,
      "job-leader",
      "stale-lease",
      "delivery-leader",
      Date.now() + 60_000,
    );
    sql.exec(
      "INSERT INTO pending_webhooks (position, value) VALUES (0, ?)",
      JSON.stringify(follower),
    );
  });

  const result = await processor.process({
    kind: "github-webhook",
    id: "job-leader",
    event: "issues",
    delivery: "delivery-leader",
    payload: {
      action: "opened",
      repository: {
        full_name: "owner/repo",
        default_branch: "main",
      },
    },
    createdAt: now,
    attempts: 1,
  });

  expect(result).toStrictEqual({ state: "processed", coalesced: 1, remaining: false });
  const stored = await runInDurableObject(storage, (_instance, state) => {
    const sql = state.storage.sql;
    return {
      pending: sql.exec("SELECT value FROM pending_webhooks").toArray(),
      active: sql.exec("SELECT lease_id FROM active_processing").toArray(),
      processed: sql
        .exec<{ id: string }>("SELECT id FROM processed_deliveries ORDER BY sequence")
        .toArray()
        .map((row) => row.id),
    };
  });
  expect(stored.pending).toStrictEqual([]);
  expect(stored.active).toStrictEqual([]);
  expect(stored.processed).toStrictEqual(["delivery-leader", "delivery-follower"]);
});

test("worker retries terminal webhook jobs when durable abandonment fails", async () => {
  let acknowledged = false;
  let retryDelaySeconds: number | undefined;
  objectsUnavailable(WebhookAdmission, WebhookProcessor);

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook",
            id: "job-terminal-abandon-failed",
            event: "issues",
            delivery: "delivery-terminal-abandon-failed",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry(options?: { delaySeconds?: number }) {
            retryDelaySeconds = options?.delaySeconds;
          },
        } as never,
      ],
    },
    {},
    { waitUntil: () => undefined },
  );

  expect(acknowledged).toBe(false);
  expect(retryDelaySeconds).toBe(20);
});

test("worker quickly requeues busy webhook jobs without consuming their failure budget", async () => {
  let acknowledged = false;
  let queuedDelaySeconds: number | undefined;
  let queuedJob: { attempts?: number; delivery?: string } | undefined;
  vi.spyOn(WebhookProcessor.prototype, "process").mockResolvedValue({ state: "busy" });

  await (
    worker as unknown as {
      queue(
        batch: {
          messages: Array<{
            body: unknown;
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
          body: {
            kind: "github-webhook",
            id: "job-busy",
            event: "issues",
            delivery: "delivery-busy",
            payload: {
              action: "opened",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            attempts: 48,
          },
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            throw new Error("durably requeued webhook should not retry the original message");
          },
        },
      ],
    },
    {
      REFRESH_QUEUE: {
        async send(
          job: { attempts?: number; delivery?: string },
          options?: { delaySeconds?: number },
        ) {
          queuedJob = job;
          queuedDelaySeconds = options?.delaySeconds;
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(acknowledged).toBe(true);
  expect(queuedJob?.delivery).toBe("delivery-busy");
  expect(queuedJob?.attempts).toBe(48);
  expect(queuedDelaySeconds).toBe(20);
});

test("terminal webhook fanout clears admission and processing deduplication", async () => {
  let acknowledged = false;
  let retried = false;
  const admissionAbandons = vi.spyOn(WebhookAdmission.prototype, "abandon");
  const processorAbandons = vi.spyOn(WebhookProcessor.prototype, "abandon");
  const objectName = (object: unknown) => (object as { ctx: DurableObjectState }).ctx.id.name;
  const cache = kvStore();

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-terminal",
            event: "push",
            delivery: "delivery-fanout-terminal",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:push",
              includeReleaseDataOnly: true,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 11,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    {
      DASHBOARD_CACHE: cache,
      // The fanout fails when it sends the job for its next page.
      REFRESH_QUEUE: {
        async send() {
          throw new Error("queue send failed");
        },
      },
    },
    { waitUntil: () => undefined },
  );

  expect(admissionAbandons.mock.contexts.map(objectName)).toStrictEqual([
    "github-webhook-admission",
  ]);
  expect(processorAbandons.mock.contexts.map(objectName)).toStrictEqual([
    "github-webhook-process:owner",
  ]);
  expect(acknowledged).toBe(true);
  expect(retried).toBe(false);
});

test("terminal webhook fanout retries when durable abandonment fails", async () => {
  let acknowledged = false;
  let retried = false;
  objectsUnavailable();
  const cache = kvStore();
  // The page of the target index can't be read.
  const { database } = observedDatabase((sql) => sql.includes("FROM refresh_target_sources"));

  await worker.queue(
    {
      messages: [
        {
          body: {
            kind: "github-webhook-fanout",
            id: "fanout-terminal-abandon-failed",
            event: "push",
            delivery: "delivery-fanout-terminal-abandon-failed",
            payload: {
              ref: "refs/heads/main",
              repository: {
                full_name: "owner/repo",
                default_branch: "main",
              },
            },
            createdAt: new Date().toISOString(),
            action: {
              reason: "webhook:push",
              includeReleaseDataOnly: true,
              invalidateDashboard: true,
            },
            source: "owner",
          },
          attempts: 11,
          ack() {
            acknowledged = true;
          },
          retry() {
            retried = true;
          },
        } as never,
      ],
    },
    {
      DASHBOARD_CACHE: cache,
      DB: database,
    },
    { waitUntil: () => undefined },
  );

  expect(acknowledged).toBe(false);
  expect(retried).toBe(true);
});
