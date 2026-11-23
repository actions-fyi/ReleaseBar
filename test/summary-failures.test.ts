import { assert, expect, test } from "vitest";
import type {
  OwnerActivityPayload,
  OwnerActivitySummary,
  RepoDetailPayload,
} from "../src/types.ts";
import {
  activitySummaryPromptVersion,
  summaryRetryBaseMs,
  summaryRetryMaxMs,
  summaryRetryMultiplier,
} from "../worker/config.ts";
import { summaryFailedMessage, summaryRetryDue } from "../worker/release-summary.ts";
import {
  claudeJson,
  claudeText,
  signedIn,
  testProject,
  worker,
  cacheWith,
} from "./dashboard-test-harness.ts";

const httpOk = 200;
const httpAccepted = 202;
const httpUnauthorized = 401;
const oneMinuteMs = 60_000;
const authErrorText = "Invalid bearer token";
const ownerActivityKey = "owner-activity:v2:acme:week";
const repoDetailKey = "repo-detail:v4:acme/releasebar";

// Backoff after the nth failure in a row: the base, multiplied once per earlier failure.
const backoffMs = (failures: number): number =>
  Math.min(summaryRetryBaseMs * summaryRetryMultiplier ** (failures - 1), summaryRetryMaxMs);
const isoAgo = (ms: number, now = Date.now()): string => new Date(now - ms).toISOString();

const anthropicUnauthorized = (): Response =>
  Response.json(
    {
      type: "error",
      error: { type: "authentication_error", message: authErrorText },
      request_id: "req_test",
    },
    { status: httpUnauthorized },
  );

function ownerActivity(summary: OwnerActivitySummary): OwnerActivityPayload {
  const generatedAt = new Date().toISOString();
  return {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: { state: "fresh", stale: false, generatedAt },
    totals: {
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 1,
    },
    repositories: [
      {
        fullName: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        events: 1,
        commits: 1,
        pullRequests: 0,
        issues: 0,
        comments: 0,
        releases: 0,
        lastActiveAt: generatedAt,
      },
    ],
    events: [
      {
        id: "event",
        kind: "commit",
        title: "Improve working-on summaries",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary,
  };
}

function failedSummary(agoMs: number): OwnerActivitySummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model: "claude-haiku-5-5",
    inputHash: "failed-hash",
    eventsUsed: 1,
    promptVersion: activitySummaryPromptVersion,
    message: summaryFailedMessage,
    failedAt: isoAgo(agoMs),
    failures: 1,
  };
}

async function captureErrors(run: () => Promise<void>): Promise<readonly string[]> {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await run();
    return logged;
  } finally {
    console.error = originalError;
  }
}

// A request from a signed-in user, who may start summaries.
async function fetchSignedIn(
  cache: KVNamespace,
  url: string,
  queued: Promise<unknown>[],
): Promise<Response> {
  const user = await signedIn(cache);
  return worker.fetch(
    new Request(url, { headers: user.headers }),
    {
      GITHUB_TOKEN: "shared-token",
      ANTHROPIC_API_KEY: "claude-key",
      ...user.env,
    },
    { waitUntil: (promise) => queued.push(promise) },
  );
}

test("summary retry backoff doubles per failure and stops at the maximum", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  const failed = (agoMs: number, failures: number) => ({
    state: "unavailable",
    failedAt: isoAgo(agoMs, now),
    failures,
  });
  const many = 20;
  const failureCounts = [1, summaryRetryMultiplier, many];
  expect(
    failureCounts.map((failures) => [
      summaryRetryDue(failed(backoffMs(failures) - 1, failures), now),
      summaryRetryDue(failed(backoffMs(failures), failures), now),
    ]),
  ).toStrictEqual(failureCounts.map(() => [false, true]));
  expect(backoffMs(many)).toBe(summaryRetryMaxMs);
  expect(summaryRetryDue({ state: "unavailable" }, now)).toBe(false);
  expect(summaryRetryDue({ ...failed(summaryRetryMaxMs, 1), state: "ready" }, now)).toBe(false);
});

