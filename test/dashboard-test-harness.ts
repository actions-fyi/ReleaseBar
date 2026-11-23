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
  OwnerMetadata,
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
import { durableObjectBindings } from "../worker/store/bindings.ts";
import { refreshTargetSources } from "../worker/refresh-targets.ts";
import { ownerMetadataObjectName, type WorkerQueueMessage } from "../worker/runtime.ts";
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

export { testDashboard, testProject } from "./dashboard-fixtures.ts";

const textEncoder = new TextEncoder();

// The tests hand the Worker hand-written fakes with only what a case needs of the KV, queue and
// assets bindings, not the generated binding types. These types describe the fakes; `worker` and
// `testEnv` pass them on as the real ones. The Durable Objects are not faked: `testEnv` adds the
// bindings the Workers runtime provides from wrangler.jsonc.
type FakeKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

type FakeBindings = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  DASHBOARD_CACHE: FakeKv;
  REFRESH_QUEUE: { send(message: never, options?: { delaySeconds?: number }): Promise<void> };
};

export type TestEnv = Partial<Omit<Env, keyof FakeBindings> & FakeBindings>;

type TestContext = { waitUntil(promise: Promise<unknown>): void };

type TestBatch = {
  messages: Array<{
    body: WorkerQueueMessage;
    attempts?: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
};

type ObjectBinding = (typeof durableObjectBindings)[number];

const objectClasses = [
  BuildCoordinator,
  OwnerMetadata,
  RateLimiter,
  SummaryQuota,
  WebhookAdmission,
  WebhookProcessor,
];

// The env each Durable Object is to run its next call with, by the object's ID.
const objectEnvs = new Map<string, object>();

// The objects are the real local ones, with their SQLite storage, and are called over RPC as in
// production. But the runtime constructs them with its own env, whose KV namespace and queue are
// not the fakes a test asserts on. So each method of each class first takes the env of the test
// that called it. The objects run in the tests' isolate, which is what lets them see `objectEnvs`.
for (const objectClass of objectClasses) {
  const prototype = objectClass.prototype as unknown as Record<
    string,
    (this: { ctx: DurableObjectState; env: object }, ...parameters: unknown[]) => unknown
  >;
  for (const method of Object.getOwnPropertyNames(prototype)) {
    const original = prototype[method];
    if (method === "constructor" || typeof original !== "function") continue;
    prototype[method] = function (...parameters) {
      this.env = objectEnvs.get(this.ctx.id.toString()) ?? this.env;
      return Reflect.apply(original, this, parameters);
    };
  }
}

// Stub members that are not methods of the object's class.
const stubMembers = new Set(["then", "fetch", "connect", "id", "name", "dup"]);

// A Durable Object binding of the Workers runtime for one test's env: calls through it reach the
// object with that env.
function objectBinding<Binding extends ObjectBinding>(binding: Binding, env: object): Env[Binding] {
  const namespace: DurableObjectNamespace = runtimeEnv[binding];
  const withTestEnv = (stub: DurableObjectStub): DurableObjectStub =>
    new Proxy(stub, {
      get(target, property) {
        const member: unknown = Reflect.get(target, property);
        if (
          typeof property !== "string" ||
          typeof member !== "function" ||
          stubMembers.has(property)
        ) {
          return member;
        }
        return (...parameters: unknown[]): unknown => {
          objectEnvs.set(target.id.toString(), env);
          return Reflect.apply(member, target, parameters);
        };
      },
    });
  const fake = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => withTestEnv(namespace.get(id)),
    getByName: (name: string) => withTestEnv(namespace.getByName(name)),
  };
  return fake as unknown as Env[Binding];
}

// Completes a test's env with the Durable Object bindings, in place: a test may keep changing the
// object it passed.
export function testEnv(env: TestEnv): Env {
  const bindings = env as Record<string, unknown>;
  // The queue binding is required. A test that gives none gets the local queue of the Workers
  // runtime; its messages reach the Worker's queue handler with the runtime's own env.
  bindings.REFRESH_QUEUE ??= runtimeEnv.REFRESH_QUEUE;
  // The D1 database is the local one of the Workers runtime, with the SQL files of migrations/
  // applied (test/reset-storage.ts).
  bindings.DB ??= runtimeEnv.DB;
  for (const binding of durableObjectBindings) {
    bindings[binding] ??= objectBinding(binding, env);
  }
  return env as unknown as Env;
}

