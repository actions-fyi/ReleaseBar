import { readFile } from "node:fs/promises";
import { assert, expect, test } from "vitest";
import { calculateAudienceScore, isLikelyBot } from "../shared/audience.ts";
import {
  dashboardRoute,
  ownerActivityFromPath,
  ownerActivityPath,
  ownerDashboardPath,
  ownerFromPath,
  fallbackApiOrigin,
  repoDetailPath,
  repoFromPath,
  workerApiOrigin,
  workersDevApiOrigin,
} from "../src/routing.ts";
import {
  matchesProjectSearch,
  parseViewState,
  showCodeChurn,
  sortProjects,
  viewStateSearch,
  type DashboardViewState,
} from "../src/dashboard-view.ts";
import type { DashboardPayload, RepoDetailPayload } from "../src/types.ts";
import { dashboardStreamSignature, dashboardStreamState } from "../worker/dashboard-rebuild.ts";
import { testDashboard, testProject } from "./dashboard-fixtures.ts";

test("owner route parsing keeps root hot board and owners API-backed", () => {
  expect(ownerFromPath("/")).toBe(null);
  expect(ownerFromPath("/index.html")).toBe(null);
  expect(ownerFromPath("/OpenClaw")).toBe("OpenClaw");
  expect(ownerFromPath("/bad_owner")).toBe(null);
  expect(ownerDashboardPath("@Steipete")).toBe("/steipete");
  expect(repoFromPath("/OpenClaw/Peekaboo")).toStrictEqual({
    owner: "openclaw",
    repo: "peekaboo",
    fullName: "openclaw/peekaboo",
    apiPath: `${workerApiOrigin}/api/repos/openclaw/peekaboo`,
    fallbackApiPath: `${workersDevApiOrigin}/api/repos/openclaw/peekaboo`,
  });
  expect(repoFromPath("/openclaw")).toBe(null);
  expect(repoDetailPath("OpenClaw/Peekaboo")).toBe("/openclaw/peekaboo");
  expect(repoDetailPath("OpenClaw/react.dev")).toBe("/-/openclaw/react.dev");
  expect(repoFromPath("/acme/activity")).toBe(null);
  expect(repoDetailPath("acme/activity")).toBe("/-/acme/activity");
  expect(ownerActivityFromPath("/Steipete/activity")).toStrictEqual({
    owner: "steipete",
    apiPath: `${workerApiOrigin}/api/steipete/activity`,
    fallbackApiPath: `${workersDevApiOrigin}/api/steipete/activity`,
  });
  expect(ownerActivityFromPath("/api/activity")).toBe(null);
  expect(ownerActivityFromPath("/-/owners/api/activity")).toStrictEqual({
    owner: "api",
    apiPath: `${workerApiOrigin}/api/api/activity`,
    fallbackApiPath: `${workersDevApiOrigin}/api/api/activity`,
  });
  expect(ownerActivityFromPath("/steipete/activity/extra")).toBe(null);
  expect(ownerActivityPath("@Steipete")).toBe("/steipete/activity");
  expect(ownerActivityPath("@Steipete", "day")).toBe("/steipete/activity?range=day");
  expect(ownerActivityPath("@Steipete", "month")).toBe("/steipete/activity?range=month");
  expect(ownerActivityPath("@api")).toBe("/-/owners/api/activity");
  expect(ownerActivityPath("@og", "month")).toBe("/-/owners/og/activity?range=month");
  expect(repoFromPath("/-/og/foo")).toStrictEqual({
    owner: "og",
    repo: "foo",
    fullName: "og/foo",
    apiPath: `${workerApiOrigin}/api/repos/og/foo`,
    fallbackApiPath: `${workersDevApiOrigin}/api/repos/og/foo`,
  });
  expect(repoDetailPath("og/foo")).toBe("/-/og/foo");

  expect(dashboardRoute("/", "").isDefault).toStrictEqual(true);
  expect(dashboardRoute("/", "").apiPath).toBe(`${workerApiOrigin}/api/_discover`);
  expect(dashboardRoute("/", "").fallbackApiPath).toBe(`${workersDevApiOrigin}/api/_discover`);
  expect(dashboardRoute("/", "").discoverPeriod).toBe("week");
  expect(dashboardRoute("/", "?period=day&hotLang=TypeScript").apiPath).toBe(
    `${workerApiOrigin}/api/_discover?period=day&lang=TypeScript`,
  );
  expect(dashboardRoute("/", "?period=releasebar&hotLang=TypeScript").apiPath).toBe(
    `${workerApiOrigin}/api/_hot`,
  );
  expect(dashboardRoute("/", "?period=releasebar&hotLang=TypeScript").discoverLanguage).toBe("");
  expect(dashboardRoute("/", "?period=day&lang=TypeScript").apiPath).toBe(
    `${workerApiOrigin}/api/_discover?period=day`,
  );
  expect(dashboardRoute("/openclaw", "").apiPath).toBe(`${workerApiOrigin}/api/openclaw`);
  expect(dashboardRoute("/openclaw", "?forks=true&archived=true&unreleased=true").apiPath).toBe(
    `${workerApiOrigin}/api/openclaw?forks=true&archived=true`,
  );
  expect(dashboardRoute("/openclaw", "?unreleased=false").apiPath).toBe(
    `${workerApiOrigin}/api/openclaw?unreleased=false`,
  );
  expect(
    dashboardRoute("/openclaw", "?owners=steipete,openclaw&repos=steipete/oracle").apiPath,
  ).toBe(`${workerApiOrigin}/api/openclaw?owners=steipete&repos=steipete%2Foracle`);
  expect(dashboardRoute("/", "?owners=openclaw&repos=steipete/oracle").apiPath).toBe(
    `${workerApiOrigin}/api/dashboard?owners=openclaw&repos=steipete%2Foracle`,
  );
  expect(dashboardRoute("/", "?owners=openclaw").fallbackApiPath).toBe(
    `${workersDevApiOrigin}/api/dashboard?owners=openclaw`,
  );
  expect(fallbackApiOrigin({ protocol: "http:", hostname: "127.0.0.1", port: "5174" })).toBe(
    "http://127.0.0.1:8787",
  );
  expect(fallbackApiOrigin({ protocol: "http:", hostname: "localhost", port: "8787" })).toBe(
    workersDevApiOrigin,
  );
  expect(
    dashboardRoute(
      "/openclaw",
      "?q=codex&lang=Swift&filter=attention&sort=issues&dir=desc&dev=true",
    ).apiPath,
  ).toBe(`${workerApiOrigin}/api/openclaw`);
});

