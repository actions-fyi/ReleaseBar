import { expect, test } from "vitest";
import type {
  OwnerActivityPayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "../src/types.ts";
import {
  claudeJson,
  claudeText,
  signedIn,
  testProject,
  worker,
  cacheWith,
} from "./dashboard-test-harness.ts";

test("worker includes lower-ranked repositories in the overall activity summary batch", async () => {
  const generatedAt = new Date().toISOString();
  const repositories = Array.from({ length: 31 }, (_, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    return {
      fullName: `acme/repo-${suffix}`,
      url: `https://github.com/acme/repo-${suffix}`,
      events: 1,
      commits: 1,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      lastActiveAt: generatedAt,
    };
  });
  const events = repositories.map((repository, index) => ({
    id: `event-${index + 1}`,
    kind: "commit" as const,
    title: `Improve repository ${index + 1}`,
    repo: repository.fullName,
    url: repository.url,
    createdAt: generatedAt,
    count: 1,
  }));
  const payload = {
    owner: {
      type: "user" as const,
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week" as const,
    generatedAt,
    cache: {
      state: "fresh" as const,
      stale: false,
      generatedAt,
    },
    totals: {
      events: 31,
      commits: 31,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 31,
    },
    repositories,
    events,
    summary: {
      state: "ready" as const,
      text: "Old summary.",
      generatedAt,
      model: "claude-haiku-5-5",
      inputHash: "old-hash",
      eventsUsed: 31,
      promptVersion: 3,
    },
  } satisfies OwnerActivityPayload;
  const cache = await cacheWith({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  let summaryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      summaryCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const inputText = JSON.stringify(body.messages);
      expect(body.max_tokens).toBe(5050);
      expect(inputText).toMatch(/Repository: acme\/repo-31\\nSummary target: no \(overall only\)/);
      expect(inputText.match(/Summary target: yes/g)?.length).toBe(30);
      expect(inputText.match(/Summary target: no \(overall only\)/g)?.length).toBe(1);
      const targetNames = body.output_config.format.schema.properties.repositories.items.properties
        .fullName.enum as string[];
      expect(targetNames.length).toBe(30);
      expect(targetNames.includes("acme/repo-31")).toBe(false);
      return Response.json({
        content: claudeJson({
          summary:
            "Work spanned all 31 repositories, including the lower-ranked improvements in acme/repo-31.",
          repositories: targetNames.map((fullName) => ({
            fullName,
            summary: `Improved ${fullName}.`,
          })),
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week", { headers: user.headers }),
      { ANTHROPIC_API_KEY: "claude-key", ...user.env },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    await Promise.all(queued);
    expect(summaryCalls).toBe(1);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    expect(cached.summary?.state, cached.summary?.message ?? "").toBe("ready");
    expect(cached.summary?.eventsUsed).toBe(31);
    expect(cached.summary?.repositories?.length).toBe(30);
    expect(cached.summary?.text ?? "").toMatch(/repo-31/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker trims expired events from cached owner activity", async () => {
  const generatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
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
        id: "expired",
        kind: "commit",
        title: "Old cached work",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "ready",
      text: "Acme worked on an old cached change.",
      generatedAt,
      model: "claude-haiku-5-5",
      inputHash: "expired-hash",
      eventsUsed: 1,
      promptVersion: 4,
    },
  };
  await cacheWith({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/acme/activity?range=week", {
      headers: { "user-agent": "Googlebot" },
    }),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as OwnerActivityPayload;
  expect(body.cache.state).toBe("stale");
  expect(body.totals.events).toBe(0);
  expect(body.totals.repositories).toBe(0);
  expect(body.repositories).toStrictEqual([]);
  expect(body.events).toStrictEqual([]);
  expect(body.summary?.state).toBe("unavailable");
  expect(body.summary?.text).toBe(null);
});

test("worker trims expired events from cached repository activity", async () => {
  const generatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const payload: RepoDetailActivityPayload = {
    fullName: "acme/releasebar",
    range: "day",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
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
        id: "expired",
        kind: "commit",
        title: "Old cached work",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "ready",
      text: "ReleaseBar had an old cached change.",
      generatedAt,
      model: "claude-haiku-5-5",
      inputHash: "expired-hash",
      eventsUsed: 1,
      promptVersion: 4,
    },
  };
  await cacheWith({
    "repo-activity:v1:acme/releasebar:day": JSON.stringify(payload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/repos/acme/releasebar/activity?range=day", {
      headers: { "user-agent": "Googlebot" },
    }),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as RepoDetailActivityPayload;
  expect(body.cache.state).toBe("stale");
  expect(body.totals.events).toBe(0);
  expect(body.totals.repositories).toBe(0);
  expect(body.repositories).toStrictEqual([]);
  expect(body.events).toStrictEqual([]);
  expect(body.summary?.state).toBe("unavailable");
  expect(body.summary?.text).toBe(null);
});

test("worker skips stale public owner activity summaries when events changed", async () => {
  const generatedAt = new Date().toISOString();
  const oldPayload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
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
        id: "old",
        kind: "commit",
        title: "Add old activity",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "old-hash",
      eventsUsed: 1,
    },
  };
  const newPayload: OwnerActivityPayload = {
    ...oldPayload,
    events: [
      {
        id: "new",
        kind: "commit",
        title: "Add new activity",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "new-hash",
      eventsUsed: 1,
    },
  };
  const cache = await cacheWith({
    "owner-activity:v2:acme:week": JSON.stringify(oldPayload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      await cache.put("owner-activity:v2:acme:week", JSON.stringify(newPayload));
      return Response.json({
        content: claudeText("Acme worked on old activity."),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week", { headers: user.headers }),
      {
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    expect(cached.events[0]?.id).toBe("new");
    expect(cached.summary?.state).toBe("warming");
    expect(cached.summary?.inputHash).toBe("new-hash");
    expect(cached.summary?.text).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes cached owner activity summaries from older prompt versions", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
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
    summary: {
      state: "ready",
      text: "@acme's public GitHub activity has centered on ReleaseBar.",
      generatedAt,
      model: "gpt-5.5",
      inputHash: "old-prompt-hash",
      eventsUsed: 1,
    },
  };
  const cache = await cacheWith({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      return Response.json({
        content: claudeJson({
          summary: "@acme's public GitHub activity refined working-on summaries.",
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
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week", { headers: user.headers }),
      {
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    const responseBody = (await response.json()) as OwnerActivityPayload;
    expect(responseBody.summary?.state).toBe("warming");
    expect(responseBody.summary?.text).toBe(null);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    expect(cached.summary?.state).toBe("ready");
    expect(cached.summary?.promptVersion).toBe(4);
    expect(cached.summary?.model).toBe("claude-haiku-5-5");
    expect(cached.summary?.inputHash).not.toBe("old-prompt-hash");
    expect(cached.summary?.text).toBe("@acme's work refined working-on summaries.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not summarize empty owner activity", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    totals: {
      events: 0,
      commits: 0,
      pullRequests: 0,
      issues: 0,
      comments: 0,
      releases: 0,
      repositories: 0,
    },
    repositories: [],
    events: [],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "empty-hash",
      eventsUsed: 0,
    },
  };
  const cache = await cacheWith({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week", { headers: user.headers }),
      {
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    expect(cached.summary?.state).toBe("unavailable");
    expect(cached.summary?.message).toBe("Not enough recent work to summarize.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker rejects incomplete structured owner activity summaries", async () => {
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner: {
      type: "user",
      login: "acme",
      avatarUrl: "https://github.com/acme.png",
      url: "https://github.com/acme",
    },
    range: "week",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
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
        title: "Add activity summary",
        repo: "acme/releasebar",
        url: "https://github.com/acme/releasebar",
        createdAt: generatedAt,
        count: 1,
      },
    ],
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      inputHash: "activity-hash",
      eventsUsed: 1,
    },
  };
  const cache = await cacheWith({
    "owner-activity:v2:acme:week": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      return Response.json({
        content: claudeJson({
          summary: "ReleaseBar added activity summaries.",
          repositories: [],
        }),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week", { headers: user.headers }),
      {
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    expect(cached.summary?.state).toBe("unavailable");
    expect(cached.summary?.model).toBe("claude-haiku-5-5");
    expect(cached.summary?.message).toBe("AI summary failed; retrying later.");
    expect(cached.summary?.inputHash).not.toBe("activity-hash");
    expect(cached.summary?.promptVersion).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps repository detail routes for repositories named activity", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/activity",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    project: testProject({
      owner: "acme",
      name: "activity",
      commitsSinceRelease: 1,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  await cacheWith({
    "repo-detail:v4:acme/activity": JSON.stringify(payload),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/activity"),
      {},
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RepoDetailPayload;
    expect(body.fullName).toBe("acme/activity");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker skips stale release summaries when repository detail changed", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 1,
      commitsUsed: 0,
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: 1,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const latestPayload: RepoDetailPayload = {
    ...payload,
    project: {
      ...payload.project,
      version: "v1.0.1",
      latestCommitSha: "fedcba9",
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.1",
      headSha: "fedcba9",
      commitCount: 1,
      commitsUsed: 0,
    },
  };
  const cache = await cacheWith({
    "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      return Response.json({
        total_commits: 1,
        commits: [{ commit: { message: "Add stale summary guard" } }],
      });
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      await cache.put("repo-detail:v4:acme/releasebar", JSON.stringify(latestPayload));
      return Response.json({
        content: claudeText("ReleaseBar added a stale summary guard."),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar", { headers: user.headers }),
      {
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(200);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-detail:v4:acme/releasebar")) ?? "{}",
    ) as RepoDetailPayload;
    expect(cached.project.version).toBe("v1.0.1");
    expect(cached.project.latestCommitSha).toBe("fedcba9");
    expect(cached.releaseSummary?.releaseTag).toBe("v1.0.1");
    expect(cached.releaseSummary?.text).toBe(null);
    expect(
      await cache.get("release-summary:v1:acme/releasebar:v1.0.0:abcdef1:claude-haiku-5-5"),
    ).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
