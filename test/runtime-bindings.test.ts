// These tests use the bindings the Workers runtime provides from wrangler.jsonc, not the fakes of
// dashboard-test-harness.ts: the fetch handler, the Durable Objects, the KV namespace and the queue
// are the local ones Miniflare runs. Storage is separate for each test file, and reset-storage.ts
// empties it after each test.
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { RefreshJob } from "../src/types.ts";

test("the Worker's fetch handler answers a request", async () => {
  const response = await exports.default.fetch(new Request("https://releasebar.test/api/me"));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  const body = (await response.json()) as { user: unknown; loginUrl: string };
  expect(body.user).toBe(null);
  expect(body.loginUrl).toBe("https://releasebar.test/api/auth/login");
});

test("the build coordinator Durable Object keeps a lock between calls", async () => {
  const coordinator = env.BUILD_COORDINATOR.getByName("runtime-bindings");

  expect(await coordinator.acquireLock("first")).toBe(true);
  expect(await coordinator.acquireLock("second")).toBe(false);
  expect(await coordinator.refreshLock("second")).toBe(false);
  expect(await coordinator.refreshLock("first")).toBe(true);
  await coordinator.releaseLock("second");
  expect(await coordinator.acquireLock("second")).toBe(false);
  await coordinator.releaseLock("first");
  expect(await coordinator.acquireLock("second")).toBe(true);
});

test("the dashboard cache KV namespace round-trips a value", async () => {
  const key = "runtime-bindings:value";
  expect(await env.DASHBOARD_CACHE.get(key)).toBe(null);

  await env.DASHBOARD_CACHE.put(key, JSON.stringify({ stored: true }));
  expect(await env.DASHBOARD_CACHE.get(key, "json")).toStrictEqual({ stored: true });
  const listed = await env.DASHBOARD_CACHE.list({ prefix: "runtime-bindings:" });
  expect(listed.keys.map((entry) => entry.name)).toStrictEqual([key]);

  await env.DASHBOARD_CACHE.delete(key);
  expect(await env.DASHBOARD_CACHE.get(key)).toBe(null);
});

test("a message sent to the refresh queue reaches the Worker's queue handler", async () => {
  // A job for a target key that no dashboard schema has: the handler records the job as skipped
  // without asking GitHub for anything.
  const now = new Date().toISOString();
  const job: RefreshJob = {
    id: "runtime-bindings-job",
    targetKey: "runtime-bindings:missing",
    kind: "dashboard",
    status: "queued",
    reason: "runtime-bindings",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  await env.REFRESH_QUEUE.send(job);

  const stored = await vi.waitFor(async () => {
    const value = await env.DASHBOARD_CACHE.get(`refresh:job:v1:${job.id}`);
    if (value === null) throw new Error("the queue handler has not recorded the job yet");
    return JSON.parse(value) as RefreshJob;
  });
  expect(stored.id).toBe(job.id);
  expect(stored.status).toBe("skipped");
});
