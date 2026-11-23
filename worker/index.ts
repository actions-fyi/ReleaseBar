import { validOwnerSlug } from "../shared/dashboard.ts";
import { decodedPathParts } from "../src/routing.ts";
import type { RefreshJob } from "../src/types.ts";
import { corsHeaders, jsonResponse } from "./http.ts";
import { openApiSpec } from "./openapi.ts";
import {
  isOwnerActivityApiPath,
  isOwnerApiPath,
  isOwnerEventsApiPath,
  isOwnerRefreshApiPath,
  isRepoActivityApiPath,
  isRepoAudienceApiPath,
  isRepoAudienceBackfillApiPath,
  isRepoDetailApiPath,
  isTrustProfileApiPath,
} from "./routes.ts";
import {
  webhookProcessorObjectName,
  type WorkerQueueMessage,
  withLockJurisdiction,
} from "./runtime.ts";
import { ownerActivityResponse, repoActivityResponse } from "./activity.ts";
import { adminResponse, profileResponse } from "./admin.ts";
import { assetResponse, ownerActivityPageOwner } from "./app-shell.ts";
import {
  repoAudienceBackfillResponse,
  repoAudienceResponse,
  trustProfileResponse,
} from "./audience.ts";
import { meResponse } from "./auth-oauth.ts";
import { authResponse } from "./auth-tokens.ts";
import { hotResponse } from "./build-progress.ts";
import {
  buildLockRetrySeconds,
  githubWebhookDeliveryTtlMs,
  githubWebhookRequeueLimit,
  incompleteBuildRetrySeconds,
  refreshQueueMaxAttempts,
  schedulerBatchLimit,
  webhookPriorityFanoutRetrySeconds,
} from "./config.ts";
import { errorMessage } from "./dashboard-cache.ts";
import { ownerEventsResponse } from "./dashboard-rebuild.ts";
import { discoverResponse } from "./discover.ts";
import { safeIso } from "./owner-metadata-write.ts";
import { ownerResponse } from "./owner-response.ts";
import { finishRefreshJobReservation, schedulerTick } from "./refresh-queue.ts";
import {
  auditSyncEvent,
  clientTimingResponse,
  isGitHubWebhookFanoutJob,
  isGitHubWebhookJob,
  readRefreshJob,
} from "./refresh-targets.ts";
import { repoDetailResponse } from "./repo-detail-response.ts";
import { failExhaustedRefreshJob, processRefreshJob } from "./scheduler.ts";
import { socialCardForLabel, socialImage, socialPng, socialRouteLabel } from "./social-card.ts";
import {
  abandonGitHubWebhookDelivery,
  githubWebhookProcessorBusy,
  githubWebhookResponse,
  githubWebhookRetryDelaySeconds,
  processGitHubWebhookFanout,
} from "./webhook.ts";
import { webhookRepo } from "./webhook-targets.ts";

export { BuildCoordinator } from "./objects/build-coordinator.ts";
export { OwnerMetadata } from "./objects/owner-metadata.ts";
export { RefreshTargetIndex } from "./objects/refresh-target-index.ts";
export { SummaryQuota } from "./objects/summary-quota.ts";
export { WebhookAdmission } from "./objects/webhook-admission.ts";
export { WebhookProcessor } from "./objects/webhook-processor.ts";

