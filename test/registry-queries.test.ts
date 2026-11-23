// How many queries the invocations that handle many owners or accounts send to D1: the limit is
// 50 per invocation on the Workers free plan, and a batch counts as one (docs/data-model.md,
// "D1 queries per invocation"). The registry is read and written for all of them at once.
import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { RefreshJob, RefreshTarget } from "../src/types.ts";
import {
  maxCustomSources,
  schedulerBatchLimit,
  schedulerCountOwnerLimit,
  schedulerTargetPageLimit,
} from "../worker/config.ts";
import {
  warmInstallationCaches,
  writeInstallationRegistry,
} from "../worker/installation-registry.ts";
import { syncGithubAppInstallations } from "../worker/auth-oauth.ts";
import { writeStoredInstallations } from "../worker/store/installations.ts";
import {
  kvStore,
  observedDatabase,
  seedInstallation,
  seedOwnerMetadata,
  storedInstallationJson,
  storedOwnerMetadataJson,
  storedRefreshJob,
  storedRefreshTarget,
  storedSchedulerState,
  storeRefreshJob,
  storeRefreshTargets,
  testDashboard,
  testEnv,
  testProject,
  worker,
} from "./dashboard-test-harness.ts";

// The ceiling of every invocation here: clear headroom under the 50 queries of the free plan.
const queryCeiling = 30;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const appVars = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_SLUG: "releasebar-app",
};

// A KV namespace that counts its operations, and a queue that counts its sends: what an
// invocation spends of its subrequests besides the D1 queries.
function countedBindings(initial: Record<string, string> = {}) {
  const store = kvStore(initial);
  const used = { kvReads: 0, kvWrites: 0, queueSends: 0 };
  const sent: RefreshJob[] = [];
  return {
    used,
    sent,
    store,
    DASHBOARD_CACHE: {
      get: (key: string) => {
        used.kvReads += 1;
        return store.get(key);
      },
      put: (key: string, value: string) => {
        used.kvWrites += 1;
        return store.put(key, value);
      },
      delete: (key: string) => {
        used.kvWrites += 1;
        return store.delete(key);
      },
      list: (options?: { prefix?: string; limit?: number; cursor?: string }) => {
        used.kvReads += 1;
        return store.list(options);
      },
    },
    REFRESH_QUEUE: {
      send: async (job: RefreshJob) => {
        used.queueSends += 1;
        sent.push(job);
      },
    },
  };
}

function target(owner: string, overrides: Partial<RefreshTarget> = {}): RefreshTarget {
  const now = new Date().toISOString();
  return {
    key: dashboardCacheKey({
      owner,
      includeUnreleased: true,
      includeReleaseData: true,
      schemaVersion: 6,
    }),
    kind: "dashboard",
    owner,
    owners: [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 100,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    ...overrides,
  };
}

function ownerSnapshot(owner: string, countsAttemptedAt: string) {
  const now = new Date().toISOString();
  const project = testProject({ owner, name: "repo" });
  const fullName = project.fullName.toLowerCase();
  return {
    owner,
    generatedAt: now,
    metadataUpdatedAt: now,
    countsUpdatedAt: countsAttemptedAt,
    countsAttemptedAt,
    releaseDataComplete: true,
    knownRepos: [fullName],
    privateRepos: {},
    removedRepos: {},
    projectMetadataUpdatedAt: { [fullName]: countsAttemptedAt },
    projectCountsUpdatedAt: { [fullName]: countsAttemptedAt },
    projects: [project],
  };
}

function appInstallation(id: number, accountLogin: string) {
  return {
    id,
    accountLogin,
    accountType: "org" as const,
    accountUrl: `https://github.com/${accountLogin}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id}`,
    repositorySelection: "all" as const,
    repositories: [],
    updatedAt: new Date().toISOString(),
  };
}

function ownerCountsResponse(owner: string): Response {
  return Response.json({
    data: {
      repositoryOwner: {
        repositories: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              nameWithOwner: `${owner}/repo`,
              issues: { totalCount: 7 },
              pullRequests: { totalCount: 3 },
              isArchived: false,
              isFork: false,
              isPrivate: false,
              pushedAt: "2026-06-11T00:00:00Z",
              updatedAt: "2026-06-11T01:00:00Z",
            },
          ],
        },
      },
    },
  });
}

