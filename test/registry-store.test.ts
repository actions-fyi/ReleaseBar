// The registry tables of the D1 database (migrations/0003_registry.sql), through the store
// functions the Worker uses: installations, owner metadata and dashboard profiles.
import { env as runtimeEnv } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { DashboardProfile } from "../src/types.ts";
import type { OwnerMetadataMutation, OwnerMetadataSnapshot } from "../worker/config.ts";
import { repositoryPublicCacheBarrier, readOwnerMetadata } from "../worker/owner-metadata-read.ts";
import {
  mutateOwnerMetadataSnapshot,
  readCachedWithOwnerMetadata,
} from "../worker/owner-metadata-write.ts";
import { deleteExpiredRegistryRows } from "../worker/registry-expiry.ts";
import {
  deleteExpiredInstallations,
  deleteStoredInstallation,
  listStoredInstallations,
  readStoredInstallation,
  type StoredInstallationRecord,
  writeStoredInstallation,
} from "../worker/store/installations.ts";
import { deleteExpiredOwnerMetadata } from "../worker/store/owner-metadata.ts";
import { deleteProfile, readProfile, writeStoredProfile } from "../worker/store/profiles.ts";
import {
  kvStore,
  observedDatabase,
  seedOwnerMetadata,
  storedOwnerMetadataJson,
  testDashboard,
  testEnv,
  testProject,
} from "./dashboard-test-harness.ts";

const day = 24 * 60 * 60 * 1000;

