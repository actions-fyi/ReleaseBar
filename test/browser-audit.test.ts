import { env as runtimeEnv } from "cloudflare:workers";
import { assert, expect, test } from "vitest";
import { isGitHubRateLimit } from "../src/rate-limit.ts";
import {
  githubAccessRouteRecords,
  kvStore,
  refreshAuditEvents,
  worker,
} from "./dashboard-test-harness.ts";

test("browser rate-limit detection covers HTTP and cached GitHub quota failures", () => {
  expect(isGitHubRateLimit(429)).toBe(true);
  expect(isGitHubRateLimit(403, "API rate limit exceeded")).toBe(true);
  expect(isGitHubRateLimit(200, "shared GitHub quota paused until reset")).toBe(true);
  expect(
    isGitHubRateLimit(200, "Repository detail is cache-only while shared GitHub quota recovers."),
  ).toBe(true);
  expect(isGitHubRateLimit(500, "dashboard fetch failed")).toBe(false);
  expect(isGitHubRateLimit(200, "shared quota · 4,812 left")).toBe(false);
});

test("worker records client dashboard timing beacons in audit log", async () => {
  const cache = kvStore();
  const waits: Array<Promise<unknown>> = [];
  const response = await worker.fetch(
    new Request("https://release.bar/api/_client-timing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        route: "dashboard",
        source: "fetch",
        path: "/steipete",
        apiPath: "/api/steipete",
        attempt: 0,
        httpStatus: 200,
        cacheState: "stale",
        headerMs: 42.4,
        bodyMs: 3.2,
        renderMs: 17.8,
        totalMs: 63.4,
        navigationTtfbMs: 91.2,
        projects: 58,
        scanned: 12,
        limit: 200,
        done: false,
      }),
    }),
    { DASHBOARD_CACHE: cache },
    { waitUntil: (promise) => waits.push(promise) },
  );

  expect(response.status).toBe(202);
  await Promise.all(waits);
  const [event] = await refreshAuditEvents();
  expect(event?.event).toBe("client_dashboard_timing");
  expect(event?.source).toBe("browser");
  expect(event?.reason).toBe("fetch");
  expect(event?.status).toBe("stale");
  expect(event?.durationMs).toBe(63);
  expect(event?.projects).toBe(58);
  expect(event?.scanned).toBe(12);
  expect(event?.limit).toBe(200);
  expect(event?.done).toBe(false);
  expect(event?.detail ?? "").toMatch(/path=\/steipete/);
  expect(event?.detail ?? "").toMatch(/headerMs=42/);
  expect(event?.detail ?? "").toMatch(/navTtfbMs=91/);
});

test("worker stores GitHub access counters and cached owner identity", async () => {
  const cache = kvStore();
  let releaseAuditWrites: () => void = () => undefined;
  const auditWriteGate = new Promise<void>((resolve) => {
    releaseAuditWrites = resolve;
  });
  // The local database, with the batches that count GitHub calls held back. Other writes of the
  // request, such as its refresh target, go through.
  const real = runtimeEnv.DB;
  const auditStatements = new WeakSet<object>();
  const database = {
    prepare(sql: string): D1PreparedStatement {
      const statement = real.prepare(sql);
      if (!sql.includes("github_access_counts")) return statement;
      return new Proxy(statement, {
        get(target, property) {
          const member: unknown = Reflect.get(target, property);
          if (property === "bind") {
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              auditStatements.add(bound);
              return bound;
            };
          }
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    },
    async batch(statements: D1PreparedStatement[]) {
      if (statements.some((statement) => auditStatements.has(statement))) await auditWriteGate;
      return real.batch(statements);
    },
  } as unknown as D1Database;
  const originalFetch = globalThis.fetch;
  const waits: Array<Promise<unknown>> = [];
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/users/owner") {
        return Response.json(
          {
            login: "owner",
            type: "User",
            avatar_url: "https://github.com/owner.png",
            html_url: "https://github.com/owner",
          },
          {
            headers: {
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-resource": "core",
            },
          },
        );
      }
      if (url.pathname === "/graphql") {
        return Response.json(
          {
            data: {
              repositoryOwner: {
                __typename: "User",
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
          {
            headers: {
              "x-ratelimit-remaining": "4998",
              "x-ratelimit-resource": "graphql",
            },
          },
        );
      }
      throw new Error(`unexpected ${url.pathname}`);
    };

    let foregroundTimeout: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      worker.fetch(
        new Request("https://release.bar/api/owner"),
        { DASHBOARD_CACHE: cache, DB: database, GITHUB_TOKEN: "token" },
        { waitUntil: (promise) => waits.push(promise) },
      ),
      new Promise<never>((_resolve, reject) => {
        foregroundTimeout = setTimeout(
          () => reject(new Error("foreground response waited for the GitHub audit write")),
          1000,
        );
      }),
    ]);
    if (foregroundTimeout) clearTimeout(foregroundTimeout);

    expect(response.status).toBe(200);
    releaseAuditWrites();
    await Promise.all(waits);
    const owner = JSON.parse((await cache.get("owner:v1:owner")) ?? "{}") as {
      login?: string;
    };
    expect(owner.login).toBe("owner");
    const records = await githubAccessRouteRecords();
    assert.ok(
      records.some(
        (record) =>
          record.area === "dashboard" &&
          record.source === "shared" &&
          record.route === "users/:owner",
      ),
    );
    assert.ok(
      records.some(
        (record) =>
          record.area === "dashboard" &&
          record.source === "shared" &&
          record.route === "graphql/ReleaseBarOwnerRepos.metadata",
      ),
    );
  } finally {
    releaseAuditWrites();
    globalThis.fetch = originalFetch;
  }
});
