// The registry tables of the D1 database (migrations/0003_registry.sql), through the store
// functions the Worker uses: installations, owner metadata and dashboard profiles.
import { expect, test } from "vitest";
import type { DashboardProfile } from "../src/types.ts";
import type { OwnerMetadataMutation, OwnerMetadataSnapshot } from "../worker/config.ts";
import { repositoryPublicCacheBarrier, readOwnerMetadata } from "../worker/owner-metadata-read.ts";
import {
  mutateOwnerMetadataSnapshot,
  mutateOwnerMetadataSnapshots,
  readCachedWithOwnerMetadata,
} from "../worker/owner-metadata-write.ts";
import { deleteExpiredRegistryRows } from "../worker/registry-expiry.ts";
import {
  deleteExpiredInstallations,
  deleteStoredInstallation,
  deleteStoredInstallations,
  listStoredInstallations,
  readStoredInstallation,
  readStoredInstallationsOf,
  type StoredInstallationRecord,
  writeStoredInstallation,
  writeStoredInstallations,
} from "../worker/store/installations.ts";
import {
  changeOwnerMetadataOf,
  deleteExpiredOwnerMetadata,
  readOwnerCountTimes,
  readStoredOwnerMetadataOf,
} from "../worker/store/owner-metadata.ts";
import {
  deleteProfile,
  readProfile,
  readProfilesOf,
  writeStoredProfile,
} from "../worker/store/profiles.ts";
import {
  observedDatabase,
  seedOwnerMetadata,
  storedOwnerMetadataJson,
  testDashboard,
  testEnv,
  testProject,
  cacheWith,
  testDatabase,
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
    const env = testEnv({ DB: observed.database });
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

test("concurrent conflicting batches of owner metadata mutations are all applied", async () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 5, 11, 0, minutes)).toISOString();
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const owners = ["batch0", "batch1", "batch2", "batch3", "batch4"];
  const observed = observedDatabase();
  const env = testEnv({ DB: observed.database });
  const merge = (owner: string, minutes: number, repos: string[]): OwnerMetadataMutation => ({
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
  // The same conflict as for single mutations above, for every owner at once: each batch holds
  // one mutation of every owner, and all the batches start together, so they all read the same
  // revisions and all but one write of each owner must be applied again.
  const mutationsOf = (owner: string): OwnerMetadataMutation[] => [
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
    merge(owner, 10, ["new"]),
    // A stale build that still lists the repositories being removed.
    merge(owner, 0, ["a", "b", "c"]),
  ];
  const batchOf = (pick: (owner: string) => OwnerMetadataMutation | undefined) =>
    owners.flatMap((owner) => {
      const mutation = pick(owner);
      return mutation ? [{ owner, mutation }] : [];
    });
  await mutateOwnerMetadataSnapshots(
    env,
    batchOf((owner) => merge(owner, 1, names)),
  );
  for (const name of ["e", "f"]) {
    await mutateOwnerMetadataSnapshots(
      env,
      batchOf((owner) => ({ kind: "remove", fullName: `${owner}/${name}`, observedAt: at(2) })),
    );
  }
  observed.counts.sql.length = 0;
  observed.counts.queries = 0;

  const kinds = mutationsOf("any").length;
  const results = await Promise.all([
    ...Array.from({ length: kinds - 1 }, (_, index) =>
      mutateOwnerMetadataSnapshots(
        env,
        batchOf((owner) => mutationsOf(owner)[index]),
      ),
    ),
    // The last mutation of each owner goes by itself, against the batches.
    ...owners.map(async (owner) => {
      const mutation = mutationsOf(owner).at(-1);
      if (!mutation) throw new Error("no mutation");
      const value = await mutateOwnerMetadataSnapshot(env, owner, mutation);
      return [{ status: "fulfilled" as const, value }];
    }),
  ]);

  expect(results.flat().length).toBe(kinds * owners.length);
  expect(results.flat().every((result) => result.status === "fulfilled" && result.value)).toBe(
    true,
  );
  const writes = observed.counts.sql.filter((sql) => sql.includes("UPDATE owner_metadata"));
  // More writes were tried than there are mutations: they did conflict.
  expect(writes.length).toBeGreaterThan(kinds * owners.length);
  // And far fewer queries than a read and a write per mutation and try.
  expect(observed.counts.queries).toBeLessThan(writes.length);
  for (const owner of owners) {
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

test("a batched write applies again only the owners whose rows changed meanwhile", async () => {
  const observedAt = "2026-06-11T01:00:00.000Z";
  const owners = ["steady1", "moved", "steady2", "fresh-owner"];
  const plain = testEnv({});
  for (const owner of owners.slice(0, 3)) {
    await mutateOwnerMetadataSnapshot(plain, owner, {
      kind: "remove",
      fullName: `${owner}/first`,
      observedAt,
    });
  }
  // A database that lets another writer in between the batch's read and its write: before the
  // first batch that writes, "moved" gets a tombstone from elsewhere, and "fresh-owner", which
  // had no row when it was read, gets one.
  const observed = observedDatabase();
  let batches = 0;
  const database = {
    prepare: (sql: string) => observed.database.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      batches += 1;
      if (batches === 2) {
        for (const owner of ["moved", "fresh-owner"]) {
          await mutateOwnerMetadataSnapshot(plain, owner, {
            kind: "remove",
            fullName: `${owner}/elsewhere`,
            observedAt,
          });
        }
      }
      return observed.database.batch(statements);
    },
  } as unknown as D1Database;
  const env = testEnv({ DB: database });
  let applied: string[] = [];

  const results = await changeOwnerMetadataOf(
    env,
    owners.map((owner) => ({
      owner,
      change: (stored) => {
        applied.push(owner);
        return {
          ...(stored as OwnerMetadataSnapshot),
          owner,
          projects: stored?.projects ?? [],
          removedRepos: { ...stored?.removedRepos, [`${owner}/second`]: observedAt },
          privateRepos: { ...stored?.privateRepos, [`${owner}/second`]: observedAt },
        };
      },
    })),
  );

  expect(results.map((result) => result.status)).toStrictEqual(owners.map(() => "fulfilled"));
  // Every change ran once, and the two that lost ran again on what the other writer stored.
  expect(applied).toStrictEqual([...owners, "moved", "fresh-owner"]);
  expect(batches).toBe(4);
  expect(observed.counts.sql).toStrictEqual([
    "SELECT owner, revision, snapshot, expires_at FROM owner_metadata WHERE owner IN (?, ?, ?, ?)",
    ...["UPDATE", "UPDATE", "UPDATE", "INSERT"].map((kind) =>
      expect.stringMatching(new RegExp(`^${kind} `)),
    ),
    "SELECT owner, revision, snapshot, expires_at FROM owner_metadata WHERE owner IN (?, ?)",
    expect.stringMatching(/^UPDATE owner_metadata/),
    expect.stringMatching(/^UPDATE owner_metadata/),
  ]);
  // Nothing is lost: the tombstone written in between is there, with both of the batch's.
  expect(Object.keys((await storedSnapshot("moved")).privateRepos).sort()).toStrictEqual([
    "moved/elsewhere",
    "moved/first",
    "moved/second",
  ]);
  expect(Object.keys((await storedSnapshot("fresh-owner")).privateRepos).sort()).toStrictEqual([
    "fresh-owner/elsewhere",
    "fresh-owner/second",
  ]);
  expect(Object.keys((await storedSnapshot("steady1")).privateRepos).sort()).toStrictEqual([
    "steady1/first",
    "steady1/second",
  ]);

  // An owner whose row keeps changing gives up after 12 tries and is reported, by itself: the
  // other owner of the batch is stored.
  applied = [];
  batches = 0;
  let writes = 0;
  const contended = {
    prepare: (sql: string) => observed.database.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      batches += 1;
      if (batches % 2 === 0) {
        writes += 1;
        await mutateOwnerMetadataSnapshot(plain, "moved", {
          kind: "remove",
          fullName: `moved/again${writes}`,
          observedAt,
        });
      }
      return observed.database.batch(statements);
    },
  } as unknown as D1Database;
  const [steady, moved] = await changeOwnerMetadataOf(
    testEnv({ DB: contended }),
    ["steady1", "moved"].map((owner) => ({
      owner,
      change: (stored) => {
        applied.push(owner);
        return stored ? { ...stored, generatedAt: observedAt } : null;
      },
    })),
  );
  expect(steady?.status).toBe("fulfilled");
  expect(moved?.status).toBe("rejected");
  expect(String((moved as PromiseRejectedResult).reason)).toContain("kept changing");
  expect(applied.filter((owner) => owner === "steady1").length).toBe(1);
  expect(applied.filter((owner) => owner === "moved").length).toBe(12);
  expect(Object.keys((await storedSnapshot("moved")).privateRepos).length).toBe(3 + 12);

  // An owner is named once in a batch: two changes of it could not both see the stored row.
  await expect(
    changeOwnerMetadataOf(env, [
      { owner: "Steady1", change: (stored) => stored },
      { owner: "@steady1", change: (stored) => stored },
    ]),
  ).rejects.toThrow("one change at a time");
});

test("owner metadata of many owners is read with one query, by exact slug", async () => {
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const snapshot = (owner: string, extra: Record<string, unknown> = {}) => ({
    owner,
    generatedAt: now,
    metadataUpdatedAt: now,
    countsUpdatedAt: earlier,
    privateRepos: {},
    removedRepos: {},
    projects: [],
    ...extra,
  });
  // More owners than one statement binds parameters.
  const many = Array.from({ length: 230 }, (_, index) => `many-${index}`);
  for (const owner of many) await seedOwnerMetadata(owner, snapshot(owner));
  await seedOwnerMetadata("open", snapshot("open", { countsAttemptedAt: now }));
  await seedOwnerMetadata("openclaw", snapshot("openclaw", { countsUpdatedAt: null }));
  await seedOwnerMetadata("expired", snapshot("expired"), Date.now() - 1000);
  await seedOwnerMetadata("mislabelled", snapshot("someone-else"));
  await seedOwnerMetadata("shapeless", { owner: "shapeless", countsUpdatedAt: earlier });
  const { database, counts } = observedDatabase();
  const env = testEnv({ DB: database });
  const asked = [...many, "@Open", "openclaw", "expired", "mislabelled", "shapeless", "absent"];
  const patterns = ["ope", "open%", "open_law", "%", "openclaw/repo", "many-"];

  const snapshots = await readStoredOwnerMetadataOf(env, [...asked, ...patterns]);
  expect(counts.queries).toBe(1);
  expect(snapshots.size).toBe(asked.length + patterns.length);
  expect(many.every((owner) => snapshots.get(owner)?.owner === owner)).toBe(true);
  // The slug folds case and a leading "@"; nothing else matches.
  expect(snapshots.get("open")?.countsAttemptedAt).toBe(now);
  expect(snapshots.get("expired")).toBe(null);
  expect(snapshots.get("absent")).toBe(null);
  for (const pattern of patterns) expect(snapshots.get(pattern)).toBe(null);

  counts.queries = 0;
  const times = await readOwnerCountTimes(env, [...asked, ...patterns]);
  expect(counts.queries).toBe(1);
  // Only the owners with a snapshot that counts, as `readOwnerMetadata` reads them: the time of
  // the last attempt, or of the last counts when there was no attempt since.
  expect([...times.keys()].sort()).toStrictEqual([...many, "open", "openclaw"].sort());
  expect(times.get("open")).toBe(now);
  expect(times.get("many-0")).toBe(earlier);
  expect(times.get("openclaw")).toBe(null);
  for (const owner of ["open", "many-0", "openclaw", "expired", "mislabelled", "shapeless"]) {
    const read = await readOwnerMetadata(env, owner);
    expect(times.has(owner)).toBe(read !== null);
    if (read) expect(times.get(owner)).toBe(read.countsAttemptedAt);
  }

  await expect(
    readStoredOwnerMetadataOf(testEnv({ DB: observedDatabase(() => true).database }), ["open"]),
  ).rejects.toThrow("D1 unavailable");
});

test("concurrent first mutations of an owner are all applied", async () => {
  const env = testEnv({});
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
  await cacheWith({ [key]: JSON.stringify(testDashboard("owner", [project])) });
  const reachable = testEnv({});
  const unreachable = testEnv({
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
  const env = testEnv({});
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
  const env = testEnv({});
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

test("installations and profiles of many accounts are read with one query, by exact slug", async () => {
  const { database, counts } = observedDatabase();
  const env = testEnv({ DB: database });
  // More accounts than one statement binds parameters.
  const many = Array.from({ length: 230 }, (_, index) => `many-${index}`);
  await writeStoredInstallations(env, [
    ...many.map((account, index) => installation(100 + index, account)),
    installation(1, "openclaw"),
    installation(2, "open"),
    installation(3, "gone"),
  ]);
  // 233 installations, 100 to a batch.
  expect(counts.queries).toBe(3);
  await testDatabase
    .prepare("UPDATE installations SET expires_at = ?1 WHERE id = 3")
    .bind(Date.now() - 1000)
    .run();
  const patterns = ["openc", "openclaw2", "open%", "open_law", "%", "openclaw/repo", "", "many-"];

  counts.queries = 0;
  const found = await readStoredInstallationsOf(env, [
    ...many,
    "@OpenClaw",
    "open",
    "gone",
    ...patterns,
  ]);
  expect(counts.queries).toBe(1);
  expect(many.every((account, index) => found.get(account)?.id === 100 + index)).toBe(true);
  // The slug folds case and a leading "@", as for one account; nothing else matches.
  expect(found.get("openclaw")?.id).toBe(1);
  expect(found.get("open")?.id).toBe(2);
  expect(found.get("gone")).toBe(null);
  for (const account of patterns) expect(found.get(account)).toBe(null);
  expect(found.size).toBe(many.length + 3 + patterns.length);

  // A batch keeps one row per account, as a single write does: a new id replaces the old one.
  await writeStoredInstallations(env, [installation(7, "openclaw"), installation(8, "open")]);
  expect((await readStoredInstallation(env, "openclaw"))?.id).toBe(7);
  expect((await listStoredInstallations(env)).length).toBe(many.length + 2);

  counts.queries = 0;
  await deleteStoredInstallations(env, ["OpenClaw", "open%", ...many.slice(0, 100)]);
  // More accounts than one statement binds: two statements, one batch.
  expect(counts.queries).toBe(1);
  expect(await readStoredInstallation(env, "openclaw")).toBe(null);
  expect((await readStoredInstallation(env, "open"))?.id).toBe(8);
  expect((await listStoredInstallations(env)).length).toBe(many.length - 100 + 1);

  const profile = (owner: string): DashboardProfile => ({
    owner,
    includeOwners: [],
    includeRepos: [],
    hiddenOwners: [],
    hiddenRepos: [`${owner}/secret`],
    updatedAt: "2026-06-11T01:00:00.000Z",
    updatedBy: owner,
  });
  await writeStoredProfile(env, profile("openclaw"));
  await writeStoredProfile(env, profile("open"));
  counts.queries = 0;
  const profiles = await readProfilesOf(env, [...many, "@OpenClaw", "open", ...patterns]);
  expect(counts.queries).toBe(1);
  expect(profiles.get("openclaw")).toStrictEqual(profile("openclaw"));
  expect(profiles.get("open")).toStrictEqual(profile("open"));
  expect([...profiles.values()].filter((value) => value !== null).length).toBe(2);
});

test("an account has one installation: a new id replaces it, and an id follows its account", async () => {
  const env = testEnv({});
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
  const env = testEnv({});
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
  const env = testEnv({});
  await writeStoredInstallation(env, installation(1, "live"));
  for (const [id, account] of [
    [2, "old1"],
    [3, "old2"],
    [4, "old3"],
  ] as const) {
    await writeStoredInstallation(env, installation(id, account));
  }
  await testDatabase
    .prepare("UPDATE installations SET expires_at = ?1 WHERE id > 1")
    .bind(Date.now() - 1000)
    .run();

  expect(await readStoredInstallation(env, "old1")).toBe(null);
  expect((await listStoredInstallations(env)).map((record) => record.id)).toStrictEqual([1]);

  expect(await deleteExpiredInstallations(env, 2)).toBe(2);
  await deleteExpiredRegistryRows(env);
  const left = await testDatabase.prepare("SELECT id FROM installations").all<{ id: number }>();
  expect(left.results.map((row) => row.id)).toStrictEqual([1]);

  // A row lasts 90 days from its last write.
  const expiry = await testDatabase
    .prepare("SELECT expires_at FROM installations WHERE id = 1")
    .first<{ expires_at: number }>()
    .then((row) => row?.expires_at ?? 0);
  expect(Math.abs(expiry - (Date.now() + 90 * day))).toBeLessThan(60_000);
});

test("a profile is stored and read whole, by its owner's exact slug", async () => {
  const env = testEnv({});
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

test("the database refuses a JSON column of the wrong shape", async () => {
  const database = testDatabase;
  const profile = (lists: [string, string, string, string]) =>
    database
      .prepare(
        `INSERT INTO profiles
           (owner, include_owners, include_repos, hidden_owners, hidden_repos, updated_at, updated_by)
         VALUES ('shape', ?1, ?2, ?3, ?4, '2026-06-13T12:00:00Z', 'shape')`,
      )
      .bind(...lists)
      .run();
  const installation = (repositories: string) =>
    database
      .prepare(
        `INSERT INTO installations
           (id, account_login, account_type, account_url, avatar_url, repository_selection,
            repositories, updated_at, expires_at)
         VALUES (7, 'shape', 'org', 'https://github.com/shape', 'https://avatars/7', 'selected',
            ?1, '2026-06-13T12:00:00Z', 9999999999999)`,
      )
      .bind(repositories)
      .run();
  const snapshot = (value: string) =>
    database
      .prepare(
        "INSERT INTO owner_metadata (owner, revision, snapshot, expires_at) VALUES ('shape', 'r', ?1, 9999999999999)",
      )
      .bind(value)
      .run();

  // Each list of a profile, in turn, as an object, a string, a number and text that is not JSON.
  for (const wrong of ['{"a":1}', '"owner"', "5", "not json"]) {
    for (let column = 0; column < 4; column += 1) {
      const lists: [string, string, string, string] = ["[]", "[]", "[]", "[]"];
      lists[column] = wrong;
      await expect(profile(lists)).rejects.toThrow(/CHECK constraint failed/);
    }
    await expect(installation(wrong)).rejects.toThrow(/CHECK constraint failed/);
  }
  for (const wrong of ["[]", '"owner"', "5", "not json"]) {
    await expect(snapshot(wrong)).rejects.toThrow(/CHECK constraint failed/);
  }

  await profile(['["a"]', "[]", "[]", '["a/b"]']);
  await installation('["shape/a"]');
  await snapshot('{"owner":"shape"}');
  expect((await readProfile(testEnv({}), "shape"))?.hiddenRepos).toStrictEqual(["a/b"]);
});