function installation(
  id: number,
  accountLogin: string,
  overrides: Partial<StoredInstallationRecord> = {},
): StoredInstallationRecord {
  return {
    id,
    accountLogin,
    accountType: "org",
    accountUrl: `https://github.com/${accountLogin}`,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id}`,
    repositorySelection: "selected",
    repositories: [`${accountLogin}/repo`],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function storedSnapshot(owner: string): Promise<OwnerMetadataSnapshot> {
  return storedOwnerMetadataJson(owner).then(
    (json) => JSON.parse(json ?? "{}") as OwnerMetadataSnapshot,
  );
}

test("concurrent conflicting owner metadata mutations are all applied", async () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 5, 11, 0, minutes)).toISOString();
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // Several rounds, each with its own owner: every round starts all its mutations at once, so
  // all of them read the same revision and all but one must be applied again.
  for (let round = 0; round < 4; round += 1) {
    const owner = `owner${round}`;
    const observed = observedDatabase();
    const env = testEnv({ DASHBOARD_CACHE: kvStore(), DB: observed.database });
    const mutate = (mutation: OwnerMetadataMutation) =>
      mutateOwnerMetadataSnapshot(env, owner, mutation);
    const merge = (minutes: number, repos: string[]): OwnerMetadataMutation => ({
      kind: "merge",
      generatedAt: at(minutes),
      observedAt: at(minutes),
      countsUpdatedAt: null,
      countsComplete: false,
      releaseDataComplete: false,
      mode: "metadata",
      projects: repos.map((name) => testProject({ owner, name })),
      removedRepos: [],
    });
    await mutate(merge(1, names));
    await mutate({ kind: "remove", fullName: `${owner}/e`, observedAt: at(2) });
    await mutate({ kind: "remove", fullName: `${owner}/f`, observedAt: at(2) });
    observed.counts.sql.length = 0;

    const mutations: OwnerMetadataMutation[] = [
      { kind: "remove", fullName: `${owner}/a`, observedAt: at(10) },
      { kind: "remove", fullName: `${owner}/b`, observedAt: at(10) },
      { kind: "remove", fullName: `${owner}/c`, observedAt: at(10) },
      { kind: "restore", fullName: `${owner}/e`, observedAt: at(10) },
      { kind: "restore", fullName: `${owner}/f`, observedAt: at(10) },
      {
        kind: "visibility",
        fullName: `${owner}/d`,
        archived: true,
        observedAt: at(10),
        repositoryUpdatedAt: at(10),
      },
      merge(10, ["new"]),
      // A stale build that still lists the repositories being removed.
      merge(0, ["a", "b", "c"]),
    ];
    const results = await Promise.all(mutations.map(mutate));

    expect(results.every((result) => result !== null)).toBe(true);
    const writes = observed.counts.sql.filter((sql) => sql.includes("UPDATE owner_metadata"));
    // More writes were tried than there are mutations: they did conflict.
    expect(writes.length).toBeGreaterThan(mutations.length);
    const snapshot = await storedSnapshot(owner);
    expect(Object.keys(snapshot.privateRepos).sort()).toStrictEqual([
      `${owner}/a`,
      `${owner}/b`,
      `${owner}/c`,
    ]);
    expect(Object.keys(snapshot.removedRepos).sort()).toStrictEqual([
      `${owner}/a`,
      `${owner}/b`,
      `${owner}/c`,
    ]);
    expect(snapshot.projects.map((project) => project.name).sort()).toStrictEqual([
      "d",
      "g",
      "h",
      "new",
    ]);
    expect(snapshot.projects.find((project) => project.name === "d")?.archived).toBe(true);
    expect(snapshot.projectMetadataUpdatedAt[`${owner}/e`]).toBe(at(10));
    expect(snapshot.projectMetadataUpdatedAt[`${owner}/f`]).toBe(at(10));
    expect(await repositoryPublicCacheBarrier(env, `${owner}/a`)).toBe("blocked");
    expect(await repositoryPublicCacheBarrier(env, `${owner}/e`)).toBe("clear");
  }
});

test("concurrent first mutations of an owner are all applied", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  const observedAt = "2026-06-11T01:00:00.000Z";
  const repos = ["a", "b", "c", "d", "e", "f"];

  await Promise.all(
    repos.map((name) =>
      mutateOwnerMetadataSnapshot(env, "fresh", {
        kind: "remove",
        fullName: `fresh/${name}`,
        observedAt,
      }),
    ),
  );

  const snapshot = await storedSnapshot("fresh");
  expect(Object.keys(snapshot.privateRepos).sort()).toStrictEqual(
    repos.map((name) => `fresh/${name}`),
  );
});

test("owner metadata fails closed when the database can't be reached", async () => {
  const project = testProject({ owner: "owner", name: "repo" });
  const key = "dashboard:test";
  const cache = kvStore({ [key]: JSON.stringify(testDashboard("owner", [project])) });
  const reachable = testEnv({ DASHBOARD_CACHE: cache });
  const unreachable = testEnv({
    DASHBOARD_CACHE: cache,
    DB: observedDatabase(() => true).database,
  });

  expect((await readCachedWithOwnerMetadata(reachable, key))?.projects.length).toBe(1);
  expect(await readCachedWithOwnerMetadata(unreachable, key)).toBe(null);
  expect(await repositoryPublicCacheBarrier(unreachable, "owner/repo")).toBe("unknown");
  await expect(
    mutateOwnerMetadataSnapshot(unreachable, "owner", {
      kind: "remove",
      fullName: "owner/repo",
      observedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow("D1 unavailable");
});

test("an expired owner metadata snapshot reads as absent and is deleted in bounded steps", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  const now = new Date().toISOString();
  const snapshot = (owner: string) => ({
    owner,
    generatedAt: now,
    metadataUpdatedAt: now,
    countsUpdatedAt: now,
    privateRepos: { [`${owner}/secret`]: now },
    removedRepos: { [`${owner}/secret`]: now },
    projects: [],
  });
  await seedOwnerMetadata("live", snapshot("live"));
  for (const owner of ["old1", "old2", "old3"]) {
    await seedOwnerMetadata(owner, snapshot(owner), Date.now() - 1000);
  }

  expect((await readOwnerMetadata(env, "live"))?.privateRepos["live/secret"]).toBe(now);
  expect(await readOwnerMetadata(env, "old1")).toBe(null);

  // A mutation of an expired owner starts from nothing, not from what expired.
  const observedAt = new Date().toISOString();
  await mutateOwnerMetadataSnapshot(env, "old1", {
    kind: "remove",
    fullName: "old1/other",
    observedAt,
  });
  expect((await readOwnerMetadata(env, "old1"))?.privateRepos).toStrictEqual({
    "old1/other": observedAt,
  });

  expect(await deleteExpiredOwnerMetadata(env, 1)).toBe(1);
  expect(await deleteExpiredOwnerMetadata(env, 10)).toBe(1);
  expect(await deleteExpiredOwnerMetadata(env, 10)).toBe(0);
  expect(await storedOwnerMetadataJson("live")).not.toBe(null);
  expect(await storedOwnerMetadataJson("old1")).not.toBe(null);
  expect(await storedOwnerMetadataJson("old2")).toBe(null);
  expect(await storedOwnerMetadataJson("old3")).toBe(null);
});

test("an installation is found by its account's exact slug only", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  await writeStoredInstallation(env, installation(1, "openclaw"));
  await writeStoredInstallation(env, installation(2, "open"));

  expect((await readStoredInstallation(env, "openclaw"))?.id).toBe(1);
  expect((await readStoredInstallation(env, "open"))?.id).toBe(2);
  // The slug folds case and a leading "@", as the key did before; nothing else matches.
  expect((await readStoredInstallation(env, "@OpenClaw"))?.id).toBe(1);
  for (const account of ["openc", "openclaw2", "open%", "open_law", "%", "openclaw/repo", ""]) {
    expect(await readStoredInstallation(env, account)).toBe(null);
  }
});

test("an account has one installation: a new id replaces it, and an id follows its account", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  await writeStoredInstallation(env, installation(1, "acme", { repositories: ["acme/old"] }));
  await writeStoredInstallation(env, installation(5, "other"));

  // Uninstalled and installed again: GitHub gives the account a new installation id.
  await writeStoredInstallation(env, installation(2, "acme", { repositories: ["acme/new"] }));
  const reinstalled = await readStoredInstallation(env, "acme");
  expect(reinstalled?.id).toBe(2);
  expect(reinstalled?.repositories).toStrictEqual(["acme/new"]);

  // The account was renamed: the same installation id, under the new login only.
  await writeStoredInstallation(env, installation(2, "acme-inc"));
  expect(await readStoredInstallation(env, "acme")).toBe(null);
  expect((await readStoredInstallation(env, "acme-inc"))?.id).toBe(2);

  expect((await listStoredInstallations(env)).map((record) => record.id).sort()).toStrictEqual([
    2, 5,
  ]);
  await deleteStoredInstallation(env, "ACME-inc");
  expect((await listStoredInstallations(env)).map((record) => record.id)).toStrictEqual([5]);
});

test("the installation listing reads every row in pages, most recently updated first", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  const count = 205;
  for (let index = 0; index < count; index += 1) {
    await writeStoredInstallation(
      env,
      installation(index + 1, `account-${index}`, {
        updatedAt: new Date(Date.UTC(2026, 0, 1) + ((index * 7) % count) * 1000).toISOString(),
      }),
    );
  }

  const listed = await listStoredInstallations(env);
  expect(listed.length).toBe(count);
  expect(new Set(listed.map((record) => record.id)).size).toBe(count);
  const times = listed.map((record) => Date.parse(record.updatedAt));
  expect(times).toStrictEqual([...times].sort((a, b) => b - a));
});

test("an expired installation is not used and is deleted in bounded steps", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  await writeStoredInstallation(env, installation(1, "live"));
  for (const [id, account] of [
    [2, "old1"],
    [3, "old2"],
    [4, "old3"],
  ] as const) {
    await writeStoredInstallation(env, installation(id, account));
  }
  await runtimeEnv.DB.prepare("UPDATE installations SET expires_at = ?1 WHERE id > 1")
    .bind(Date.now() - 1000)
    .run();

  expect(await readStoredInstallation(env, "old1")).toBe(null);
  expect((await listStoredInstallations(env)).map((record) => record.id)).toStrictEqual([1]);

  expect(await deleteExpiredInstallations(env, 2)).toBe(2);
  await deleteExpiredRegistryRows(env);
  const left = await runtimeEnv.DB.prepare("SELECT id FROM installations").all<{ id: number }>();
  expect(left.results.map((row) => row.id)).toStrictEqual([1]);

  // A row lasts 90 days from its last write.
  const expiry = await runtimeEnv.DB.prepare("SELECT expires_at FROM installations WHERE id = 1")
    .first<{ expires_at: number }>()
    .then((row) => row?.expires_at ?? 0);
  expect(Math.abs(expiry - (Date.now() + 90 * day))).toBeLessThan(60_000);
});

test("a profile is stored and read whole, by its owner's exact slug", async () => {
  const env = testEnv({ DASHBOARD_CACHE: kvStore() });
  const profile: DashboardProfile = {
    owner: "openclaw",
    includeOwners: ["friends"],
    includeRepos: ["other/repo", "third/lib"],
    hiddenOwners: ["noisy"],
    hiddenRepos: ["openclaw/secret"],
    updatedAt: "2026-06-11T01:00:00.000Z",
    updatedBy: "OpenClaw",
  };
  await writeStoredProfile(env, profile);

  expect(await readProfile(env, "openclaw")).toStrictEqual(profile);
  expect(await readProfile(env, "OpenClaw")).toStrictEqual(profile);
  for (const owner of ["open", "openclaw2", "open%", "%"]) {
    expect(await readProfile(env, owner)).toBe(null);
  }

  const replaced = { ...profile, hiddenRepos: [], updatedAt: "2026-06-12T01:00:00.000Z" };
  await writeStoredProfile(env, replaced);
  expect(await readProfile(env, "openclaw")).toStrictEqual(replaced);

  await deleteProfile(env, "openclaw");
  expect(await readProfile(env, "openclaw")).toBe(null);
});
