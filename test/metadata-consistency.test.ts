import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardPayload, RefreshTarget } from "../src/types.ts";
import {
  ownerMetadataMutator,
  storedRefreshTarget,
  testDashboard,
  testProject,
  worker,
  seedOwnerMetadata,
  storedOwnerMetadataJson,
  cacheWith,
} from "./dashboard-test-harness.ts";

test("worker serves fresh dashboard cache before GitHub App token discovery", async () => {
  const now = new Date().toISOString();
  const releaseKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const metadataKey = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const cachedProject = { ...project, archived: true };
  const removedProject = testProject({ owner: "owner", name: "removed", openIssues: 4 });
  const cached: DashboardPayload = {
    ...testDashboard("owner", [cachedProject, removedProject]),
    generatedAt: now,
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: true,
      repoLimit: 200,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: now,
      countsUpdatedAt: now,
      releasesUpdatedAt: now,
      ciUpdatedAt: now,
    },
  };
  const staleMetadataAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const freshCountsAt = new Date(Date.now() + 1_000).toISOString();
  const ownerSnapshot = {
    owner: "owner",
    generatedAt: staleMetadataAt,
    metadataUpdatedAt: staleMetadataAt,
    countsUpdatedAt: freshCountsAt,
    knownRepos: [project.fullName.toLowerCase()],
    projects: [{ ...project, description: "stale description", archived: false, openIssues: 9 }],
  };
  await seedOwnerMetadata("owner", JSON.stringify(ownerSnapshot));
  await cacheWith({
    [metadataKey]: JSON.stringify(cached),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("fresh cache should not discover or mint GitHub App tokens");
  };
  try {
    const waits: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request("https://release.bar/api/owner"),
      {
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "unused",
      },
      { waitUntil: (promise) => waits.push(promise) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DashboardPayload;
    expect(body.projects.length).toBe(1);
    expect(body.projects[0]?.openIssues).toBe(9);
    expect(body.projects[0]?.description).toBe(project.description);
    await Promise.all(waits);
    const metadataTarget = ((await storedRefreshTarget(metadataKey)) ?? {}) as RefreshTarget;
    expect(metadataTarget.key).toBe(metadataKey);
    expect(metadataTarget.includeReleaseData).toBe(false);
    expect(await storedRefreshTarget(releaseKey)).toBe(null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner metadata does not overwrite newer dashboard counts", async () => {
  const now = new Date().toISOString();
  const newerMetadataAt = new Date(Date.now() + 1_000).toISOString();
  const staleCountsAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const cached: DashboardPayload = {
    ...testDashboard("owner", [project]),
    generatedAt: now,
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: now,
      countsUpdatedAt: now,
    },
  };
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: newerMetadataAt,
      metadataUpdatedAt: newerMetadataAt,
      countsUpdatedAt: staleCountsAt,
      releaseDataComplete: true,
      knownRepos: [project.fullName.toLowerCase()],
      projects: [{ ...project, description: "new metadata", openIssues: 9 }],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify(cached),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects[0]?.description).toBe("new metadata");
  expect(body.projects[0]?.openIssues).toBe(1);
  expect(body.cache?.countsUpdatedAt).toBe(now);
});

test("owner metadata compares count snapshots against count freshness", async () => {
  const countsAt = "2026-06-11T01:00:00Z";
  const snapshotAt = "2026-06-11T02:00:00Z";
  const generatedAt = "2026-06-11T03:00:00Z";
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: snapshotAt,
      metadataUpdatedAt: snapshotAt,
      countsUpdatedAt: snapshotAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": snapshotAt },
      projectCountsUpdatedAt: { "owner/repo": snapshotAt },
      projects: [{ ...project, openIssues: 9 }],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify({
      ...testDashboard("owner", [project]),
      generatedAt,
      cache: {
        state: "partial",
        stale: true,
        capped: false,
        repoLimit: 200,
        generatedAt,
        countsUpdatedAt: countsAt,
      },
    } satisfies DashboardPayload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects[0]?.openIssues).toBe(9);
  expect(body.cache?.countsUpdatedAt).toBe(snapshotAt);
  expect(body.cache?.projectCountsUpdatedAt?.["owner/repo"]).toBe(snapshotAt);
});

test("owner count overlays update repositories absent from a narrow metadata snapshot", async () => {
  const cachedAt = new Date(Date.now() - 60_000).toISOString();
  const observedAt = new Date().toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const cachedProject = testProject({
    owner: "owner",
    name: "outside-filter",
    archived: false,
    openIssues: 1,
  });
  const narrowProject = testProject({ owner: "owner", name: "inside-filter" });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: cachedAt,
      metadataUpdatedAt: cachedAt,
      countsUpdatedAt: cachedAt,
      releaseDataComplete: true,
      knownRepos: null,
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/inside-filter": cachedAt },
      projectCountsUpdatedAt: { "owner/inside-filter": cachedAt },
      projects: [narrowProject],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify({
      ...testDashboard("owner", [cachedProject]),
      generatedAt: cachedAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: cachedAt,
        countsUpdatedAt: cachedAt,
      },
    } satisfies DashboardPayload),
  });
  const response = await ownerMetadataMutator("owner")({
    kind: "counts",
    updatedAt: observedAt,
    complete: true,
    counts: [
      {
        fullName: "owner/inside-filter",
        openIssues: 0,
        openPullRequests: 0,
        archived: false,
        fork: false,
        private: false,
        pushedAt: observedAt,
        updatedAt: observedAt,
      },
      {
        fullName: "owner/outside-filter",
        openIssues: 9,
        openPullRequests: 2,
        archived: true,
        fork: false,
        private: false,
        pushedAt: observedAt,
        updatedAt: observedAt,
      },
    ],
  });
  assert(response);

  const dashboard = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    {
      waitUntil: () => undefined,
    },
  );
  expect(dashboard.status).toBe(200);
  expect(((await dashboard.json()) as DashboardPayload).projects.length).toBe(0);
  const snapshot = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as {
    countOverlays?: Record<string, { archived?: boolean; openIssues?: number }>;
  };
  expect(snapshot.countOverlays?.["owner/outside-filter"]?.archived).toBe(true);
  expect(snapshot.countOverlays?.["owner/outside-filter"]?.openIssues).toBe(9);
});

