import font400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?inline";
import font700 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?inline";

import { runInDurableObject } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { vi } from "vitest";
import type {
  DashboardProfile,
  RefreshJob,
  RefreshTarget,
  SchedulerAuditEvent,
} from "../src/types.ts";
import handler, {
  BuildCoordinator,
  RateLimiter,
  SummaryQuota,
  WebhookAdmission,
  WebhookProcessor,
} from "../worker/index.ts";
import {
  type OwnerMetadataMutation,
  type OwnerMetadataSnapshot,
  refreshTargetSourceLimit,
} from "../worker/config.ts";
import { refreshTargetSources } from "../worker/refresh-targets.ts";
import { mutateOwnerMetadataSnapshot } from "../worker/owner-metadata-write.ts";
import type { WorkerQueueMessage } from "../worker/runtime.ts";
import {
  readStoredInstallation,
  type StoredInstallationRecord,
  writeStoredInstallation,
} from "../worker/store/installations.ts";
import { writeStoredProfile } from "../worker/store/profiles.ts";
import { ensureProfileSnapshot, readProfileSnapshot } from "../worker/store/profile-snapshots.ts";
import {
  indexRefreshJob,
  listStoredRefreshJobDeliveries,
  listStoredRefreshJobs,
  readStoredRefreshJob,
  readStoredRefreshJobSnapshot,
  writeRefreshJob,
} from "../worker/store/refresh-jobs.ts";
import {
  deleteRefreshTarget,
  indexedRefreshTargets,
  readStoredRefreshTarget,
  type RefreshTargetWrite,
  writeRefreshTarget,
} from "../worker/store/refresh-targets.ts";
import {
  readOwnerCountCursor,
  readSchedulerState,
  type StoredSchedulerState,
} from "../worker/store/scheduler-state.ts";

import { realEnv, testCache, testDatabase, type TestEnv, testEnv } from "./runtime-env.ts";

export { testDashboard, testProject } from "./dashboard-fixtures.ts";
export { testCache, testDatabase, type TestEnv, testEnv };

const textEncoder = new TextEncoder();

type TestContext = { waitUntil(promise: Promise<unknown>): void };

type TestBatch = {
  messages: Array<{
    body: WorkerQueueMessage;
    attempts?: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
};

const objectClasses = [
  BuildCoordinator,
  RateLimiter,
  SummaryQuota,
  WebhookAdmission,
  WebhookProcessor,
];

export { BuildCoordinator, RateLimiter, SummaryQuota, WebhookAdmission, WebhookProcessor };

// Makes every dashboard's build lock answer as held by someone else, until the test ends.
export function buildLocksHeld(): void {
  vi.spyOn(BuildCoordinator.prototype, "acquireLock").mockReturnValue(false);
}

// Makes every call to a Durable Object of the given classes fail, as when the objects can't be
// reached, until the test ends. Without classes, all of them.
export function objectsUnavailable(...classes: Array<(typeof objectClasses)[number]>): void {
  for (const objectClass of classes.length > 0 ? classes : objectClasses) {
    const prototype: object = objectClass.prototype;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === "constructor") continue;
      vi.spyOn(prototype as Record<string, () => unknown>, method).mockImplementation(() => {
        throw new Error("Durable Object unavailable");
      });
    }
  }
}

// Makes a dashboard's coordinator object forget the refresh target's state, so that it takes the
// stored target again: for a test that stores a target directly.
export async function forgetRefreshTargetState(key: string): Promise<void> {
  await runInDurableObject(runtimeEnv.BUILD_COORDINATOR.getByName(key), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM refresh_target");
  });
}

// The refresh data is in the local D1 database of the Workers runtime. These helpers write and
// read it through the store functions, as the Worker does.
const databaseEnv = realEnv;

// Stores a refresh target with the index of its sources.
export function storeRefreshTarget(target: RefreshTarget): Promise<RefreshTargetWrite> {
  return writeRefreshTarget(databaseEnv, target, refreshTargetSources(target));
}

export async function storeRefreshTargets(targets: RefreshTarget[]): Promise<void> {
  for (const target of targets) await storeRefreshTarget(target);
}

// The stored refresh target, or null.
export function storedRefreshTarget(key: string): Promise<RefreshTarget | null> {
  return readStoredRefreshTarget(databaseEnv, key);
}

export function deleteStoredRefreshTarget(key: string): Promise<void> {
  return deleteRefreshTarget(databaseEnv, key);
}

// The targets the index lists under an owner or a repository, most recently seen first.
export function indexedTargets(kind: "owner" | "repo", value: string): Promise<RefreshTarget[]> {
  return indexedRefreshTargets(databaseEnv, [{ kind, value }]).then(([targets]) => targets ?? []);
}

// Stores the latest state of a refresh job.
export function storeRefreshJob(job: RefreshJob): Promise<void> {
  return writeRefreshJob(databaseEnv, job);
}