test("owner activity event logs are collapsed by default", async () => {
  const source = await readFile("src/components/OwnerActivityPage.svelte", "utf8");
  expect(source).toMatch(/<details class="activity-event-details">/);
  expect(source).not.toMatch(/<details class="activity-event-details"[^>]*\bopen(?:=|\s|>)/);
});

test("owner activity range links use the reserved-safe route helper", async () => {
  const source = await readFile("src/components/OwnerActivityPage.svelte", "utf8");
  expect(source).toMatch(/ownerActivityPath\(activityPageRoute\.owner, range\)/);
});

test("dashboard view state restores search, filters, sorting, and dev columns", () => {
  expect(
    parseViewState("?q=CodexBar&lang=Swift&filter=attention&sort=issues&dir=asc", false),
  ).toStrictEqual({
    query: "CodexBar",
    language: "Swift",
    filter: "attention",
    sortKey: "issues",
    sortDirection: "asc",
    devMode: true,
  });
  expect(parseViewState("?filter=nope&sort=nope&dir=sideways", true)).toStrictEqual({
    query: "",
    language: "",
    filter: "all",
    sortKey: "since",
    sortDirection: "desc",
    devMode: false,
  });
  expect(parseViewState("?sort=version&dir=asc", false)).toStrictEqual({
    query: "",
    language: "",
    filter: "all",
    sortKey: "activity",
    sortDirection: "desc",
    devMode: false,
  });

  const state: DashboardViewState = {
    query: "repo",
    language: "Go",
    filter: "hot",
    sortKey: "prs",
    sortDirection: "desc",
    devMode: true,
  };
  expect(viewStateSearch("?owners=openclaw&q=old", state, false)).toBe(
    "?owners=openclaw&q=repo&lang=Go&filter=hot&sort=prs&dir=desc&dev=true",
  );
  expect(
    viewStateSearch(
      "?owners=openclaw&q=repo&filter=all&sort=activity&dir=desc&dev=true",
      {
        query: "",
        language: "",
        filter: "all",
        sortKey: "activity",
        sortDirection: "desc",
        devMode: false,
      },
      false,
    ),
  ).toBe("?owners=openclaw");
  expect(
    viewStateSearch(
      "?period=day&hotLang=TypeScript&lang=Swift",
      {
        query: "",
        language: "",
        filter: "all",
        sortKey: "activity",
        sortDirection: "desc",
        devMode: false,
      },
      false,
    ),
  ).toBe("?period=day&hotLang=TypeScript");
});

