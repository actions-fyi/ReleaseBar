import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { DashboardProfile, Project, RefreshTarget } from "../src/types.ts";
import { createStoredSession } from "../worker/store/sessions.ts";
import {
  writeCachedInstallationToken,
  writeStoredInstallation,
} from "../worker/store/installations.ts";
import { appendAuthFunnelEvent } from "../worker/store/auth-funnel.ts";
import {
  authFunnelEventCount,
  cacheWith,
  seedInstallation,
  ownerMetadataMutator,
  seedProfile,
  signedJson,
  storedInstallationJson,
  storedOwnerMetadataJson,
  storedProfileSnapshot,
  storedRefreshTarget,
  storeProfileSnapshot,
  storeRefreshTarget,
  testDashboard,
  testDatabase,
  testEnv,
  testProject,
  testQueue,
  webhookSignature,
  worker,
} from "./dashboard-test-harness.ts";

const secret = "account-webhook-secret";
const context = { waitUntil: () => undefined };

function storedSession(userId: number, login: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: {
      id: userId,
      login,
      name: null,
      avatarUrl: `https://avatars.githubusercontent.com/u/${userId}`,
      url: `https://github.com/${login}`,
    },
    accessToken: `token-${userId}`,
    refreshToken: `refresh-${userId}`,
    iat: now,
    exp: now + 600,
    installations: [],
  };
}

async function sendWebhook(
  event: string,
  delivery: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request("https://release.bar/api/github/webhook", {
      method: "POST",
      body,
      headers: {
        "x-github-delivery": delivery,
        "x-github-event": event,
        "x-hub-signature-256": await webhookSignature(secret, body),
      },
    }),
    { GITHUB_WEBHOOK_SECRET: secret },
    context,
  );
}

function seedProjects(owner: string, projects: Project[]): Promise<unknown> {
  const now = new Date().toISOString();
  return ownerMetadataMutator(owner)({
    kind: "merge",
    generatedAt: now,
    observedAt: now,
    countsUpdatedAt: now,
    countsComplete: true,
    releaseDataComplete: true,
    mode: "hydrated",
    projects,
    removedRepos: [],
  });
}

function installation(id: number, accountLogin: string) {
  return {
    id,
    accountLogin,
    accountType: "user" as const,
    accountUrl: `https://github.com/${accountLogin}`,
    avatarUrl: `https://github.com/${accountLogin}.png`,
    repositorySelection: "all" as const,
    repositories: [],
    updatedAt: new Date().toISOString(),
  };
}

test("an uninstall webhook deletes the installation and its token, by the installation's id", async () => {
  const cache = await cacheWith();
  const queue = testQueue();
  const env = testEnv({ GITHUB_WEBHOOK_SECRET: secret });
  await seedInstallation(installation(11, "octocat"));
  await seedInstallation(installation(22, "reinstalled"));
  await writeCachedInstallationToken(env, 11, "installation-token");

  const response = await sendWebhook("installation", "uninstall-1", {
    action: "deleted",
    installation: { id: 11, account: { login: "Octocat", avatar_url: "https://x/a.png" } },
    sender: { id: 5, login: "octocat" },
    repositories: [{ full_name: "octocat/private", private: true }],
  });
  expect(response.status).toBe(202);
  expect(await response.json()).toStrictEqual({ ok: true });
  // The queue carries the installation and its account, nothing else of the payload.
  expect(queue.sent.map((message) => (message.body as { payload: unknown }).payload)).toStrictEqual(
    [{ action: "deleted", installation: { id: 11, account: { login: "octocat" } } }],
  );
  await queue.deliver({ GITHUB_WEBHOOK_SECRET: secret }, context);

  expect(await storedInstallationJson("octocat")).toBe(null);
  expect(await cache.get("auth:installation-token:11")).toBe(null);
  expect(await cache.get("auth:installation-miss:v1:octocat")).not.toBe(null);
  expect(await authFunnelEventCount()).toBe(1);

  // The account installed the app again since: the uninstall of the old id leaves the new one.
  await sendWebhook("installation", "uninstall-2", {
    action: "deleted",
    installation: { id: 21, account: { login: "reinstalled" } },
  });
  await queue.deliver({ GITHUB_WEBHOOK_SECRET: secret }, context);
  expect(await storedInstallationJson("reinstalled")).not.toBe(null);
  expect(await cache.get("auth:installation-miss:v1:reinstalled")).toBe(null);

  // Other installation events are not taken.
  const created = await sendWebhook("installation", "install-1", {
    action: "created",
    installation: { id: 33, account: { login: "octocat" } },
  });
  expect(await created.json()).toStrictEqual({ ok: true, ignored: true });
});

