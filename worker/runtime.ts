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
export const refreshTargetIndexName = (kind: "owner" | "repo", value: string): string =>
  `refresh-target-index:${kind}:${value}`;

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