test("worker logs a failed owner activity summary and stores a generic message", async () => {
  const cache = await cacheWith({
    [ownerActivityKey]: JSON.stringify(
      ownerActivity({
        state: "warming",
        text: null,
        generatedAt: null,
        model: "claude-haiku-5-5",
        inputHash: "activity-hash",
        eventsUsed: 1,
      }),
    ),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      return anthropicUnauthorized();
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const logged = await captureErrors(async () => {
      const response = await fetchSignedIn(
        cache,
        "https://release.bar/api/acme/activity?range=week",
        queued,
      );
      expect(response.status).toBe(httpAccepted);
      await Promise.all(queued);
    });
    const cached = JSON.parse((await cache.get(ownerActivityKey)) ?? "{}") as OwnerActivityPayload;
    expect(cached.summary?.state).toBe("unavailable");
    expect(cached.summary?.message).toBe(summaryFailedMessage);
    expect(cached.summary?.failures).toBe(1);
    assert.ok(cached.summary?.failedAt);
    expect(logged.length).toBe(1);
    const entry = JSON.parse(logged[0] ?? "{}") as Record<string, unknown>;
    expect(entry.event).toBe("summary_failed");
    expect(entry.kind).toBe("owner-activity");
    assert.ok(String(entry.error).includes(authErrorText));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker waits out the backoff before retrying a failed owner activity summary", async () => {
  const payload = ownerActivity(failedSummary(oneMinuteMs));
  const cache = await cacheWith({ [ownerActivityKey]: JSON.stringify(payload) });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await fetchSignedIn(
      cache,
      "https://release.bar/api/acme/activity?range=week",
      queued,
    );
    expect(response.status).toBe(httpOk);
    expect(queued.length).toBe(0);
    const body = (await response.json()) as OwnerActivityPayload;
    expect(body.summary?.message).toBe(summaryFailedMessage);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker retries a failed owner activity summary once the backoff has passed", async () => {
  const cache = await cacheWith({
    [ownerActivityKey]: JSON.stringify(ownerActivity(failedSummary(backoffMs(1) + oneMinuteMs))),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      return Response.json({
        content: claudeJson({
          summary: "@acme refined working-on summaries.",
          repositories: [
            {
              fullName: "acme/releasebar",
              summary: "ReleaseBar refined its working-on summaries.",
            },
          ],
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await fetchSignedIn(
      cache,
      "https://release.bar/api/acme/activity?range=week",
      queued,
    );
    expect(response.status).toBe(httpAccepted);
    await Promise.all(queued);
    const cached = JSON.parse((await cache.get(ownerActivityKey)) ?? "{}") as OwnerActivityPayload;
    expect(cached.summary?.state).toBe("ready");
    expect(cached.summary?.failedAt).toBe(undefined);
    expect(cached.summary?.failures).toBe(undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker counts consecutive release summary failures and retries after the backoff", async () => {
  const priorFailures = 2;
  const commitTitles = ["Add release summary panel", "Fix summary cache key"];
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: { state: "fresh", stale: false, generatedAt },
    releaseSummary: {
      state: "unavailable",
      text: null,
      generatedAt: null,
      model: "claude-haiku-5-5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: commitTitles.length,
      commitsUsed: 0,
      message: summaryFailedMessage,
      failedAt: isoAgo(backoffMs(priorFailures) + oneMinuteMs),
      failures: priorFailures,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: commitTitles.length,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const cache = await cacheWith({ [repoDetailKey]: JSON.stringify(payload) });
  const queued: Promise<unknown>[] = [];
  // The first summary request fails, the retry succeeds.
  const claudeResponses = [
    anthropicUnauthorized,
    () => Response.json({ content: claudeText("ReleaseBar added a summary panel.") }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      return Response.json({
        total_commits: commitTitles.length,
        commits: commitTitles.map((message) => ({ commit: { message } })),
      });
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      const next = claudeResponses.shift();
      if (!next) throw new Error("unexpected extra summary request");
      return next();
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  const request = () =>
    fetchSignedIn(cache, "https://release.bar/api/repos/acme/releasebar", queued);
  const cachedSummary = async () =>
    (JSON.parse((await cache.get(repoDetailKey)) ?? "{}") as RepoDetailPayload).releaseSummary;
  try {
    const logged = await captureErrors(async () => {
      await request();
      await Promise.all(queued.splice(0));
    });
    const failed = await cachedSummary();
    expect(failed?.state).toBe("unavailable");
    expect(failed?.message).toBe(summaryFailedMessage);
    expect(failed?.failures).toBe(priorFailures + 1);
    const entry = JSON.parse(logged[0] ?? "{}") as Record<string, unknown>;
    expect(entry.kind).toBe("release");
    assert.ok(String(entry.error).includes(authErrorText));

    await request();
    expect(queued.length, "the next failure waits out a doubled backoff").toBe(0);

    await cache.put(
      repoDetailKey,
      JSON.stringify({
        ...payload,
        releaseSummary: {
          ...failed,
          failedAt: isoAgo(backoffMs(priorFailures + 1) + oneMinuteMs),
        },
      }),
    );
    await request();
    await Promise.all(queued.splice(0));
    const ready = await cachedSummary();
    expect(ready?.state).toBe("ready");
    expect(ready?.failures).toBe(undefined);
    expect(claudeResponses.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