test("a revoked authorization deletes every session of the user and no other", async () => {
  const cache = await cacheWith();
  const queue = testQueue();
  const env = testEnv({ GITHUB_WEBHOOK_SECRET: secret });
  await createStoredSession(env, "one", storedSession(12, "octocat"), 600);
  await createStoredSession(env, "two", storedSession(12, "octocat"), 600);
  await createStoredSession(env, "other", storedSession(123, "hubot"), 600);

  const response = await sendWebhook("github_app_authorization", "revoke-1", {
    action: "revoked",
    sender: { id: 12, login: "octocat", email: "octocat@example.com" },
  });
  expect(response.status).toBe(202);
  expect(queue.sent.map((message) => (message.body as { payload: unknown }).payload)).toStrictEqual(
    [{ action: "revoked", sender: { id: 12, login: "octocat" } }],
  );
  await queue.deliver({ GITHUB_WEBHOOK_SECRET: secret }, context);

  expect(await cache.get("auth:session:one")).toBe(null);
  expect(await cache.get("auth:session:two")).toBe(null);
  expect((await cache.list({ prefix: "auth:user-session:12:" })).keys).toStrictEqual([]);
  expect(await cache.get("auth:session:other")).not.toBe(null);
  expect((await cache.list({ prefix: "auth:user-session:123:" })).keys.length).toBe(1);
});

test("logging out deletes the session and its listing", async () => {
  const cache = await cacheWith();
  const env = testEnv({ AUTH_COOKIE_SECRET: "cookie-secret" });
  const session = storedSession(7, "octocat");
  await createStoredSession(env, "seven", session, 600);
  const response = await worker.fetch(
    new Request("https://release.bar/api/auth/logout", {
      headers: {
        cookie: `rd_session=${await signedJson("cookie-secret", { id: "seven", exp: session.exp })}`,
      },
    }),
    { AUTH_COOKIE_SECRET: "cookie-secret" },
    context,
  );
  expect(response.status).toBe(302);
  expect(await cache.get("auth:session:seven")).toBe(null);
  expect((await cache.list({ prefix: "auth:user-session:" })).keys).toStrictEqual([]);
});

