import font400 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?inline";
import font700 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?inline";

import { runInDurableObject } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { vi } from "vitest";
import type { SchedulerAuditEvent } from "../src/types.ts";
import handler, {
  BuildCoordinator,
  OwnerMetadata,
  RefreshTargetIndex,
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
import {
  ownerMetadataObjectName,
  refreshTargetIndexName,
  type WorkerQueueMessage,
} from "../worker/runtime.ts";

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
  RefreshTargetIndex,
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
  for (const binding of durableObjectBindings) {
    bindings[binding] ??= objectBinding(binding, env);
  }
  return env as unknown as Env;
}

export {
  BuildCoordinator,
  OwnerMetadata,
  RefreshTargetIndex,
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

// The index of the refresh targets that show an owner or a repository.
export function targetIndex(
  env: TestEnv,
  kind: "owner" | "repo",
  value: string,
): DurableObjectStub<RefreshTargetIndex> {
  return testEnv(env).REFRESH_TARGET_INDEX.getByName(refreshTargetIndexName(kind, value));
}

// Fills an index with as many targets as it takes, so that it refuses the next new one.
export async function fillTargetIndex(
  env: TestEnv,
  kind: "owner" | "repo",
  value: string,
): Promise<void> {
  const index = targetIndex(env, kind, value);
  const now = new Date().toISOString();
  for (let count = 0; count < refreshTargetSourceLimit; count += 1) {
    await index.upsert({
      key: `filler:${kind}:${value}:${count}`,
      kind: "dashboard",
      owner: "filler",
      owners: ["filler"],
      repos: [],
      includeReleaseData: true,
      path: `/filler?variant=${count}`,
      priority: 1,
      lastSeenAt: now,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextDueAt: now,
      failureCount: 0,
    });
  }
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

export async function refreshAuditEvents(
  cache: ReturnType<typeof kvStore>,
): Promise<SchedulerAuditEvent[]> {
  const current = await cache.list({ prefix: "refresh:audit:v2:" });
  return (
    await Promise.all(
      current.keys.map(
        async (key) => JSON.parse((await cache.get(key.name)) ?? "{}") as SchedulerAuditEvent,
      ),
    )
  )
    .filter((event) => event.event)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export async function githubAccessRouteRecords(cache: ReturnType<typeof kvStore>): Promise<
  Array<{
    area?: string;
    route?: string;
    source?: string;
    resource?: string | null;
    status?: number;
  }>
> {
  const accessKeys = await cache.list({ prefix: "github:access:v1:" });
  const records = await Promise.all(
    accessKeys.keys.map(async (key) => JSON.parse((await cache.get(key.name)) ?? "{}")),
  );
  return records.flatMap((record) =>
    record.routes && typeof record.routes === "object" ? Object.values(record.routes) : [record],
  );
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