test("owner snapshots only advance count freshness when they cover every displayed repository", async () => {
  const cachedAt = "2026-06-11T03:00:00Z";
  const snapshotAt = "2026-06-11T04:00:00Z";
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const repo = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const sibling = testProject({ owner: "owner", name: "sibling", openIssues: 2 });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: snapshotAt,
      metadataUpdatedAt: cachedAt,
      countsUpdatedAt: snapshotAt,
      releaseDataComplete: true,
      knownRepos: null,
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": cachedAt },
      projects: [{ ...repo, openIssues: 9 }],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: cachedAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: cachedAt,
        countsUpdatedAt: cachedAt,
      },
    } satisfies DashboardPayload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.find((project) => project.name === "repo")?.openIssues).toBe(9);
  expect(body.projects.find((project) => project.name === "sibling")?.openIssues).toBe(2);
  expect(body.cache?.countsUpdatedAt).toBe(cachedAt);
});

test("partial owner count scans expose matched repository counts without advancing global freshness", async () => {
  const initialAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const dashboardAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const partialAt = new Date().toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const repo = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  const sibling = testProject({ owner: "owner", name: "sibling", openIssues: 2 });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: initialAt,
      metadataUpdatedAt: initialAt,
      countsUpdatedAt: initialAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo", "owner/sibling"],
      removedRepos: {},
      projectMetadataUpdatedAt: {
        "owner/repo": initialAt,
        "owner/sibling": initialAt,
      },
      projectCountsUpdatedAt: {
        "owner/repo": initialAt,
        "owner/sibling": initialAt,
      },
      projects: [repo, sibling],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: dashboardAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: dashboardAt,
        countsUpdatedAt: initialAt,
      },
    } satisfies DashboardPayload),
  });
  const mutation = await ownerMetadataMutator("owner")({
    kind: "counts",
    updatedAt: partialAt,
    complete: false,
    counts: [
      {
        fullName: "owner/repo",
        openIssues: 9,
        openPullRequests: 3,
        archived: false,
        fork: false,
        private: false,
        pushedAt: partialAt,
        updatedAt: partialAt,
      },
    ],
  });
  assert(mutation);

  const snapshot = mutation;
  expect(snapshot.countsUpdatedAt).toBe(initialAt);
  expect(snapshot.projectCountsUpdatedAt?.["owner/repo"]).toBe(partialAt);
  expect(snapshot.projectCountsUpdatedAt?.["owner/sibling"]).toBe(initialAt);

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    {
      waitUntil: () => undefined,
    },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.find((project) => project.name === "repo")?.openIssues).toBe(9);
  expect(body.projects.find((project) => project.name === "sibling")?.openIssues).toBe(2);
  expect(body.cache?.countsUpdatedAt).toBe(initialAt);
});