// The latest state a delivery stored for the job, or null.
export function storedRefreshJob(id: string): Promise<RefreshJob | null> {
  return readStoredRefreshJob(databaseEnv, id);
}

// Stores a job as enqueueing does: its snapshot, and no state yet.
export function storeRefreshJobSnapshot(job: RefreshJob): Promise<void> {
  return indexRefreshJob(databaseEnv, job);
}

// How many statements among `sql` wrote the state of a job.
export function jobStateWrites(sql: string[]): number {
  return sql.filter((statement) =>
    statement.startsWith(
      "INSERT INTO refresh_jobs (id, target_key, created_at, updated_at, value)",
    ),
  ).length;
}

// The job as it was enqueued, with its target: what a job's `targetSnapshotKey` names.
export function storedRefreshJobSnapshot(key: string | undefined): Promise<RefreshJob | null> {
  return readStoredRefreshJobSnapshot(databaseEnv, key ?? "");
}

// The newest jobs: each in its latest state, or as it was enqueued while it has none.
export function storedRefreshJobs(): Promise<RefreshJob[]> {
  return listStoredRefreshJobs(databaseEnv);
}

export function storedRefreshJobDeliveries(): Promise<RefreshJob[]> {
  return listStoredRefreshJobDeliveries(databaseEnv);
}

// Stores the snapshot of a profile and returns its key: what a target carries as
// `profileSnapshotKey`.
export function storeProfileSnapshot(profile: DashboardProfile): Promise<string> {
  return ensureProfileSnapshot(databaseEnv, profile);
}

export function storedProfileSnapshot(key: string): Promise<DashboardProfile | null> {
  return readProfileSnapshot(databaseEnv, key);
}

export function storedSchedulerState(): Promise<StoredSchedulerState | null> {
  return readSchedulerState(databaseEnv);
}

export function storedOwnerCountCursor(): Promise<string | null> {
  return readOwnerCountCursor(databaseEnv);
}

// Stores as many targets under a source as it takes, so that the store refuses the next new one.
// `lastSeenAt` is when the targets were last seen, in milliseconds: now, unless a test wants
// targets that are past their lifetime.
export async function fillTargetSource(
  kind: "owner" | "repo",
  value: string,
  lastSeenAt = Date.now(),
): Promise<void> {
  const database = databaseEnv.DB;
  const target = database.prepare(
    "INSERT INTO refresh_targets (key, next_due_at, last_seen_at, value) VALUES (?, ?, ?, '{}')",
  );
  const source = database.prepare(
    "INSERT INTO refresh_target_sources (kind, value, target_key) VALUES (?, ?, ?)",
  );
  await database.batch(
    Array.from({ length: refreshTargetSourceLimit }, (_, count) => {
      const key = `filler:${kind}:${value}:${count}`;
      return [target.bind(key, lastSeenAt, lastSeenAt), source.bind(kind, value, key)];
    }).flat(),
  );
}

// A database that counts the statements the Worker sends it, and can fail one: pass it to a
// test's env as the D1 binding. `fail` gets each statement's SQL before it runs; returning true
// makes the statement throw. A batch counts once in `batches` and each of its statements in
// `statements`. `queries` is what D1 counts against its limit per invocation: one for a statement
// sent by itself and one for a batch, whatever it holds.
export function observedDatabase(fail: (sql: string) => boolean = () => false) {
  const counts = { statements: 0, batches: 0, queries: 0, sql: [] as string[] };
  const sqlOf = new WeakMap<object, string>();
  const record = (sql: string): void => {
    counts.statements += 1;
    counts.sql.push(sql.replaceAll(/\s+/g, " ").trim());
    if (fail(sql)) throw new Error("D1 unavailable");
  };
  const observe = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (typeof member !== "function") return member;
        if (property === "bind") {
          return (...values: unknown[]) => observe(target.bind(...values), sql);
        }
        return async (...parameters: unknown[]): Promise<unknown> => {
          counts.queries += 1;
          record(sql);
          return Reflect.apply(member, target, parameters);
        };
      },
    });
    sqlOf.set(proxy, sql);
    rawStatements.set(proxy, statement);
    return proxy;
  };
  const rawStatements = new WeakMap<object, D1PreparedStatement>();
  const real = testDatabase;
  const database = {
    prepare: (sql: string) => observe(real.prepare(sql), sql),
    batch: async (statements: D1PreparedStatement[]) => {
      counts.batches += 1;
      counts.queries += 1;
      for (const statement of statements) record(sqlOf.get(statement) ?? "");
      return real.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
    },
  } as unknown as D1Database;
  return { database, counts };
}