export {
  BuildCoordinator,
  OwnerMetadata,
  RateLimiter,
  SummaryQuota,
  WebhookAdmission,
  WebhookProcessor,
};

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
// state from the cache again: for a test that writes a target to the cache directly.
export async function forgetRefreshTargetState(key: string): Promise<void> {
  await runInDurableObject(runtimeEnv.BUILD_COORDINATOR.getByName(key), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM refresh_target");
  });
}

// The refresh data is in the local D1 database of the Workers runtime, which every env of a test
// shares (`testEnv`). These helpers write and read it through the store functions, as the Worker
// does.
const databaseEnv = runtimeEnv;

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

// Lists as many targets under a source as it takes, so that the store refuses the next new one.
export async function fillTargetSource(kind: "owner" | "repo", value: string): Promise<void> {
  const database = databaseEnv.DB;
  const insert = database.prepare(
    "INSERT INTO refresh_target_sources (kind, value, target_key) VALUES (?, ?, ?)",
  );
  await database.batch(
    Array.from({ length: refreshTargetSourceLimit }, (_, count) =>
      insert.bind(kind, value, `filler:${kind}:${value}:${count}`),
    ),
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
  const real = runtimeEnv.DB;
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

// Applies mutations to an owner's metadata in its Durable Object, as the Worker does.
export function ownerMetadataMutator(
  env: TestEnv,
  owner: string,
): (mutation: OwnerMetadataMutation) => Promise<OwnerMetadataSnapshot | null> {
  const metadata = testEnv(env).OWNER_METADATA.getByName(ownerMetadataObjectName(owner));
  return (mutation) => metadata.mutate(owner, mutation);
}

export const worker = {
  fetch: (request: Request, env: TestEnv, context: TestContext): Promise<Response> =>
    handler.fetch(request, testEnv(env), context as ExecutionContext),
  scheduled: (
    event: { cron: string; scheduledTime: number },
    env: TestEnv,
    context: TestContext,
  ): Promise<void> =>
    handler.scheduled(event as ScheduledController, testEnv(env), context as ExecutionContext),
  queue: (batch: TestBatch, env: TestEnv, context: TestContext): Promise<void> =>
    handler.queue(
      batch as unknown as MessageBatch<WorkerQueueMessage>,
      testEnv(env),
      context as ExecutionContext,
    ),
};

// A queue for a test that needs the Worker's queue handler to run with the test's own env. The
// local queue of the Workers runtime can't do that: it delivers with the runtime's env, whose KV
// namespace is not the one the test reads. `deliver` hands the handler every message sent so
// far and the ones it sends meanwhile, one batch each, until none is left or `limit` is reached.
// A message the handler asks to retry is delivered again.
export function testQueue() {
  const pending: WorkerQueueMessage[] = [];
  const sent: Array<{ body: WorkerQueueMessage; delaySeconds?: number }> = [];
  return {
    sent,
    async send(body: WorkerQueueMessage, options?: { delaySeconds?: number }): Promise<void> {
      sent.push({ body, delaySeconds: options?.delaySeconds });
      pending.push(body);
    },
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

export function kvStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const names = [...values.keys()]
        .filter((key) => !options.prefix || key.startsWith(options.prefix))
        .sort();
      const start = Number.parseInt(options.cursor ?? "0", 10) || 0;
      const limit = options.limit ?? names.length;
      const page = names.slice(start, start + limit);
      const next = start + page.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: next >= names.length,
        ...(next < names.length ? { cursor: String(next) } : {}),
      };
    },
  };
}

// The refresh audit log as the database holds it, newest first.
export async function refreshAuditEvents(): Promise<SchedulerAuditEvent[]> {
  const { results } = await runtimeEnv.DB.prepare(
    "SELECT data FROM refresh_audit_events ORDER BY at DESC",
  ).all<{ data: string }>();
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
  const { results } = await runtimeEnv.DB.prepare(
    "SELECT area, route, source, resource, status, count FROM github_access_counts",
  ).all<{
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
  const row = await runtimeEnv.DB.prepare(
    "SELECT COUNT(*) AS count FROM auth_funnel_events",
  ).first<{ count: number }>();
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
export async function signedIn(
  cache: ReturnType<typeof kvStore>,
  userId = 1,
  vars: Record<string, string> = {},
) {
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