test("a scheduler tick over many owners sends D1 a bounded number of queries", async () => {
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const freshAt = new Date().toISOString();
  // A full page of targets, each with an owner of its own and that owner's installation. The
  // owners whose counts are due come last, so the tick looks at every owner of the page first.
  const owners = Array.from(
    { length: schedulerTargetPageLimit },
    (_, index) => `owner${String(index).padStart(3, "0")}`,
  );
  const dueOwners = owners.slice(-schedulerCountOwnerLimit);
  const entries: Record<string, string> = {};
  // As many targets are due as a tick enqueues.
  const targets = owners.map((owner, index) => {
    const entry = target(owner, {
      nextDueAt: index < schedulerBatchLimit ? "2020-01-01T00:00:00Z" : "2999-01-01T00:00:00Z",
    });
    entries[entry.key] = JSON.stringify(
      testDashboard(owner, [testProject({ owner, name: "repo" })]),
    );
    return entry;
  });
  await storeRefreshTargets(targets);
  for (const [index, owner] of owners.entries()) {
    await seedOwnerMetadata(
      owner,
      ownerSnapshot(owner, dueOwners.includes(owner) ? staleAt : freshAt),
    );
    await seedInstallation(appInstallation(index + 1, owner));
    entries[`auth:installation-token:${index + 1}`] = `token-${owner}`;
  }
  const bindings = countedBindings(entries);
  const { database, counts } = observedDatabase();
  const counted: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/graphql") throw new Error(`unexpected fetch ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as {
      variables?: { login?: string };
    };
    const owner = body.variables?.login ?? "";
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer token-${owner}`);
    counted.push(owner);
    return ownerCountsResponse(owner);
  };
  try {
    const waits: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: "*/15 * * * *", scheduledTime: Date.now() },
      {
        ...appVars,
        DASHBOARD_CACHE: bindings.DASHBOARD_CACHE,
        DB: database,
        REFRESH_QUEUE: bindings.REFRESH_QUEUE,
      },
      { waitUntil: (promise) => void waits.push(promise) },
    );
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Every due owner's counts were fetched with its own installation token and stored.
  expect(counted.sort()).toStrictEqual(dueOwners);
  expect((await storedSchedulerState())?.countRefresh).toStrictEqual({
    considered: owners.length,
    refreshed: dueOwners.length,
    deferred: 0,
    failed: 0,
  });
  for (const owner of dueOwners) {
    const stored = JSON.parse((await storedOwnerMetadataJson(owner)) ?? "{}") as {
      countsAttemptedAt?: string;
      projects?: Array<{ openIssues: number | null }>;
    };
    expect(stored.countsAttemptedAt).not.toBe(staleAt);
    expect(stored.projects?.[0]?.openIssues).toBe(7);
  }
  // What D1 limits is the queries, and a batch is one. Before the registry was read and written
  // for all owners at once, this tick sent 216.
  // - Reads, a query each: the last tick's state, the jobs, the delivery records, the page of
  //   targets, the owner count cursor.
  // - The installations of the page's accounts: one batch.
  // - When each owner's counts were last asked: one batch, two statements for 120 owners.
  // - The owner count cursor: one statement.
  // - The due owners' snapshots: one batch that reads them, one that writes them.
  // - The enqueued jobs: one batch.
  // - The tick's state, 3 deletions of refresh rows, 3 of audit rows, 2 of registry rows.
  // - The audit events and the GitHub calls: one batch.
  expect(bindings.sent.length).toBe(schedulerBatchLimit);
  expect(counts.queries).toBe(5 + 1 + 1 + 1 + 2 + 1 + 1 + 3 + 3 + 2 + 1);
  expect(counts.sql.filter((sql) => sql.startsWith("UPDATE owner_metadata")).length).toBe(
    dueOwners.length,
  );
  expect(counts.queries).toBeLessThanOrEqual(queryCeiling);
  // The other subrequests: the cached dashboard of each target and the installation token of
  // each due owner are KV reads, and the hot dashboard is marked stale once.
  expect(bindings.used).toStrictEqual({
    kvReads: owners.length + dueOwners.length + 20,
    kvWrites: 1,
    queueSends: schedulerBatchLimit,
  });
});

test("a dashboard build showing many owners sends D1 a bounded number of queries", async () => {
  // As many owners as a dashboard takes: its own and the ones its profile adds.
  const owners = Array.from({ length: 1 + maxCustomSources }, (_, index) => `shown${index}`);
  const primary = owners[0] ?? "";
  const key = dashboardCacheKey({
    owner: primary,
    owners: owners.slice(1),
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const queued: RefreshJob = {
    id: "job-many-owners",
    targetKey: key,
    target: target(primary, { key, owners, nextDueAt: "2020-01-01T00:00:00Z" }),
    kind: "dashboard",
    status: "queued",
    reason: "scheduled",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    durationMs: null,
  };
  await storeRefreshJob(queued);
  const staleAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const owner of owners) await seedOwnerMetadata(owner, ownerSnapshot(owner, staleAt));
  const bindings = countedBindings();
  const { database, counts } = observedDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const owner = url.pathname.split("/")[2] ?? "";
    if (url.pathname.startsWith("/users/")) {
      return Response.json({ login: owner, type: "Organization" });
    }
    if (url.pathname === "/graphql") {
      return Response.json({
        data: {
          repositoryOwner: {
            __typename: "Organization",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  let acknowledged = false;
  try {
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
              throw new Error("the job should not retry");
            },
          },
        ],
      },
      {
        DASHBOARD_CACHE: bindings.DASHBOARD_CACHE,
        DB: database,
        GITHUB_TOKEN: "shared-token",
        REFRESH_QUEUE: bindings.REFRESH_QUEUE,
      },
      { waitUntil: (promise) => void waits.push(promise) },
    );
    await Promise.all(waits);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(acknowledged).toBe(true);
  expect((await storedRefreshJob(queued.id))?.status).toBe("succeeded");
  // The build stored what it saw of every owner: none of them has the repository any more.
  for (const owner of owners) {
    const stored = JSON.parse((await storedOwnerMetadataJson(owner)) ?? "{}") as {
      metadataUpdatedAt?: string;
    };
    expect(stored.metadataUpdatedAt).not.toBe(undefined);
  }
  // Before, this build sent 36 queries, four more for each owner. Now:
  // - The job, its delivery record, its target.
  // - The owners' snapshots: one batch that reads them and one that writes them, then one that
  //   reads what is stored for the merge.
  // - The target's state: read, two checks, one batch.
  // - The job's state, and one batch of audit events and GitHub calls.
  expect(counts.queries).toBe(3 + 3 + 4 + 2);
  expect(counts.sql.filter((sql) => sql.startsWith("UPDATE owner_metadata")).length).toBe(
    owners.length,
  );
  expect(counts.queries).toBeLessThanOrEqual(queryCeiling);
  expect(bindings.used).toStrictEqual({ kvReads: 31, kvWrites: 11, queueSends: 0 });
});

test("an install callback for an account with all repositories sends D1 a bounded number of queries", async () => {
  const bindings = countedBindings();
  const { database, counts } = observedDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/app/installations/101") {
      return Response.json({
        id: 101,
        account: {
          login: "outside-org",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/101",
          html_url: "https://github.com/outside-org",
        },
        html_url: "https://github.com/organizations/outside-org/settings/installations/101",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const waits: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=101&setup_action=install"),
      {
        ...appVars,
        AUTH_COOKIE_SECRET: "test-secret",
        DASHBOARD_CACHE: bindings.DASHBOARD_CACHE,
        DB: database,
        REFRESH_QUEUE: bindings.REFRESH_QUEUE,
      },
      { waitUntil: (promise) => void waits.push(promise) },
    );
    await Promise.all(waits);
    expect(response.status).toBe(302);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const remembered = JSON.parse((await storedInstallationJson("outside-org")) ?? "{}") as {
    id?: number;
  };
  expect(remembered.id).toBe(101);
  // The account's dashboard is a refresh target, and a job warms its cache.
  const key = dashboardCacheKey({
    owner: "outside-org",
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  expect((await storedRefreshTarget(key))?.owner).toBe("outside-org");
  expect(bindings.sent.map((job) => job.targetKey)).toStrictEqual([key]);
  // - The two funnel events: a batch each.
  // - The registry: the stored installation, the write, then the account's profile, the
  //   installations its dashboard needs, and its target (read, limits, write).
  // - The warm-up: profile, installations and target again, then the job and its audit event.
  expect(counts.queries).toBe(2 + 7 + 5 + 2);
  expect(counts.queries).toBeLessThanOrEqual(queryCeiling);
  expect(bindings.used).toStrictEqual({ kvReads: 1, kvWrites: 0, queueSends: 1 });
});

test("the installations of many accounts are stored with a bounded number of queries", async () => {
  // A sign-in of a user whose accounts all installed the app for all repositories: the registry
  // is written, each account's dashboard becomes a refresh target, and its cache is warmed.
  const accounts = Array.from({ length: 30 }, (_, index) => `account${index}`);
  const installations = accounts.map((account, index) => appInstallation(index + 1, account));
  const bindings = countedBindings();
  const { database, counts } = observedDatabase();
  const env = testEnv({
    ...appVars,
    DASHBOARD_CACHE: bindings.DASHBOARD_CACHE,
    DB: database,
    REFRESH_QUEUE: bindings.REFRESH_QUEUE,
  });
  const waits: Promise<unknown>[] = [];
  const context = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise) };

  await writeInstallationRegistry(env, installations);
  const written = counts.queries;
  await warmInstallationCaches(env, context, installations);
  await Promise.all(waits);

  for (const account of accounts) {
    expect(JSON.parse((await storedInstallationJson(account)) ?? "{}").accountLogin).toBe(account);
    const key = dashboardCacheKey({
      owner: account,
      includeUnreleased: true,
      includeReleaseData: true,
      schemaVersion: 6,
    });
    expect((await storedRefreshTarget(key))?.includeReleaseData).toBe(true);
  }
  expect(bindings.sent.map((job) => job.reason)).toStrictEqual(
    accounts.map(() => "installation-warm"),
  );
  // Before, writing the registry alone sent 240 queries, eight for each account.
  // - The registry: the stored installations, their writes in one batch, the profiles, the
  //   installations again, and the targets (read, limits, one batch).
  // - The warm-up: profiles, installations, the targets (read, limits, one batch), two
  //   batches of 25 jobs.
  // - The audit event of each job is written by itself here, because no handler collects them:
  //   in an invocation of the Worker they are one batch.
  const audited = counts.sql.filter((sql) => sql.startsWith("INSERT INTO refresh_audit_events"));
  expect(audited.length).toBe(accounts.length);
  const queries = counts.queries - audited.length + 1;
  expect(written).toBe(1 + 1 + 2 + 3);
  expect(queries - written).toBe(2 + 3 + 2 + 1);
  expect(queries).toBeLessThanOrEqual(queryCeiling);
  // A cached dashboard read and a queue send for each account.
  expect(bindings.used).toStrictEqual({
    kvReads: accounts.length,
    kvWrites: 0,
    queueSends: accounts.length,
  });

  // Written again at once, nothing is stale: one read.
  counts.queries = 0;
  await writeInstallationRegistry(env, installations);
  expect(counts.queries).toBe(1);
});

test("the installation sync of as many installations as GitHub lists stays within the free plan's D1 queries", async () => {
  // GitHub's listing is read to 10 pages of 100, and a full tenth page fails the sync: 999
  // installations are the most one sync stores. Here every one of them is new, installed for all
  // repositories, so each also becomes a refresh target; and 999 others are stored that GitHub no
  // longer lists, so each is deleted and recorded as removed.
  const fresh = Array.from({ length: 999 }, (_, index) => `fresh${index}`);
  const gone = Array.from({ length: 999 }, (_, index) =>
    appInstallation(5000 + index, `gone${index}`),
  );
  await writeStoredInstallations(testEnv({}), gone);
  const { database, counts } = observedDatabase();
  const bindings = countedBindings();
  const env = testEnv({
    ...appVars,
    DASHBOARD_CACHE: bindings.DASHBOARD_CACHE,
    DB: database,
    REFRESH_QUEUE: bindings.REFRESH_QUEUE,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname !== "/app/installations") throw new Error(`unexpected fetch ${url.pathname}`);
    const page = Number(url.searchParams.get("page"));
    return Response.json(
      fresh.slice((page - 1) * 100, page * 100).map((login, index) => ({
        id: (page - 1) * 100 + index + 1,
        account: {
          login,
          type: "Organization",
          avatar_url: `https://avatars.githubusercontent.com/u/${index}`,
          html_url: `https://github.com/${login}`,
        },
        html_url: `https://github.com/organizations/${login}/settings/installations/${index}`,
        repository_selection: "all",
        target_type: "Organization",
      })),
    );
  };
  try {
    const stored = await syncGithubAppInstallations(env);

    expect(stored.length).toBe(999);
    expect(new Set(stored.map((installation) => installation.accountLogin))).toStrictEqual(
      new Set(fresh),
    );
    // - The stored installations, listed before and after: 4 pages of 250 each time.
    // - The removed ones: 1 deletion, and their funnel events in 4 batches of 250.
    // - The registry: the stored installations, 10 batches of 100 writes, the profiles, the
    //   installations again, and the targets (read, limits, 10 batches of 100).
    // - The funnel event of the sync.
    expect(counts.queries).toBe(8 + 5 + 14 + 11 + 1);
    expect(counts.queries).toBeLessThan(50);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a dashboard request sends D1 a bounded number of queries", async () => {
  const owner = "visited";
  const key = dashboardCacheKey({
    owner,
    includeUnreleased: true,
    includeReleaseData: true,
    schemaVersion: 6,
  });
  const request = async (cached: Record<string, string>) => {
    const { database, counts } = observedDatabase();
    const bindings = countedBindings({
      [`owner:v1:${owner}`]: JSON.stringify({ type: "user", login: owner }),
      ...cached,
    });
    const waits: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request(`https://release.bar/api/${owner}`),
      {
        DASHBOARD_CACHE: bindings.DASHBOARD_CACHE,
        DB: database,
        REFRESH_QUEUE: bindings.REFRESH_QUEUE,
      },
      { waitUntil: (promise) => void waits.push(promise) },
    );
    await Promise.all(waits);
    expect(response.status).toBe(200);
    return { counts, used: bindings.used, sent: bindings.sent };
  };
  const dashboard = (generatedAt: string, state: "fresh" | "stale") =>
    JSON.stringify({
      ...testDashboard(owner, [testProject({ owner, name: "repo" })]),
      generatedAt,
      cache: {
        state,
        stale: state === "stale",
        capped: false,
        repoLimit: 200,
        generatedAt,
        countsUpdatedAt: generatedAt,
        projectCountsUpdatedAt: { [`${owner}/repo`]: generatedAt },
        releasesUpdatedAt: generatedAt,
        ciUpdatedAt: generatedAt,
      },
    });

  // A dashboard in the cache that is a day old: it is served, its target is stored and a job
  // is enqueued to refresh it.
  const stale = await request({
    [key]: dashboard(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), "stale"),
  });
  // The profile, the owner's metadata, the target (read, whether it is stored, the limits of
  // its sources, the write), the job, and one batch of audit events.
  expect(stale.counts.queries).toBe(2 + 4 + 1 + 1);
  expect(stale.sent.length).toBe(1);
  expect(stale.used).toStrictEqual({ kvReads: 2, kvWrites: 0, queueSends: 1 });

  // The same dashboard, fresh, a moment later: it is served, and its target is seen again.
  const fresh = await request({ [key]: dashboard(new Date().toISOString(), "fresh") });
  // The same without the limits, which only a new target is checked against, and the job.
  expect(fresh.counts.queries).toBe(2 + 3 + 1);
  expect(fresh.sent.length).toBe(0);
  expect(fresh.used).toStrictEqual({ kvReads: 2, kvWrites: 0, queueSends: 0 });
});