test("dashboard project sorting handles dev issue and pull request counts numerically", () => {
  const projects = [
    testProject({ owner: "owner", name: "zero", openIssues: 0, openPullRequests: 0 }),
    testProject({ owner: "owner", name: "many", openIssues: 37, openPullRequests: 3 }),
    testProject({ owner: "owner", name: "some", openIssues: 4, openPullRequests: 12 }),
    testProject({ owner: "owner", name: "unknown", openIssues: null, openPullRequests: null }),
  ];

  expect(sortProjects(projects, "issues", "desc").map((project) => project.name)).toStrictEqual([
    "many",
    "some",
    "zero",
    "unknown",
  ]);
  expect(sortProjects(projects, "prs", "desc").map((project) => project.name)).toStrictEqual([
    "some",
    "many",
    "zero",
    "unknown",
  ]);
  expect(
    sortProjects(
      [
        testProject({ owner: "owner", name: "small", stars: 10 }),
        testProject({ owner: "owner", name: "large", stars: 1000 }),
      ],
      "stars",
      "desc",
    ).map((project) => project.name),
  ).toStrictEqual(["large", "small"]);
});

test("dashboard project search matches independent metadata terms", () => {
  const project = testProject({
    owner: "owner",
    name: "releasebar",
    description: "Manual refresh dashboard",
    language: "TypeScript",
    topics: ["cloudflare", "worker"],
    version: "v1.2.3",
    releaseName: "Ship dashboard search",
    ciState: "failure",
    ciWorkflow: "CI",
  });

  expect(matchesProjectSearch(project, "")).toBe(true);
  expect(matchesProjectSearch(project, "typescript v1.2.3")).toBe(true);
  expect(matchesProjectSearch(project, "owner worker ci")).toBe(true);
  expect(matchesProjectSearch(project, "ship failure")).toBe(true);
  expect(matchesProjectSearch(project, "typescript swift")).toBe(false);
});

test("dashboard stream signature changes when dev sort counts change", () => {
  const payload = testDashboard("owner", [
    testProject({ owner: "owner", name: "one", openIssues: 1, openPullRequests: 2 }),
  ]);
  payload.generatedAt = "2026-05-22T00:00:00.000Z";
  payload.cache = {
    state: "partial",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
    progress: { scanned: 16, limit: 200, done: false },
  };
  const next = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  assert.ok(next.projects[0]);
  next.projects[0].openPullRequests = 9;

  expect(dashboardStreamSignature(payload, "partial")).not.toBe(
    dashboardStreamSignature(next, "partial"),
  );
  const archived = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  assert.ok(archived.projects[0]);
  archived.projects[0].archived = true;
  expect(dashboardStreamSignature(payload, "partial")).not.toBe(
    dashboardStreamSignature(archived, "partial"),
  );
  const fresher = JSON.parse(JSON.stringify(payload)) as DashboardPayload;
  assert.ok(fresher.cache);
  fresher.cache.countsUpdatedAt = "2026-05-22T00:01:00.000Z";
  expect(dashboardStreamSignature(payload, "partial")).not.toBe(
    dashboardStreamSignature(fresher, "partial"),
  );
});

