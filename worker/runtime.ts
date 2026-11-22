import type { RefreshJob } from "../src/types.js";

export type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
};

export type DurableObjectId = unknown;

export type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
  jurisdiction?(jurisdiction: string): DurableObjectNamespace;
};

export type Queue<Message = unknown> = {
  send(message: Message, options?: { delaySeconds?: number }): Promise<void>;
};

export type GitHubWebhookJob = {
  kind: "github-webhook";
  id: string;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempts?: number;
};

export type StoredWebhookPending = {
  key: string;
  revision: string;
  job: GitHubWebhookJob;
  deliveries: string[];
};

export type WebhookTargetAction = {
  reason: string;
  includeReleaseDataOnly: boolean;
  invalidateDashboard: boolean;
  recentTargetsOnly?: boolean;
  prioritizedTargetKeys?: string[];
};

export type GitHubWebhookFanoutJob = {
  kind: "github-webhook-fanout";
  id: string;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
  createdAt: string;
  action: WebhookTargetAction;
  source: "indexed" | "owner" | "repo" | "kv-owner" | "kv-repo" | "legacy";
  priorityBatchStartedAt?: string;
  cursor?: string;
  backfillFailed?: boolean;
};

export type WorkerQueueMessage = RefreshJob | GitHubWebhookJob | GitHubWebhookFanoutJob;

export type MessageBatch<Message = unknown> = {
  messages: Array<{
    body: Message;
    attempts?: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
  }>;
};

export type DurableObjectState = {
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
};

export type Env = {
  ADMIN_LOGINS?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AUTH_COOKIE_SECRET?: string;
  DASHBOARD_CACHE?: KVNamespace;
  DASHBOARD_LOCKS?: DurableObjectNamespace;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_SUMMARY_MODEL?: string;
  RELEASEDECK_CANONICAL_DOMAIN?: string;
  RELEASEBAR_DO_JURISDICTION?: string;
  REFRESH_QUEUE?: Queue<WorkerQueueMessage>;
};

const jurisdictionLocks = new WeakMap<DurableObjectNamespace, DurableObjectNamespace>();

// Scopes DASHBOARD_LOCKS to the jurisdiction in RELEASEBAR_DO_JURISDICTION (such as "eu"), so every
// Durable Object is created and stored only there. Unset, the binding is used as it is.
export function withLockJurisdiction(env: Env): Env {
  const jurisdiction = env.RELEASEBAR_DO_JURISDICTION?.trim();
  const locks = env.DASHBOARD_LOCKS;
  if (!jurisdiction || !locks) return env;
  if (!locks.jurisdiction) {
    throw new Error("RELEASEBAR_DO_JURISDICTION is set, but DASHBOARD_LOCKS has no jurisdictions");
  }
  const scoped = jurisdictionLocks.get(locks) ?? locks.jurisdiction(jurisdiction);
  jurisdictionLocks.set(locks, scoped);
  return { ...env, DASHBOARD_LOCKS: scoped };
}

// A leading http(s) scheme: matches "https://releasebar.example.com", rejects "releasebar.example.com".
// https://regex101.com/?regex=%5Ehttps%3F%3A%5C%2F%5C%2F&flags=i&testString=https%3A%2F%2Freleasebar.example.com
const schemePrefix = /^https?:\/\//i;

// The host the deployment is served from, without scheme or path: RELEASEDECK_CANONICAL_DOMAIN,
// else the request's host, else localhost.
export function canonicalDomain(env: Env, url?: URL): string {
  const configured = (
    env.RELEASEDECK_CANONICAL_DOMAIN?.trim().replace(schemePrefix, "") ?? ""
  ).split("/")[0];
  return configured || url?.host || "localhost";
}

export type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type ScheduledEvent = {
  cron: string;
  scheduledTime: number;
};

export type RequestCf = {
  verifiedBotCategory?: string;
  botManagement?: {
    verifiedBot?: boolean;
  };
};