export default {
  async fetch(request: Request, rawEnv: Env, context: ExecutionContext): Promise<Response> {
    const env = withLockJurisdiction(rawEnv);
    const url = new URL(request.url);
    const isHead = request.method === "HEAD";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const profileWrite =
      url.pathname.startsWith("/api/profile/") &&
      (request.method === "POST" || request.method === "DELETE");
    const audienceBackfillWrite =
      isRepoAudienceBackfillApiPath(url.pathname) && request.method === "POST";
    const adminWrite =
      (url.pathname === "/api/admin/scheduler/run" ||
        url.pathname === "/api/admin/installations/sync") &&
      request.method === "POST";
    const ownerRefreshWrite = isOwnerRefreshApiPath(url.pathname) && request.method === "POST";
    const clientTimingWrite = url.pathname === "/api/_client-timing" && request.method === "POST";
    const githubWebhookWrite = url.pathname === "/api/github/webhook" && request.method === "POST";
    if (
      request.method !== "GET" &&
      !isHead &&
      !profileWrite &&
      !audienceBackfillWrite &&
      !adminWrite &&
      !ownerRefreshWrite &&
      !clientTimingWrite &&
      !githubWebhookWrite
    ) {
      return jsonResponse({ error: "method not allowed" }, 405, { allow: "GET" });
    }
    const response = await routeRequest(request, env, context, url);
    if (!isHead) {
      return response;
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
  async scheduled(
    controller: ScheduledController,
    rawEnv: Env,
    context: ExecutionContext,
  ): Promise<void> {
    const env = withLockJurisdiction(rawEnv);
    context.waitUntil(schedulerTick(env, context, `cron:${controller.cron}`, schedulerBatchLimit));
  },
  async queue(
    batch: MessageBatch<WorkerQueueMessage>,
    rawEnv: Env,
    context: ExecutionContext,
  ): Promise<void> {
    const env = withLockJurisdiction(rawEnv);
    for (const message of batch.messages) {
      if (isGitHubWebhookFanoutJob(message.body)) {
        const fanoutJob = message.body;
        try {
          await processGitHubWebhookFanout(fanoutJob, env, context);
          message.ack();
        } catch (error) {
          const delaySeconds = await githubWebhookRetryDelaySeconds(env, error);
          const attempts = message.attempts ?? 1;
          const expired = Date.now() - safeIso(fanoutJob.createdAt) >= githubWebhookDeliveryTtlMs;
          if (attempts >= refreshQueueMaxAttempts || expired) {
            try {
              await abandonGitHubWebhookDelivery(env, fanoutJob.delivery, fanoutJob.payload);
            } catch (abandonError) {
              await auditSyncEvent(env, {
                event: "github_webhook_admission_abandon_failed",
                status: "failed",
                reason: errorMessage(abandonError),
                detail: `githubEvent=${fanoutJob.event} delivery=${fanoutJob.delivery} fanout=true`,
              });
              message.retry({ delaySeconds: Math.min(delaySeconds, 5 * 60) });
              continue;
            }
            await auditSyncEvent(env, {
              event: "github_webhook_fanout_failed",
              status: "failed",
              reason: `${errorMessage(error)}; durable retry limit reached`,
              detail: `githubEvent=${fanoutJob.event} delivery=${fanoutJob.delivery} source=${fanoutJob.source} attempts=${attempts}`,
            }).catch(() => undefined);
            message.ack();
            continue;
          }
          await auditSyncEvent(env, {
            event: "github_webhook_fanout_failed",
            status: "failed",
            reason: errorMessage(error),
            detail: `githubEvent=${fanoutJob.event} delivery=${fanoutJob.delivery} source=${fanoutJob.source} attempts=${attempts}`,
          }).catch(() => undefined);
          message.retry({ delaySeconds: Math.min(delaySeconds, 5 * 60) });
        }
        continue;
      }
      if (isGitHubWebhookJob(message.body)) {
        const webhookJob = message.body;
        try {
          const owner = webhookRepo(webhookJob.payload)?.owner ?? webhookJob.delivery;
          const result = await env.WEBHOOK_PROCESSOR.getByName(
            webhookProcessorObjectName(owner),
          ).process(webhookJob);
          if (result.state === "busy") throw new Error("webhook processor busy");
          if (result.state === "full") throw new Error("webhook coalescer full");
          message.ack();
        } catch (error) {
          const delaySeconds = await githubWebhookRetryDelaySeconds(env, error);
          const attempts = githubWebhookProcessorBusy(error)
            ? (webhookJob.attempts ?? 0)
            : (webhookJob.attempts ?? 0) + 1;
          const expired = Date.now() - safeIso(webhookJob.createdAt) >= githubWebhookDeliveryTtlMs;
          if (attempts > githubWebhookRequeueLimit || expired) {
            try {
              await abandonGitHubWebhookDelivery(env, webhookJob.delivery, webhookJob.payload);
            } catch (abandonError) {
              await auditSyncEvent(env, {
                event: "github_webhook_admission_abandon_failed",
                status: "failed",
                reason: errorMessage(abandonError),
                detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery}`,
              });
              message.retry({ delaySeconds: webhookPriorityFanoutRetrySeconds });
              continue;
            }
            await auditSyncEvent(env, {
              event: "github_webhook_failed",
              status: "failed",
              reason: `${errorMessage(error)}; durable requeue limit reached`,
              detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery} attempts=${attempts}`,
            });
            message.ack();
            continue;
          }
          try {
            if (!env.REFRESH_QUEUE) throw new Error("webhook queue unavailable");
            await env.REFRESH_QUEUE.send(
              {
                ...webhookJob,
                id: webhookJob.id,
                attempts,
              },
              { delaySeconds },
            );
            await auditSyncEvent(env, {
              event: "github_webhook_requeued",
              status: "queued",
              reason: errorMessage(error),
              detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery} delaySeconds=${delaySeconds}`,
            });
            message.ack();
          } catch (requeueError) {
            await auditSyncEvent(env, {
              event: "github_webhook_failed",
              status: "failed",
              reason: `${errorMessage(error)}; requeue failed: ${errorMessage(requeueError)}`,
              detail: `githubEvent=${webhookJob.event} delivery=${webhookJob.delivery}`,
            });
            message.retry({ delaySeconds: Math.min(delaySeconds, 5 * 60) });
          }
        }
        continue;
      }
      const deliveryAttempts = message.attempts ?? message.body.attempts + 1;
      const exhausted = deliveryAttempts >= refreshQueueMaxAttempts;
      let processedJob: RefreshJob | null = null;
      try {
        const job = await processRefreshJob(message.body, env, !exhausted);
        processedJob = job;
        if (job.status === "queued") {
          const delaySeconds =
            job.error === "dashboard locked" ||
            job.error === "dashboard stalled" ||
            job.error === "dashboard deadline reached" ||
            job.error === "target snapshot unavailable" ||
            job.error === "profile snapshot unavailable"
              ? buildLockRetrySeconds
              : incompleteBuildRetrySeconds;
          if (exhausted) {
            await failExhaustedRefreshJob(job, env, deliveryAttempts);
            await finishRefreshJobReservation(env, context, job);
            message.retry({ delaySeconds });
            continue;
          }
          message.retry({
            delaySeconds,
          });
        } else {
          await finishRefreshJobReservation(env, context, job);
          message.ack();
        }
      } catch (error) {
        if (exhausted) {
          const job =
            processedJob ??
            (await readRefreshJob(env, message.body.id).catch(() => null)) ??
            message.body;
          if (job.status === "queued" || job.status === "running") {
            await failExhaustedRefreshJob(
              { ...job, error: errorMessage(error) },
              env,
              deliveryAttempts,
            ).catch(() => undefined);
          }
          await finishRefreshJobReservation(env, context, job).catch(() => undefined);
        }
        message.retry({ delaySeconds: 300 });
      }
    }
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;

export async function routeRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (!decodedPathParts(url.pathname)) {
    return jsonResponse({ error: "invalid path encoding" }, 400, { "cache-control": "no-store" });
  }
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    ownerActivityPageOwner(url.pathname)
  ) {
    return assetResponse(request, env);
  }
  if (url.pathname.startsWith("/og/")) {
    const { label, extension } = socialRouteLabel(url.pathname);
    const title =
      label.startsWith("@") || label.includes("/") || !validOwnerSlug(label) ? label : `@${label}`;
    const card = await socialCardForLabel(title, request, env, context);
    if (extension === "png") return await socialPng(card, request, env);
    return await socialImage(card);
  }
  if (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json") {
    return jsonResponse(openApiSpec(url.origin));
  }
  if (url.pathname === "/api/swagger.json") {
    return jsonResponse(openApiSpec(url.origin));
  }
  if (url.pathname === "/api/me") {
    return meResponse(request, env);
  }
  if (url.pathname === "/api/_client-timing" && request.method === "POST") {
    return clientTimingResponse(request, env, context);
  }
  if (url.pathname === "/api/github/webhook" && request.method === "POST") {
    return githubWebhookResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/admin/")) {
    return adminResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/profile/")) {
    return profileResponse(request, env);
  }
  if (url.pathname.startsWith("/api/auth/")) {
    return authResponse(request, env, context);
  }
  if (url.pathname === "/api/_hot") {
    return hotResponse(env, context);
  }
  if (url.pathname === "/api/_discover") {
    return discoverResponse(request, env, url, context);
  }
  if (isOwnerActivityApiPath(url.pathname)) {
    return ownerActivityResponse(request, env, context);
  }
  if (isRepoActivityApiPath(url.pathname)) {
    return repoActivityResponse(request, env, context);
  }
  if (isTrustProfileApiPath(url.pathname)) {
    return trustProfileResponse(request, env, context);
  }
  if (isRepoAudienceBackfillApiPath(url.pathname)) {
    return repoAudienceBackfillResponse(request, env);
  }
  if (isRepoAudienceApiPath(url.pathname)) {
    return repoAudienceResponse(request, env, context);
  }
  if (isRepoDetailApiPath(url.pathname)) {
    return repoDetailResponse(request, env, context);
  }
  if (isOwnerEventsApiPath(url.pathname)) {
    return ownerEventsResponse(request, env);
  }
  if (isOwnerApiPath(url.pathname)) {
    return ownerResponse(request, env, context);
  }
  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not found" }, 404, { "cache-control": "no-store" });
  }
  return assetResponse(request, env);
}