test("dashboard stream state preserves explicit webhook invalidation", () => {
  const payload = testDashboard("owner", [testProject({ owner: "owner", name: "repo" })]);
  payload.generatedAt = new Date().toISOString();
  payload.cache = {
    state: "stale",
    stale: true,
    capped: false,
    repoLimit: 200,
    generatedAt: payload.generatedAt,
  };
  expect(dashboardStreamState(payload)).toBe("stale");
});

test("repository detail hides unavailable code churn", () => {
  const base: RepoDetailPayload = {
    fullName: "owner/repo",
    generatedAt: "2026-05-18T00:00:00Z",
    cache: {
      state: "fresh",
      stale: false,
      generatedAt: "2026-05-18T00:00:00Z",
    },
    stats: {
      commitActivity: { state: "ready" },
      codeFrequency: {
        state: "unavailable",
        message: "repository must have fewer than 10000 commits",
      },
    },
    project: testProject({ owner: "owner", name: "repo" }),
    releases: [],
    contributors: [],
    commitActivity: [],
    codeFrequency: [],
    languages: [],
    workTrend: null,
  };

  expect(showCodeChurn(base)).toBe(false);
  expect(
    showCodeChurn({
      ...base,
      stats: {
        commitActivity: base.stats?.commitActivity ?? { state: "ready" },
        codeFrequency: { state: "warming", message: "GitHub is preparing repository statistics." },
      },
    }),
  ).toBe(true);
  expect(
    showCodeChurn({
      ...base,
      codeFrequency: [{ week: "2026-05-18T00:00:00Z", additions: 10, deletions: 3 }],
    }),
  ).toBe(true);
});