test("stale archive observations do not override newer count observations", async () => {
  const metadataAt = "2026-06-11T01:00:00Z";
  const archiveAt = "2026-06-11T02:00:00Z";
  const countsAt = "2026-06-11T03:00:00Z";
  const project = testProject({ owner: "owner", name: "repo", archived: false });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: countsAt,
      metadataUpdatedAt: metadataAt,
      countsUpdatedAt: countsAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": metadataAt },
      projectCountsUpdatedAt: { "owner/repo": countsAt },
      projects: [project],
    }),
  );
  await cacheWith({});
  const response = await ownerMetadataMutator("owner")({
    kind: "visibility",
    fullName: "owner/repo",
    archived: true,
    observedAt: archiveAt,
    repositoryUpdatedAt: archiveAt,
  });
  assert(response);
  const snapshot = response;
  expect(snapshot.projects?.[0]?.archived).toBe(false);
});

test("partial owner count scans cannot make an incomplete repository set authoritative", async () => {
  const initialAt = "2026-06-11T01:00:00Z";
  const partialAt = "2026-06-11T02:00:00Z";
  const repo = testProject({ owner: "owner", name: "repo" });
  const newlyDiscovered = testProject({ owner: "owner", name: "new" });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: initialAt,
      metadataUpdatedAt: initialAt,
      countsUpdatedAt: initialAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: {
        "owner/repo": initialAt,
        "owner/new": initialAt,
      },
      projectCountsUpdatedAt: {
        "owner/repo": initialAt,
        "owner/new": initialAt,
      },
      projects: [repo, newlyDiscovered],
    }),
  );
  await cacheWith({});
  const response = await ownerMetadataMutator("owner")({
    kind: "counts",
    updatedAt: partialAt,
    complete: false,
    counts: [repo, newlyDiscovered].map((project) => ({
      fullName: project.fullName,
      openIssues: 1,
      openPullRequests: 0,
      archived: false,
      fork: false,
      private: false,
      pushedAt: partialAt,
      updatedAt: partialAt,
    })),
  });
  assert(response);
  const snapshot = response;
  expect(snapshot.countsUpdatedAt).toBe(initialAt);
  expect(snapshot.countsAttemptedAt).toBe(partialAt);
  expect(snapshot.knownRepos).toStrictEqual(["owner/repo"]);
});

test("combined dashboards do not merge counts using another owner's oldest timestamp", async () => {
  const generatedAt = new Date().toISOString();
  const oldestOwnerCountAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const intermediateCountAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    owners: ["other"],
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const ownerProject = testProject({ owner: "owner", name: "repo", openIssues: 10 });
  const otherProject = testProject({ owner: "other", name: "repo", openIssues: 2 });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: intermediateCountAt,
      metadataUpdatedAt: intermediateCountAt,
      countsUpdatedAt: intermediateCountAt,
      releaseDataComplete: true,
      knownRepos: ["owner/repo"],
      removedRepos: {},
      projectMetadataUpdatedAt: { "owner/repo": intermediateCountAt },
      projects: [{ ...ownerProject, openIssues: 3 }],
    }),
  );
  await cacheWith({
    "owner:v1:owner": JSON.stringify({ type: "user", login: "owner" }),
    "owner:v1:other": JSON.stringify({ type: "user", login: "other" }),
    [key]: JSON.stringify({
      ...testDashboard("owner", [ownerProject, otherProject]),
      generatedAt,
      owners: [
        { type: "user", login: "owner" },
        { type: "user", login: "other" },
      ],
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt,
        countsUpdatedAt: oldestOwnerCountAt,
      },
    } satisfies DashboardPayload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner?owners=other"),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.find((project) => project.fullName === "owner/repo")?.openIssues).toBe(10);
  expect(body.cache?.countsUpdatedAt).toBe(oldestOwnerCountAt);
});

test("older owner snapshots do not overwrite newer dashboard fields", async () => {
  const now = new Date().toISOString();
  const olderAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const project = testProject({ owner: "owner", name: "repo", openIssues: 1 });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: olderAt,
      metadataUpdatedAt: olderAt,
      countsUpdatedAt: olderAt,
      releaseDataComplete: true,
      knownRepos: [],
      projects: [
        {
          ...project,
          description: "older metadata",
          archived: true,
          openIssues: 9,
        },
      ],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify({
      ...testDashboard("owner", [project]),
      generatedAt: now,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: now,
        countsUpdatedAt: now,
      },
    } satisfies DashboardPayload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.length).toBe(1);
  expect(body.projects[0]?.description).toBe(project.description);
  expect(body.projects[0]?.archived).toBe(false);
  expect(body.projects[0]?.openIssues).toBe(1);
});