// Applies mutations to an owner's metadata, as the Worker does.
export function ownerMetadataMutator(
  owner: string,
): (mutation: OwnerMetadataMutation) => Promise<OwnerMetadataSnapshot | null> {
  return (mutation) => mutateOwnerMetadataSnapshot(realEnv, owner, mutation);
}

// The helpers below put rows into, and read them from, the registry tables of the local D1
// database (migrations/0003_registry.sql). A value may be given as JSON text.
function seedValue<Value>(value: Value | string): Value {
  return typeof value === "string" ? (JSON.parse(value) as Value) : value;
}

// Stores `snapshot` as the owner's metadata, as it is: a test may store one the Worker would not
// write, to see that it is not trusted. `expiresAt` is when the row's time runs out.
export async function seedOwnerMetadata(
  owner: string,
  snapshot: unknown,
  expiresAt = Date.now() + 24 * 60 * 60 * 1000,
): Promise<void> {
  await testDatabase
    .prepare(
      `INSERT INTO owner_metadata (owner, revision, snapshot, expires_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (owner) DO UPDATE SET
       revision = excluded.revision, snapshot = excluded.snapshot, expires_at = excluded.expires_at`,
    )
    .bind(
      owner,
      crypto.randomUUID(),
      typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
      expiresAt,
    )
    .run();
}

// The owner's stored metadata snapshot as JSON text, or null when there is no row.
export async function storedOwnerMetadataJson(owner: string): Promise<string | null> {
  const row = await testDatabase
    .prepare("SELECT snapshot FROM owner_metadata WHERE owner = ?1")
    .bind(owner)
    .first<{ snapshot: string }>();
  return row?.snapshot ?? null;
}

export async function deleteStoredOwnerMetadata(owner: string): Promise<void> {
  await testDatabase.prepare("DELETE FROM owner_metadata WHERE owner = ?1").bind(owner).run();
}

// Stores the installation in the registry, through the store function the Worker uses.
export async function seedInstallation(
  installation: StoredInstallationRecord | string,
): Promise<void> {
  await writeStoredInstallation(realEnv, seedValue(installation));
}

// The account's installation in the registry as JSON text, or null when there is none.
export async function storedInstallationJson(account: string): Promise<string | null> {
  const installation = await readStoredInstallation(realEnv, account);
  return installation ? JSON.stringify(installation) : null;
}

// Stores the dashboard profile, through the store function the Worker uses.
export async function seedProfile(profile: DashboardProfile | string): Promise<void> {
  await writeStoredProfile(realEnv, seedValue(profile));
}

export const worker = {
  fetch: (request: Request, env: TestEnv, context: TestContext): Promise<Response> =>
    handler.fetch(request, testEnv(env), context as ExecutionContext),
  scheduled: (
    event: { cron: string; scheduledTime?: number },
    env: TestEnv,
    context: TestContext,
  ): Promise<void> =>
    handler.scheduled(
      { scheduledTime: Date.now(), ...event } as ScheduledController,
      testEnv(env),
      context as ExecutionContext,
    ),
  queue: (batch: TestBatch, env: TestEnv, context: TestContext): Promise<void> =>
    handler.queue(
      batch as unknown as MessageBatch<WorkerQueueMessage>,
      testEnv(env),
      context as ExecutionContext,
    ),
};

// Holds what the Worker sends to the queue, here and inside a Durable Object, instead of letting
// the runtime's local queue deliver it: `onSend` gets each message. Until the test ends.
//
// Without it a message goes to the local queue, which hands it to the Worker's queue handler in
// the background, whenever it gets to it. A test that asserts on what was sent, or on what a
// queued job did, holds the queue and delivers the messages itself (`testQueue`).
export function holdQueue(
  // Typed for any handler: a test names the kind of message it expects.
  onSend: (message: never, options?: { delaySeconds?: number }) => unknown = () => undefined,
): void {
  vi.spyOn(runtimeEnv.REFRESH_QUEUE, "send").mockImplementation(async (message, options) => {
    await onSend(message as never, options);
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  });
}

// Holds the queue and keeps what was sent. `deliver` hands the Worker's queue handler every
// message sent so far and the ones it sends meanwhile, one batch each, until none is left or
// `limit` is reached. A message the handler asks to retry is delivered again.
export function testQueue() {
  const pending: WorkerQueueMessage[] = [];
  const sent: Array<{ body: WorkerQueueMessage; delaySeconds?: number }> = [];
  holdQueue((body: WorkerQueueMessage, options) => {
    sent.push({ body, delaySeconds: options?.delaySeconds });
    pending.push(body);
  });
  return {
    sent,
    async deliver(env: TestEnv, context: TestContext, limit = 20): Promise<number> {
      let delivered = 0;
      for (; delivered < limit; delivered += 1) {
        const body = pending.shift();
        if (!body) break;
        await worker.queue(
          { messages: [{ body, attempts: 1, ack() {}, retry: () => void pending.push(body) }] },
          env,
          context,
        );
      }
      return delivered;
    },
  };
}