test("audience scoring uses only public profile and stargazer signals", () => {
  expect(isLikelyBot("dependabot")).toBe(true);
  const bot = calculateAudienceScore({
    login: "github-actions[bot]",
    followers: 100000,
    following: 0,
    publicRepos: 100,
    publicGists: 0,
    company: "GitHub",
    bio: "Automation",
    location: "CI",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2018-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  expect(bot.score).toBe(0);
  expect(bot.tier).toBe("bot");
  expect(bot.reasons).toStrictEqual(["automation account"]);
  expect(bot.dimensions).toStrictEqual({
    trust: 0,
    influence: 0,
    builder: 0,
    recency: 0,
    risk: 0,
  });
  expect(bot.factors[0]?.key).toBe("risk");
  expect(bot.factors[0]?.label).toBe("account safety");
  expect(bot.factors[0]?.sentiment).toBe("negative");

  const high = calculateAudienceScore({
    login: "human",
    followers: 2500,
    following: 100,
    publicRepos: 90,
    publicGists: 4,
    company: "GitHub",
    bio: "Principal software engineer working on developer tools",
    location: "San Francisco",
    blog: "https://human.dev",
    twitterUsername: "human",
    accountCreatedAt: "2015-01-01T00:00:00Z",
    starredAt: new Date().toISOString(),
    targetLanguage: "TypeScript",
    orgs: [{ login: "github", description: "How people build software" }],
    repos: [
      {
        fullName: "human/toolkit",
        description: "Developer tools",
        url: "https://github.com/human/toolkit",
        language: "TypeScript",
        stars: 450,
        forks: 20,
        updatedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
        topics: ["developer-tools"],
      },
    ],
  });
  expect(high.tier).toBe("high");
  assert.ok(high.score >= 70);
  assert.ok(high.reasons.includes("known tech company"));
  assert.ok(high.reasons.includes("notable org: github"));
  assert.ok(high.dimensions.trust >= 80);
  expect(high.dimensions.risk).toBe(100);
  expect(high.factors.find((factor) => factor.key === "age")?.label).toBe("account age");
  expect(high.factors.map((factor) => factor.key)).toStrictEqual([
    "age",
    "profile",
    "orgs",
    "reach",
    "builder",
    "recency",
    "risk",
  ]);
  assert.ok((high.factors.find((factor) => factor.key === "builder")?.weightedValue ?? 0) > 0);
  const profileOnly = calculateAudienceScore({
    login: "human",
    followers: 2500,
    following: 100,
    publicRepos: 90,
    publicGists: 4,
    company: "GitHub",
    bio: "Principal software engineer working on developer tools",
    location: "San Francisco",
    blog: "https://human.dev",
    twitterUsername: "human",
    accountCreatedAt: "2015-01-01T00:00:00Z",
    starredAt: null,
    targetLanguage: "TypeScript",
    orgs: [{ login: "github", description: "How people build software" }],
    repos: [
      {
        fullName: "human/toolkit",
        description: "Developer tools",
        url: "https://github.com/human/toolkit",
        language: "TypeScript",
        stars: 450,
        forks: 20,
        updatedAt: new Date().toISOString(),
        pushedAt: new Date().toISOString(),
        topics: ["developer-tools"],
      },
    ],
  });
  expect(profileOnly.factors.find((factor) => factor.key === "recency")?.weight).toBe(0);
  expect(profileOnly.tier).toBe("high");
  expect(
    Math.round(profileOnly.factors.reduce((sum, factor) => sum + factor.weightedValue, 0)),
  ).toBe(profileOnly.score);

  const low = calculateAudienceScore({
    login: "quiet-user",
    followers: 2,
    following: 0,
    publicRepos: 1,
    publicGists: 0,
    company: null,
    bio: null,
    location: null,
    starredAt: null,
  });
  expect(low.tier).toBe("low");
  assert.ok(low.score < 40);
  expect(low.factors.find((factor) => factor.key === "risk")?.sentiment).toBe("negative");
});

test("isLikelyBot uses account type before narrow login fallbacks", () => {
  // GitHub account metadata is authoritative when it is available.
  for (const login of ["cabot", "crawlerbot", "robot", "gpt4bot"]) {
    expect(isLikelyBot(login, "Bot"), `${login} with Bot type should be a bot`).toBe(true);
    expect(isLikelyBot(login, "App"), `${login} with App type should be a bot`).toBe(true);
    expect(isLikelyBot(login, "User"), `${login} with User type should be human`).toBe(false);
  }

  // Narrow lexical fallback for callers that do not have account type metadata.
  for (const login of [
    "dependabot",
    "renovate",
    "github-actions",
    "github-actions[bot]",
    "my-bot",
    "ci.bot",
    "bot-ci",
    "foo[bot]",
    "bot",
  ]) {
    expect(isLikelyBot(login), `${login} should be detected as a bot`).toBe(true);
  }

  for (const login of ["renovate-bot", "bot-ci", "foo[bot]", "github-actions"]) {
    expect(
      isLikelyBot(login, "User"),
      `${login} should keep explicit bot fallback with User metadata`,
    ).toBe(true);
  }

  // No-separator *bot names are ambiguous without metadata, so do not guess.
  for (const login of [
    "cabot",
    "talbot",
    "abbot",
    "wilbot",
    "arbot",
    "crawlerbot",
    "robot",
    "gpt4bot",
  ]) {
    expect(isLikelyBot(login), `${login} should require metadata before bot tier`).toBe(false);
  }

  // A strong human profile whose login ends in "bot" is scored, not zeroed out.
  const human = calculateAudienceScore({
    login: "cabot",
    accountType: "User",
    followers: 5000,
    following: 50,
    publicRepos: 80,
    publicGists: 2,
    company: "GitHub",
    bio: "Principal engineer",
    location: "SF",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2015-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  expect(human.tier).not.toBe("bot");
  assert.ok(human.score > 0);

  const typedBot = calculateAudienceScore({
    login: "octocat",
    accountType: "Bot",
    followers: 5000,
    following: 50,
    publicRepos: 80,
    publicGists: 2,
    company: "GitHub",
    bio: "Automation",
    location: "CI",
    blog: null,
    twitterUsername: null,
    accountCreatedAt: "2015-01-01T00:00:00Z",
    accountUpdatedAt: "2026-05-18T00:00:00Z",
    starredAt: "2026-05-18T00:00:00Z",
  });
  expect(typedBot.score).toBe(0);
  expect(typedBot.tier).toBe("bot");
  expect(typedBot.reasons).toStrictEqual(["automation account"]);
});
