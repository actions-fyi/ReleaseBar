import { expect, test } from "vitest";
import type {
  OwnerActivityPayload,
  RepoDetailActivityPayload,
  RepoDetailPayload,
} from "../src/types.ts";
import {
  claudeJson,
  claudeText,
  crawlerRequest,
  kvStore,
  signedIn,
  testProject,
  worker,
} from "./dashboard-test-harness.ts";

test("worker throttles cached warming repository detail refreshes", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as RepoDetailPayload;
    expect(body.cache.state).toBe("warming");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker refreshes cached warming repository detail after short grace window", async () => {
  const generatedAt = new Date(Date.now() - 31_000).toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("queued refresh");
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RepoDetailPayload;
    expect(body.cache.state).toBe("stale");
    expect(body.cache.message).toBe("refreshing repository statistics");
    expect(waitUntilPromises.length).toBe(1);
    await Promise.all(waitUntilPromises);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker serves stale repository detail to crawlers without refreshing", async () => {
  const generatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/warmbar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "GitHub is preparing repository statistics.",
    },
    project: testProject({ owner: "acme", name: "warmbar" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler should not refresh ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      crawlerRequest("https://release.bar/api/repos/acme/warmbar"),
      {
        DASHBOARD_CACHE: kvStore({
          "repo-detail:v4:acme/warmbar": JSON.stringify(payload),
        }),
        GITHUB_TOKEN: "shared-token",
      },
      {
        waitUntil: (promise) => {
          waitUntilPromises.push(promise);
        },
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as RepoDetailPayload;
    expect(body.cache.state).toBe("stale");
    expect(body.cache.message).toBe("showing cached repository statistics");
    expect(waitUntilPromises.length).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker keeps crawler-only auxiliary API misses off GitHub", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`crawler auxiliary cache miss should not call GitHub ${String(input)}`);
  };
  try {
    for (const url of [
      "https://release.bar/api/kvark/activity?range=week",
      "https://release.bar/api/users/kvark/trust",
      "https://release.bar/api/repos/acme/coldbar/activity?range=week",
      "https://release.bar/api/repos/acme/coldbar",
    ]) {
      const response = await worker.fetch(
        crawlerRequest(url),
        { DASHBOARD_CACHE: kvStore(), GITHUB_TOKEN: "shared-token" },
        { waitUntil: () => undefined },
      );
      expect(response.status, url).toBe(202);
      const body = (await response.json()) as { cache?: { state?: string; message?: string } };
      expect(body.cache?.state).toBe("warming");
      expect(body.cache?.message ?? "").toMatch(/crawler/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes commits since release in the background", async () => {
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailPayload = {
    fullName: "acme/releasebar",
    generatedAt,
    cache: {
      state: "warming",
      stale: true,
      generatedAt,
      message: "refreshing repository statistics",
    },
    releaseSummary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: "gpt-5.5",
      releaseTag: "v1.0.0",
      headSha: "abcdef1",
      commitCount: 2,
      commitsUsed: 0,
      message: "Summarizing commits since the latest release.",
    },
    project: testProject({
      owner: "acme",
      name: "releasebar",
      commitsSinceRelease: 2,
    }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };
  const cache = kvStore({
    "repo-detail:v4:acme/releasebar": JSON.stringify(payload),
  });
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/repos/acme/releasebar/compare/v1.0.0...abcdef1"
    ) {
      expect(url.searchParams.get("per_page")).toBe("100");
      expect(url.searchParams.get("page")).toBe("1");
      return Response.json({
        total_commits: 2,
        commits: [
          { commit: { message: "Add release summary panel\n\nLong body" } },
          { commit: { message: "Fix summary cache key" } },
        ],
      });
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer claude-key");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.output_config?.effort).toBe("low");
      expect(JSON.stringify(body.messages)).toMatch(/Add release summary panel/);
      return Response.json({
        content: claudeText(
          "ReleaseBar added an AI summary panel and tightened the cache key for generated summaries.",
        ),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/releasebar", { headers: user.headers }),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as RepoDetailPayload;
    expect(body.releaseSummary?.state).toBe("warming");
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-detail:v4:acme/releasebar")) ?? "{}",
    ) as RepoDetailPayload;
    expect(cached.releaseSummary?.state).toBe("ready");
    expect(cached.releaseSummary?.model).toBe("claude-haiku-5-5");
    expect(cached.releaseSummary?.text ?? "").toMatch(/AI summary panel/);
    expect(cached.releaseSummary?.commitsUsed).toBe(2);
    expect(cached.generatedAt).toBe(generatedAt);
    expect(cached.cache.state).toBe("warming");
    expect(cached.cache.generatedAt).toBe(generatedAt);
    expect(
      await cache.get("release-summary:v1:acme/releasebar:v1.0.0:abcdef1:claude-haiku-5-5"),
    ).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes recent repository activity in the background", async () => {
  const cache = kvStore();
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/unreleased") {
      return Response.json({
        owner: { login: "acme" },
        name: "unreleased",
        full_name: "acme/unreleased",
        private: false,
        fork: false,
        archived: false,
        html_url: "https://github.com/acme/unreleased",
        description: "Unreleased repo",
        default_branch: "main",
        language: "TypeScript",
        topics: [],
        stargazers_count: 12,
        forks_count: 1,
        open_issues_count: 0,
        pushed_at: now,
        updated_at: now,
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/unreleased/events") {
      if (url.searchParams.get("page") !== "1") return Response.json([]);
      return Response.json([
        {
          id: "1",
          type: "PushEvent",
          public: true,
          created_at: now,
          repo: { name: "acme/unreleased" },
          payload: {
            size: 2,
            commits: [
              { message: "Add repository activity summary" },
              { message: "Polish unreleased project copy" },
            ],
          },
        },
        {
          id: "2",
          type: "PullRequestEvent",
          public: true,
          created_at: now,
          repo: { name: "acme/unreleased" },
          payload: {
            action: "merged",
            pull_request: {
              title: "Wire recent work panel",
              html_url: "https://github.com/acme/unreleased/pull/1",
            },
          },
        },
      ]);
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer claude-key");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.output_config?.effort).toBe("low");
      expect(JSON.stringify(body.messages)).toMatch(/Repository: acme\/unreleased/);
      expect(JSON.stringify(body.messages)).toMatch(/Add repository activity summary/);
      return Response.json({
        content: claudeText(
          "acme/unreleased added a recent-work panel for unreleased projects and polished the copy around that flow.",
        ),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const user = await signedIn(cache);
    const response = await worker.fetch(
      new Request("https://release.bar/api/repos/acme/unreleased/activity?range=month", {
        headers: user.headers,
      }),
      {
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as RepoDetailActivityPayload;
    expect(body.fullName).toBe("acme/unreleased");
    expect(body.range).toBe("month");
    expect(body.summary?.state).toBe("warming");
    expect(body.totals.commits).toBe(2);
    await Promise.all(queued);
    const cached = JSON.parse(
      (await cache.get("repo-activity:v1:acme/unreleased:month")) ?? "{}",
    ) as RepoDetailActivityPayload;
    expect(cached.summary?.state, cached.summary?.message ?? "").toBe("ready");
    expect(cached.summary?.model).toBe("claude-haiku-5-5");
    expect(cached.summary?.text ?? "").toMatch(/recent-work panel/);
    expect(cached.summary?.promptVersion).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker hides activity from forks of repositories owned by the profile", async () => {
  const cache = kvStore();
  const originalFetch = globalThis.fetch;
  const generatedAt = new Date().toISOString();
  let graphqlCalls = 0;
  const externalRepoCount = 101;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme") {
      return Response.json({
        login: "acme",
        type: "User",
        avatar_url: "https://github.com/acme.png",
        html_url: "https://github.com/acme",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme/events/public") {
      const externalEvents = Array.from({ length: externalRepoCount }, (_, index) => ({
        id: `external-${index}`,
        type: "PushEvent",
        public: true,
        created_at: generatedAt,
        repo: { name: `upstream/other-${index}` },
        payload: { size: 1, commits: [{ message: `Update unrelated project ${index}` }] },
      }));
      if (url.searchParams.get("page") === "1") {
        return Response.json([
          {
            id: "own",
            type: "PushEvent",
            public: true,
            created_at: generatedAt,
            repo: { name: "acme/tool" },
            payload: { size: 1, commits: [{ message: "Update owned project" }] },
          },
          ...externalEvents.slice(0, 99),
        ]);
      }
      if (url.searchParams.get("page") === "2") {
        return Response.json([
          ...externalEvents.slice(99),
          {
            id: "fork",
            type: "PushEvent",
            public: true,
            created_at: generatedAt,
            repo: { name: "contributor/tool" },
            payload: { size: 1, commits: [{ message: "Update contributor fork" }] },
          },
        ]);
      }
      return Response.json([]);
    }
    if (url.hostname === "api.github.com" && url.pathname === "/graphql") {
      graphqlCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, string>;
      };
      expect(body.query ?? "").toMatch(/query ReleaseBarActivityForkOrigins/);
      const data: Record<string, unknown> = {};
      for (let index = 0; body.variables?.[`owner${index}`]; index += 1) {
        data[`repo${index}`] =
          body.variables[`owner${index}`] === "contributor"
            ? {
                isFork: true,
                parent: { owner: { login: "acme" } },
              }
            : index === 0 && graphqlCalls === 1
              ? null
              : {
                  isFork: false,
                  parent: null,
                };
      }
      return Response.json({
        data,
        ...(graphqlCalls === 1
          ? { errors: [{ message: "Could not resolve repository upstream/other-0" }] }
          : {}),
      });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/acme/activity?range=week"),
      { DASHBOARD_CACHE: cache, GITHUB_TOKEN: "shared-token" },
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as OwnerActivityPayload;
    expect(graphqlCalls).toBe(3);
    expect(body.events.some((event) => event.repo === "contributor/tool")).toBe(false);
    expect(body.events.some((event) => event.repo === "upstream/other-100")).toBe(true);
    expect(body.totals.events).toBe(externalRepoCount + 1);
    expect(body.totals.commits).toBe(externalRepoCount + 1);
    expect(body.totals.repositories).toBe(externalRepoCount + 1);
    expect(await cache.get("owner-activity:v1:acme:week")).toBe(null);
    expect(await cache.get("owner-activity:v2:acme:week")).not.toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker summarizes public owner activity in the background", async () => {
  const cache = kvStore();
  const queued: Promise<unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const generatedAt = new Date().toISOString();
  let summaryCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme") {
      return Response.json({
        login: "acme",
        type: "User",
        avatar_url: "https://github.com/acme.png",
        html_url: "https://github.com/acme",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/users/acme/events/public") {
      expect(url.searchParams.get("per_page")).toBe("100");
      if (url.searchParams.get("page") !== "1") {
        return Response.json([]);
      }
      const events: unknown[] = [
        {
          id: "1",
          type: "PushEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            size: 4,
            commits: [
              { message: "Add owner activity panel\n\nLong body" },
              { message: "Cache activity summaries" },
            ],
          },
        },
        {
          id: "2",
          type: "PullRequestEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            action: "opened",
            pull_request: {
              title: "Polish working-on copy",
              html_url: "https://github.com/acme/releasebar/pull/1",
            },
          },
        },
        {
          id: "other-repo",
          type: "IssuesEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/other" },
          payload: {
            action: "closed",
            issue: {
              title: "Remove a redundant refresh path",
              html_url: "https://github.com/acme/other/issues/1",
            },
          },
        },
        {
          id: "repo-missing",
          type: "PushEvent",
          public: true,
          created_at: generatedAt,
          repo: {},
          payload: {
            size: 1,
            commits: [{ message: "This malformed event should be ignored" }],
          },
        },
        {
          id: "3",
          type: "PushEvent",
          public: false,
          created_at: generatedAt,
          repo: { name: "acme/private" },
          payload: { commits: [{ message: "private work" }] },
        },
      ];
      for (let index = 4; index <= 125; index += 1) {
        events.push({
          id: String(index),
          type: "IssueCommentEvent",
          public: true,
          created_at: generatedAt,
          repo: { name: "acme/releasebar" },
          payload: {
            issue: {
              title: `Activity thread ${index}`,
              html_url: `https://github.com/acme/releasebar/issues/${index}`,
            },
          },
        });
      }
      return Response.json(events);
    }
    if (url.hostname === "api.anthropic.com" && url.pathname === "/v1/messages") {
      summaryCalls += 1;
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer claude-key");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.output_config?.effort).toBe("low");
      expect(body.max_tokens).toBe(4200);
      expect(body.output_config?.format?.type).toBe("json_schema");
      expect(body.system).toMatch(/do not restate those facts/i);
      expect(body.system).toMatch(/one or two short sentences/i);
      expect(body.system).not.toMatch(/Say this is public activity/i);
      const inputText = JSON.stringify(body.messages);
      expect(inputText).toMatch(/Repository: acme\/releasebar/);
      expect(inputText).toMatch(/Summary target: yes/);
      expect(inputText).toMatch(/Totals: 127 items; 4 commits; 1 PR; 122 comments/);
      expect(inputText).toMatch(/Repository: acme\/other/);
      expect(inputText).toMatch(/Remove a redundant refresh path/);
      expect(inputText).toMatch(/Add owner activity panel/);
      expect(inputText).toMatch(/Events included: 125/);
      expect(inputText.match(/Repository: acme\/releasebar/g)?.length).toBe(1);
      return Response.json({
        content: claudeJson({
          summary:
            "ReleaseBar activity summaries, cache behavior, and dashboard copy moved forward together. A second repository removed a redundant refresh path.",
          repositories: [
            {
              fullName: "acme/releasebar",
              summary:
                "ReleaseBar gained grouped activity summaries and refined dashboard copy. The cache path now keeps that generated work reusable.",
            },
            {
              fullName: "acme/other",
              summary: "Closed an issue after removing a redundant refresh path.",
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
        DASHBOARD_CACHE: cache,
        GITHUB_TOKEN: "shared-token",
        ANTHROPIC_API_KEY: "claude-key",
        ...user.env,
      },
      { waitUntil: (promise) => queued.push(promise) },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as OwnerActivityPayload;
    expect(body.owner.login).toBe("acme");
    expect(body.range).toBe("week");
    expect(body.totals.commits).toBe(4);
    expect(body.totals.pullRequests).toBe(1);
    expect(body.totals.issues).toBe(1);
    expect(body.totals.repositories).toBe(2);
    expect(body.repositories[0]?.events).toBe(127);
    expect(body.repositories[0]?.commits).toBe(4);
    expect(body.repositories[0]?.pullRequests).toBe(1);
    expect(body.repositories[0]?.comments).toBe(122);
    const commitEvent = body.events.find((event) => event.kind === "commit");
    expect(commitEvent?.title ?? "").toMatch(/\+3 commits/);
    expect(body.events.some((event) => event.repo === "acme/private")).toBe(false);
    expect(body.summary?.state).toBe("warming");
    await Promise.all(queued);
    expect(summaryCalls).toBe(1);
    const cached = JSON.parse(
      (await cache.get("owner-activity:v2:acme:week")) ?? "{}",
    ) as OwnerActivityPayload;
    expect(cached.summary?.state, cached.summary?.message ?? "").toBe("ready");
    expect(cached.summary?.text ?? "").toMatch(/activity summaries/);
    expect(cached.summary?.repositories?.[0]?.text ?? "").toMatch(/grouped activity summaries/);
    expect(cached.summary?.repositories?.[0]?.text ?? "").toMatch(/cache path/);
    expect(cached.summary?.repositories?.[1]?.text ?? "").toMatch(/redundant refresh path/);
    expect(cached.summary?.text ?? "").not.toMatch(/GitHub activity|public activity/i);
    expect(cached.summary?.inputHash).not.toBe(null);
    expect(cached.summary?.eventsUsed).toBe(125);
    expect(cached.summary?.promptVersion).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