// Answers the Worker's requests for static assets with `respond`, until the test ends. The
// tests run without a build, so the assets binding has no file to serve.
export function serveAssets(respond: (request: Request) => Response | Promise<Response>): void {
  vi.spyOn(runtimeEnv.ASSETS, "fetch").mockImplementation(async (input, init) =>
    respond(input instanceof Request ? input : new Request(input, init)),
  );
}

const systemDate = Date;

const testClockStartedAt = systemDate.now();

const testClockEpoch = systemDate.parse("2026-06-13T12:00:00Z");

class TestDate extends systemDate {
  constructor(value?: string | number) {
    super(value === undefined ? TestDate.now() : value);
  }

  static override now(): number {
    return testClockEpoch + systemDate.now() - testClockStartedAt;
  }
}

globalThis.Date = TestDate as DateConstructor;

// The font files the Worker reads from ASSETS to render a social card. Vite inlines each as a
// data URL: the Workers runtime has no file system to read them from.
const socialFonts: Record<string, string> = {
  "/jetbrains-mono-latin-400-normal.woff2": font400,
  "/jetbrains-mono-latin-700-normal.woff2": font700,
};

export async function socialRenderAsset(request: Request, paths?: string[]): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  paths?.push(pathname);
  const font = socialFonts[pathname];
  return font
    ? new Response(Buffer.from(font.slice(font.indexOf(",") + 1), "base64"))
    : new Response("not found", {
        status: 404,
      });
}

// Puts the entries into the KV namespace of the Workers runtime and returns the namespace.
export async function cacheWith(initial: Record<string, string> = {}): Promise<KVNamespace> {
  await Promise.all(Object.entries(initial).map(([key, value]) => testCache.put(key, value)));
  return testCache;
}

// The refresh audit log as the database holds it, newest first.
export async function refreshAuditEvents(): Promise<SchedulerAuditEvent[]> {
  const { results } = await testDatabase
    .prepare("SELECT data FROM refresh_audit_events ORDER BY at DESC")
    .all<{ data: string }>();
  return results.map((row) => JSON.parse(row.data) as SchedulerAuditEvent);
}

// The GitHub call counts as the database holds them, one per hour and route key.
export async function githubAccessRouteRecords(): Promise<
  Array<{
    area: string;
    route: string;
    source: string;
    resource: string | null;
    status: number;
    count: number;
  }>
> {
  const { results } = await testDatabase
    .prepare("SELECT area, route, source, resource, status, count FROM github_access_counts")
    .all<{
      area: string;
      route: string;
      source: string;
      resource: string | null;
      status: number;
      count: number;
    }>();
  return results;
}

// How many sign-in funnel events the database holds.
export async function authFunnelEventCount(): Promise<number> {
  const row = await testDatabase
    .prepare("SELECT COUNT(*) AS count FROM auth_funnel_events")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function signedJson(secret: string, value: unknown): Promise<string> {
  const payload = base64Url(textEncoder.encode(JSON.stringify(value)));
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

// A signed-in user, as AI summaries need one to start: stores the session in the cache and
// returns the env entries and request headers that carry it. `vars` are more env entries, such
// as the summary limits.
export async function signedIn(cache: KVNamespace, userId = 1, vars: Record<string, string> = {}) {
  const secret = "test-secret";
  const sessionId = `session-${userId}`;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 600;
  await cache.put(
    `auth:session:${sessionId}`,
    JSON.stringify({
      user: {
        id: userId,
        login: `user-${userId}`,
        name: null,
        avatarUrl: `https://avatars.githubusercontent.com/u/${userId}`,
        url: `https://github.com/user-${userId}`,
      },
      accessToken: "user-token",
      iat: now,
      exp,
      installations: [],
      installationsUpdatedAt: new Date().toISOString(),
    }),
  );
  return {
    env: {
      AUTH_COOKIE_SECRET: secret,
      ...vars,
    },
    headers: { cookie: `rd_session=${await signedJson(secret, { id: sessionId, exp })}` },
  };
}

export async function webhookSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(body)));
  return `sha256=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function crawlerRequest(
  url: string,
  userAgent = "Mozilla/5.0 (Linux; Android 6.0.1) AppleWebKit/537.36 Chrome/148.0 Mobile Safari/537.36 (compatible; GoogleOther)",
  cf: Record<string, unknown> | null = { verifiedBotCategory: "AI Crawler" },
): Request {
  const request = new Request(url, {
    headers: {
      "user-agent": userAgent,
    },
  });
  if (cf) {
    Object.defineProperty(request, "cf", {
      value: cf,
    });
  }
  return request;
}

export function claudeText(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

export function claudeJson(value: unknown): Array<{ type: "text"; text: string }> {
  return claudeText(JSON.stringify(value));
}