test("targeted owner metadata updates do not refresh sibling repositories", async () => {
  const dashboardAt = new Date().toISOString();
  const olderAt = new Date(Date.parse(dashboardAt) - 60 * 60 * 1000).toISOString();
  const eventAt = new Date(Date.parse(dashboardAt) + 1_000).toISOString();
  const repo = testProject({ owner: "owner", name: "repo" });
  const sibling = testProject({ owner: "owner", name: "sibling", description: "fresh sibling" });
  const key = dashboardCacheKey({
    owner: "owner",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      owner: "owner",
      generatedAt: eventAt,
      metadataUpdatedAt: eventAt,
      countsUpdatedAt: olderAt,
      releaseDataComplete: true,
      projectMetadataUpdatedAt: {
        "owner/repo": eventAt,
        "owner/sibling": olderAt,
      },
      projects: [
        { ...repo, archived: true },
        { ...sibling, description: "stale sibling" },
      ],
    }),
  );
  await cacheWith({
    [key]: JSON.stringify({
      ...testDashboard("owner", [repo, sibling]),
      generatedAt: dashboardAt,
      cache: {
        state: "fresh",
        stale: false,
        capped: false,
        repoLimit: 200,
        generatedAt: dashboardAt,
      },
    } satisfies DashboardPayload),
  });

  const response = await worker.fetch(
    new Request("https://release.bar/api/owner"),
    {},
    { waitUntil: () => undefined },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as DashboardPayload;
  expect(body.projects.some((project) => project.fullName === "owner/repo")).toBe(false);
  expect(body.projects.find((project) => project.fullName === "owner/sibling")?.description).toBe(
    "fresh sibling",
  );
});

test("owner removal tombstones survive older refresh observations", async () => {
  const removedAt = "2026-06-11T03:00:00Z";
  const olderAt = "2026-06-11T02:00:00Z";
  const newerAt = "2026-06-11T04:00:00Z";
  await cacheWith();
  const mutate = ownerMetadataMutator("owner");

  await mutate({ kind: "remove", fullName: "owner/repo", observedAt: removedAt });
  await mutate({
    kind: "counts",
    updatedAt: olderAt,
    complete: true,
    counts: [
      {
        fullName: "owner/repo",
        openIssues: 1,
        openPullRequests: 0,
        archived: false,
        fork: false,
        private: false,
        pushedAt: newerAt,
        updatedAt: newerAt,
      },
    ],
  });
  await mutate({ kind: "restore", fullName: "owner/repo", observedAt: olderAt });
  let snapshot = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
  };
  expect(snapshot.removedRepos?.["owner/repo"]).toBe(removedAt);

  await mutate({ kind: "restore", fullName: "owner/repo", observedAt: newerAt });
  snapshot = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
  };
  expect(snapshot.removedRepos?.["owner/repo"]).toBe(undefined);
});

test("owner mutations apply to the snapshot as another writer left it", async () => {
  const initialAt = "2026-06-11T01:00:00Z";
  const removedAt = "2026-06-11T02:00:00Z";
  const followUpAt = "2026-06-11T03:00:00Z";
  const project = testProject({ owner: "owner", name: "repo" });
  await cacheWith();
  const mutate = ownerMetadataMutator("owner");

  await mutate({
    kind: "merge",
    generatedAt: initialAt,
    observedAt: initialAt,
    countsUpdatedAt: initialAt,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects: [project],
    removedRepos: [],
  });
  const fallbackSnapshot = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as Record<
    string,
    unknown
  >;
  await seedOwnerMetadata(
    "owner",
    JSON.stringify({
      ...fallbackSnapshot,
      generatedAt: removedAt,
      metadataUpdatedAt: removedAt,
      knownRepos: [],
      removedRepos: { "owner/repo": removedAt },
      projectMetadataUpdatedAt: { "owner/repo": removedAt },
      projects: [],
    }),
  );

  const snapshot = await mutate({
    kind: "counts",
    updatedAt: followUpAt,
    complete: false,
    counts: [],
  });
  assert(snapshot);
  expect(snapshot.removedRepos?.["owner/repo"]).toBe(removedAt);
  expect(snapshot.projects?.some((candidate) => candidate.fullName === project.fullName)).toBe(
    false,
  );
});
