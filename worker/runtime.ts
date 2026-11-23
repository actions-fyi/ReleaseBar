import type { RefreshJob } from "../src/types.ts";

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

// What code that only schedules background work needs of the execution context. The Durable Object
// passes its own, to await that work before it answers.
export type BackgroundContext = Pick<ExecutionContext, "waitUntil">;

// The name of each Durable Object instance. A name is all that addresses an instance, so every
// caller builds it here.
export const summaryQuotaObjectName = "summary-quota";
export const webhookAdmissionObjectName = "github-webhook-admission";
export const webhookProcessorObjectName = (owner: string): string =>
  `github-webhook-process:${owner}`;
export const ownerMetadataObjectName = (owner: string): string => `owner-metadata:${owner}`;
export const refreshTargetIndexName = (kind: "owner" | "repo", value: string): string =>
  `refresh-target-index:${kind}:${value}`;

type DurableObjectBinding = {
  [Name in keyof Env]-?: Env[Name] extends Pick<DurableObjectNamespace, "idFromName">
    ? Name
    : never;
}[keyof Env];

// Every Durable Object binding of wrangler.jsonc: the type fails when one is missing here.
const durableObjectBindingNames: Record<DurableObjectBinding, true> = {
  BUILD_COORDINATOR: true,
  OWNER_METADATA: true,
  REFRESH_TARGET_INDEX: true,
  SUMMARY_QUOTA: true,
  WEBHOOK_ADMISSION: true,
  WEBHOOK_PROCESSOR: true,
};
export const durableObjectBindings = Object.keys(
  durableObjectBindingNames,
) as DurableObjectBinding[];

const jurisdictionEnvs = new WeakMap<Env, { jurisdiction: string; scoped: Env }>();

// Scopes every Durable Object binding to the jurisdiction in RELEASEBAR_DO_JURISDICTION (such as
// "eu"), so every Durable Object is created and stored only there. Unset, the bindings are used
// as they are. Each handler, and each Durable Object that calls another one, passes its env
// through here before it uses a binding.
export function withLockJurisdiction(env: Env): Env {
  const jurisdiction = env.RELEASEBAR_DO_JURISDICTION?.trim();
  if (!jurisdiction) return env;
  const known = jurisdictionEnvs.get(env);
  if (known?.jurisdiction === jurisdiction) return known.scoped;
  const scoped: Env = { ...env };
  for (const binding of durableObjectBindings) {
    const namespace: DurableObjectNamespace = env[binding];
    if (typeof namespace.jurisdiction !== "function") {
      throw new Error(`RELEASEBAR_DO_JURISDICTION is set, but ${binding} has no jurisdictions`);
    }
    Object.assign(scoped, {
      [binding]: namespace.jurisdiction(jurisdiction as DurableObjectJurisdiction),
    });
  }
  jurisdictionEnvs.set(env, { jurisdiction, scoped });
  return scoped;
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