test("DELETE /api/me deletes what is stored for the account and signs the browser out", async () => {
  const cache = await cacheWith();
  const cookieSecret = "cookie-secret";
  const env = testEnv({ AUTH_COOKIE_SECRET: cookieSecret });
  const session = storedSession(42, "Octocat");
  await createStoredSession(env, "current", session, 600);
  await createStoredSession(env, "elsewhere", session, 600);
  await createStoredSession(env, "other", storedSession(43, "hubot"), 600);

  const profile: DashboardProfile = {
    owner: "octocat",
    includeOwners: ["acme"],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
    updatedBy: "octocat",
  };
  const otherProfile: DashboardProfile = { ...profile, owner: "octocat2", updatedBy: "octocat2" };
  await seedProfile(profile);
  await seedProfile(otherProfile);
  const snapshotKey = await storeProfileSnapshot(profile);
  const otherSnapshotKey = await storeProfileSnapshot(otherProfile);

  const now = new Date().toISOString();
  const target = (owner: string, profileSnapshotKey: string | null): RefreshTarget => ({
    key: dashboardCacheKey({
      owner,
      owners: profileSnapshotKey ? ["acme"] : [],
      includeUnreleased: true,
      includeReleaseData: true,
      schemaVersion: 6,
    }),
    kind: "dashboard",
    owner,
    owners: profileSnapshotKey ? [owner, "acme"] : [owner],
    repos: [],
    includeReleaseData: true,
    path: `/${owner}`,
    priority: 80,
    lastSeenAt: now,
    lastAttemptAt: null,
    lastSuccessAt: now,
    nextDueAt: "2999-01-01T00:00:00Z",
    failureCount: 0,
    ...(profileSnapshotKey ? { profileSnapshotKey } : {}),
  });
  const profileTarget = target("octocat", snapshotKey);
  const publicTarget = target("octocat", null);
  const otherTarget = target("octocat2", otherSnapshotKey);
  for (const stored of [profileTarget, publicTarget, otherTarget]) {
    await storeRefreshTarget(stored);
    await cache.put(stored.key, JSON.stringify(testDashboard(stored.owner, [])));
  }

  await writeStoredInstallation(env, installation(11, "octocat"));
  await writeStoredInstallation(env, installation(12, "hubot"));
  await writeCachedInstallationToken(env, 11, "installation-token");
  for (const account of ["octocat", "hubot"]) {
    await appendAuthFunnelEvent(env, {
      id: `event-${account}`,
      at: now,
      event: "login_completed",
      account,
      installationId: null,
      repositorySelection: null,
      status: "ok",
      detail: null,
    });
  }
  await seedProjects("octocat", [testProject({ owner: "octocat", name: "repo" })]);

  const cookie = `rd_session=${await signedJson(cookieSecret, { id: "current", exp: session.exp })}`;
  const anonymous = await worker.fetch(
    new Request("https://release.bar/api/me", { method: "DELETE" }),
    { AUTH_COOKIE_SECRET: cookieSecret },
    context,
  );
  expect(anonymous.status).toBe(401);
  expect(await cache.get("auth:session:current")).not.toBe(null);

  const response = await worker.fetch(
    new Request("https://release.bar/api/me", { method: "DELETE", headers: { cookie } }),
    { AUTH_COOKIE_SECRET: cookieSecret },
    context,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({ deleted: true });
  expect(response.headers.get("set-cookie")).toMatch(/^rd_session=; .*Max-Age=0/);

  // Sessions and tokens.
  expect(await cache.get("auth:session:current")).toBe(null);
  expect(await cache.get("auth:session:elsewhere")).toBe(null);
  expect((await cache.list({ prefix: "auth:user-session:42:" })).keys).toStrictEqual([]);
  expect(await cache.get("auth:session:other")).not.toBe(null);
  expect(await cache.get("auth:installation-token:11")).toBe(null);

  // The profile, its snapshots and the dashboards built with them.
  const profiles = await testDatabase
    .prepare("SELECT owner FROM profiles")
    .all<{ owner: string }>();
  expect(profiles.results).toStrictEqual([{ owner: "octocat2" }]);
  expect(await storedProfileSnapshot(snapshotKey)).toBe(null);
  expect(await storedProfileSnapshot(otherSnapshotKey)).not.toBe(null);
  expect(await storedRefreshTarget(profileTarget.key)).toBe(null);
  expect(await cache.get(profileTarget.key)).toBe(null);
  expect(await storedRefreshTarget(otherTarget.key)).not.toBe(null);
  expect(await cache.get(otherTarget.key)).not.toBe(null);

  // The installation and the sign-in events.
  expect(await storedInstallationJson("octocat")).toBe(null);
  expect(await storedInstallationJson("hubot")).not.toBe(null);
  const events = await testDatabase
    .prepare("SELECT account FROM auth_funnel_events")
    .all<{ account: string }>();
  expect(events.results).toStrictEqual([{ account: "hubot" }]);
  const counts = await testDatabase
    .prepare("SELECT account FROM auth_funnel_counts")
    .all<{ account: string }>();
  expect(counts.results).toStrictEqual([{ account: "hubot" }]);

  // GitHub's public data about the account stays: a dashboard shows it for any public account.
  expect(await storedRefreshTarget(publicTarget.key)).not.toBe(null);
  expect(await storedOwnerMetadataJson("octocat")).not.toBe(null);

  const again = await worker.fetch(
    new Request("https://release.bar/api/me", { method: "DELETE", headers: { cookie } }),
    { AUTH_COOKIE_SECRET: cookieSecret },
    context,
  );
  expect(again.status).toBe(401);
});

test("a deleted repository leaves the owner's metadata and comes back when created again", async () => {
  await cacheWith();
  const queue = testQueue();
  const project = testProject({ owner: "owner", name: "repo" });
  await seedProjects("owner", [project, testProject({ owner: "owner", name: "kept" })]);
  const names = async (): Promise<string[]> => {
    const snapshot = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as {
      projects?: Array<{ fullName: string }>;
    };
    return (snapshot.projects ?? []).map((stored) => stored.fullName);
  };
  assert.deepStrictEqual((await names()).sort(), ["owner/kept", "owner/repo"]);

  const deletedAt = new Date(Date.now() + 1000).toISOString();
  await sendWebhook("repository", "repo-deleted", {
    action: "deleted",
    repository: { full_name: "owner/repo", private: false, updated_at: deletedAt },
  });
  await queue.deliver({ GITHUB_WEBHOOK_SECRET: secret }, context);
  expect(await names()).toStrictEqual(["owner/kept"]);
  const removed = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
  };
  expect(removed.removedRepos?.["owner/repo"]).toBe(deletedAt);

  await sendWebhook("repository", "repo-created", {
    action: "created",
    repository: {
      full_name: "owner/repo",
      private: false,
      updated_at: new Date(Date.now() + 2000).toISOString(),
    },
  });
  await queue.deliver({ GITHUB_WEBHOOK_SECRET: secret }, context);
  const restored = JSON.parse((await storedOwnerMetadataJson("owner")) ?? "{}") as {
    removedRepos?: Record<string, string>;
    privateRepos?: Record<string, string>;
  };
  expect(restored.removedRepos?.["owner/repo"]).toBe(undefined);
  expect(restored.privateRepos?.["owner/repo"]).toBe(undefined);
});
