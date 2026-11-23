import { expect, test } from "vitest";
import type {
  OwnerActivityPayload,
  OwnerActivitySummary,
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "../../../src/types.js";
import { activitySummaryPromptVersion } from "../../../worker/config.js";
import { summaryRateLimitSettings, summaryRateLimits } from "../../../worker/summary-limits.js";
import {
  summaryGlobalLimitMessage,
  summarySignInMessage,
  summaryUserLimitMessage,
} from "../../../worker/summary-quota.js";
import {
  claudeJson,
  crawlerRequest,
  durableLocks,
  kvStore,
  signedIn,
  testProject,
  worker,
} from "../dashboard-test-harness.js";
import { deployConfig } from "../deploy-config.js";

const httpOk = 200;
const httpAccepted = 202;
const hourMs = 3_600_000;
const origin = "https://release.bar";
const repoDetailKey = "repo-detail:v4:acme/releasebar";
const repoActivityKey = "repo-activity:v1:acme/releasebar:week";
const ownerActivityKey = (owner: string): string => `owner-activity:v2:${owner}:week`;
const ownerActivityUrl = (owner: string): string => `${origin}/api/${owner}/activity?range=week`;

const pendingSummary: OwnerActivitySummary = {
  state: "warming",
  text: null,
  generatedAt: null,
  model: "claude-haiku-5-5",
  inputHash: "activity-hash",
  eventsUsed: 1,
  promptVersion: activitySummaryPromptVersion,
  message: "Summarizing recent work.",
};

function activity(owner: string) {
  const generatedAt = new Date().toISOString();
  const fullName = `${owner}/releasebar`;
  const url = `https://github.com/${fullName}`;
  const counts = { events: 1, commits: 1, pullRequests: 0, issues: 0, comments: 0, releases: 0 };
  return {
    range: "week" as const,
    generatedAt,
    cache: { state: "fresh" as const, stale: false, generatedAt },
    totals: { ...counts, repositories: 1 },
    repositories: [{ fullName, url, ...counts, lastActiveAt: generatedAt }],
    events: [
      {
        id: "event",
        kind: "commit" as const,
        title: "Improve working-on summaries",
        repo: fullName,
        url,
        createdAt: generatedAt,
        count: 1,
      },
    ],
  };
}

function ownerActivity(owner: string, summary = pendingSummary): OwnerActivityPayload {
  return {
    owner: {
      type: "user",
      login: owner,
      avatarUrl: `https://github.com/${owner}.png`,
      url: `https://github.com/${owner}`,
    },
    ...activity(owner),
    summary,
  };
}

function repoActivity(): RepoDetailActivityPayload {
  return { fullName: "acme/releasebar", ...activity("acme"), summary: pendingSummary };
}

function repoDetail(): RepoDetailPayload {
  const generatedAt = new Date().toISOString();
  return {
    fullName: "acme/releasebar",
    generatedAt,
    cache: { state: "fresh", stale: false, generatedAt },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "claude-haiku-5-5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 2,
      commitsUsed: 0,
      message: "Summarizing commits since the latest release.",
    },
    project: testProject({ owner: "acme", name: "releasebar", commitsSinceRelease: 2 }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
}

// Runs with fetch replaced: the model answers every owner summary and is counted; GitHub
// answers compare requests with no commits; anything else fails the test.
async function withModel(run: (modelCalls: () => number) => Promise<void>): Promise<void> {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com") {
      calls += 1;
      // The login in the prompt's "Owner: @acme" line: matches "acme", stops at the line end.
      const owner = /Owner: @([a-z\d-]+)/.exec(String(init?.body))?.[1] ?? "acme";
      return Response.json({
        content: claudeJson({
          summary: `@${owner} improved summaries.`,
          repositories: [{ fullName: `${owner}/releasebar`, summary: "Improved summaries." }],
        }),
      });
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/compare/")) {
      return Response.json({ total_commits: 0, commits: [] });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    await run(() => calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

type Cache = ReturnType<typeof kvStore>;
type Locks = ReturnType<typeof durableLocks>;

// Requests a page as a signed-in user and waits for its background work. Returns the summary
// the response showed.
async function summaryFor(
  cache: Cache,
  locks: Locks,
  userId: number,
  url: string,
): Promise<{ status: number; summary: OwnerActivitySummary | undefined }> {
  const user = await signedIn(cache, userId);
  const queued: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request(url, { headers: user.headers }),
    {
      DASHBOARD_CACHE: cache,
      GITHUB_TOKEN: "shared-token",
      ANTHROPIC_API_KEY: "claude-key",
      ...user.env,
      DASHBOARD_LOCKS: locks,
    },
    { waitUntil: (promise) => queued.push(promise) },
  );
  await Promise.all(queued);
  const body = (await response.json()) as {
    summary?: OwnerActivitySummary;
    releaseSummary?: OwnerActivitySummary;
  };
  return { status: response.status, summary: body.summary ?? body.releaseSummary };
}

const twoOwners = (): Cache =>
  kvStore({
    [ownerActivityKey("acme")]: JSON.stringify(ownerActivity("acme")),
    [ownerActivityKey("beta")]: JSON.stringify(ownerActivity("beta")),
  });

test("anonymous and crawler requests never start a summary and are told to sign in", async () => {
  const stored = {
    [ownerActivityKey("acme")]: JSON.stringify(ownerActivity("acme")),
    [repoActivityKey]: JSON.stringify(repoActivity()),
    [repoDetailKey]: JSON.stringify(repoDetail()),
  };
  const cache = kvStore(stored);
  const env = { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token", ANTHROPIC_API_KEY: "key" };
  const urls = [
    ownerActivityUrl("acme"),
    `${origin}/api/repos/acme/releasebar/activity?range=week`,
    `${origin}/api/repos/acme/releasebar`,
  ];
  await withModel(async (modelCalls) => {
    for (const url of urls) {
      for (const request of [new Request(url), crawlerRequest(url)]) {
        const queued: Promise<unknown>[] = [];
        const response = await worker.fetch(request, env, {
          waitUntil: (promise) => queued.push(promise),
        });
        const body = (await response.json()) as {
          summary?: OwnerActivitySummary;
          releaseSummary?: OwnerActivitySummary;
        };
        const summary = body.summary ?? body.releaseSummary;
        expect(response.status, url).toBe(httpOk);
        expect(response.headers.get("cache-control"), url).toBe("no-store");
        // Not `warming`, which the client would keep polling.
        expect(summary?.state, url).toBe("unavailable");
        expect(summary?.message, url).toBe(summarySignInMessage);
        expect(queued.length, url).toBe(0);
      }
    }
    expect(modelCalls()).toBe(0);
  });
  // The stored summaries stay pending for a signed-in request.
  for (const [key, value] of Object.entries(stored)) expect(await cache.get(key)).toBe(value);
});

test("anonymous requests get a cached summary", async () => {
  const ready: OwnerActivitySummary = {
    ...pendingSummary,
    state: "ready",
    text: "@acme improved summaries.",
    generatedAt: new Date().toISOString(),
    message: undefined,
  };
  const cache = kvStore({
    [ownerActivityKey("acme")]: JSON.stringify(ownerActivity("acme", ready)),
  });
  await withModel(async (modelCalls) => {
    const response = await worker.fetch(
      new Request(ownerActivityUrl("acme")),
      { DASHBOARD_CACHE: cache, ANTHROPIC_API_KEY: "key" },
      { waitUntil: () => undefined },
    );
    const body = (await response.json()) as OwnerActivityPayload;
    expect(response.status).toBe(httpOk);
    expect(body.summary?.text).toBe(ready.text);
    expect(response.headers.get("cache-control") ?? "").toMatch(/public/);
    expect(modelCalls()).toBe(0);
  });
});

test("a signed-in user generates summaries up to the hourly limit", async () => {
  const cache = twoOwners();
  const locks = durableLocks({ DASHBOARD_CACHE: cache, SUMMARY_USER_HOURLY_LIMIT: "1" });
  await withModel(async (modelCalls) => {
    const first = await summaryFor(cache, locks, 1, ownerActivityUrl("acme"));
    expect(first.status).toBe(httpAccepted);
    expect(first.summary?.state).toBe("warming");
    expect(modelCalls()).toBe(1);
    // The generated summary is cached, and reading it again costs nothing.
    const again = await summaryFor(cache, locks, 1, ownerActivityUrl("acme"));
    expect(again.summary?.text).toBe("@acme improved summaries.");

    const refused = await summaryFor(cache, locks, 1, ownerActivityUrl("beta"));
    expect(refused.status).toBe(httpOk);
    expect(refused.summary?.state).toBe("unavailable");
    expect(refused.summary?.message).toBe(summaryUserLimitMessage);
    expect(modelCalls()).toBe(1);

    // The limit is per user.
    const other = await summaryFor(cache, locks, 2, ownerActivityUrl("beta"));
    expect(other.summary?.state).toBe("warming");
    expect(modelCalls()).toBe(2);
  });
});

test("the daily limit for all users stops further summaries", async () => {
  const cache = twoOwners();
  const locks = durableLocks({ DASHBOARD_CACHE: cache, SUMMARY_GLOBAL_DAILY_LIMIT: "1" });
  await withModel(async (modelCalls) => {
    await summaryFor(cache, locks, 1, ownerActivityUrl("acme"));
    const refused = await summaryFor(cache, locks, 2, ownerActivityUrl("beta"));
    expect(refused.summary?.state).toBe("unavailable");
    expect(refused.summary?.message).toBe(summaryGlobalLimitMessage);
    expect(modelCalls()).toBe(1);
  });
});

test("a summary that never calls the model is not counted", async () => {
  const cache = twoOwners();
  await cache.put(repoDetailKey, JSON.stringify(repoDetail()));
  const locks = durableLocks({ DASHBOARD_CACHE: cache, SUMMARY_USER_HOURLY_LIMIT: "1" });
  await withModel(async (modelCalls) => {
    // GitHub returns no commit titles, so the release summary ends without the model.
    await summaryFor(cache, locks, 1, `${origin}/api/repos/acme/releasebar`);
    const stored = JSON.parse((await cache.get(repoDetailKey)) ?? "{}") as RepoDetailPayload;
    expect(stored.releaseSummary?.message).toBe("No commit titles were available to summarize.");
    expect(modelCalls()).toBe(0);

    const next = await summaryFor(cache, locks, 1, ownerActivityUrl("acme"));
    expect(next.summary?.state).toBe("warming");
    expect(modelCalls()).toBe(1);
  });
});

test("the summary quota counts atomically and starts over each hour", async () => {
  const limit = 3;
  const attempts = 10;
  const quota = durableLocks({ SUMMARY_USER_HOURLY_LIMIT: String(limit) }).get("summary-quota");
  const ask = async (reserve: boolean): Promise<boolean> => {
    const response = await quota.fetch(
      new Request("https://releasebar.internal/summary-quota", {
        method: "POST",
        body: JSON.stringify({ userId: 1, reserve }),
      }),
    );
    return ((await response.json()) as { allowed: boolean }).allowed;
  };
  const reserved = await Promise.all(Array.from({ length: attempts }, () => ask(true)));
  expect(reserved.filter(Boolean).length).toBe(limit);
  expect(await ask(false)).toBe(false);

  const realNow = Date.now;
  Date.now = () => realNow() + hourMs;
  try {
    // Checking alone counts nothing.
    expect(await ask(false)).toBe(true);
    expect(await ask(false)).toBe(true);
    expect(await ask(true)).toBe(true);
  } finally {
    Date.now = realNow;
  }
});

test("summary rate limits come from Worker vars, within their bounds", () => {
  const { userHourly, globalDaily } = summaryRateLimitSettings;
  expect(summaryRateLimits({})).toStrictEqual({
    userHourly: userHourly.defaultValue,
    globalDaily: globalDaily.defaultValue,
  });
  expect(
    summaryRateLimits({ SUMMARY_USER_HOURLY_LIMIT: " 5 ", SUMMARY_GLOBAL_DAILY_LIMIT: "200" }),
  ).toStrictEqual({ userHourly: 5, globalDaily: 200 });
  // Out of bounds is clamped, so no setting removes a limit; anything but a whole number is
  // ignored.
  expect(
    summaryRateLimits({ SUMMARY_USER_HOURLY_LIMIT: "0", SUMMARY_GLOBAL_DAILY_LIMIT: "999999999" }),
  ).toStrictEqual({ userHourly: userHourly.min, globalDaily: globalDaily.max });
  expect(summaryRateLimits({ SUMMARY_USER_HOURLY_LIMIT: "-1" })).toStrictEqual(
    summaryRateLimits({}),
  );
  expect(summaryRateLimits({ SUMMARY_GLOBAL_DAILY_LIMIT: "1e3" })).toStrictEqual(
    summaryRateLimits({}),
  );
});

test("deploy config sets the summary rate limits and rejects values out of bounds", () => {
  const config = deployConfig(
    {},
    { RELEASEBAR_SUMMARY_USER_HOURLY_LIMIT: " 5 ", RELEASEBAR_SUMMARY_GLOBAL_DAILY_LIMIT: "200" },
  );
  expect(config.vars).toStrictEqual({
    SUMMARY_USER_HOURLY_LIMIT: "5",
    SUMMARY_GLOBAL_DAILY_LIMIT: "200",
  });
  for (const value of ["0", "1001", "1,000", "-1", "1e2"]) {
    expect(() => deployConfig({}, { RELEASEBAR_SUMMARY_USER_HOURLY_LIMIT: value }), value).toThrow(
      "from 1 to 1000",
    );
  }
  expect(() => deployConfig({}, { RELEASEBAR_SUMMARY_GLOBAL_DAILY_LIMIT: "100001" })).toThrow();
});
