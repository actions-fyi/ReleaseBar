// GitHub webhook deliveries: one Durable Object admits each delivery once and puts it on the
// queue, and one per owner processes that owner's deliveries a batch at a time. Both stay Durable
// Objects (docs/data-model.md).
//
// Every function rejects when the object can't be reached.

import type { WebhookAdmissionResult } from "../objects/webhook-admission.ts";
import type { WebhookProcessResult } from "../objects/webhook-processor.ts";
import {
  type GitHubWebhookJob,
  webhookAdmissionObjectName,
  webhookProcessorObjectName,
} from "../runtime.ts";

// Puts the delivery on the queue unless it was admitted before.
export async function admitWebhookDelivery(
  env: Env,
  event: string,
  delivery: string,
  payload: Record<string, unknown>,
): Promise<WebhookAdmissionResult> {
  return await env.WEBHOOK_ADMISSION.getByName(webhookAdmissionObjectName).enqueue(
    event,
    delivery,
    payload,
  );
}

// Forgets that the delivery was admitted, so GitHub can send it again.
export async function forgetWebhookAdmission(env: Env, delivery: string): Promise<void> {
  await env.WEBHOOK_ADMISSION.getByName(webhookAdmissionObjectName).abandon(delivery);
}

// Processes the job in the owner's processor, with the deliveries that are pending there.
export async function processWebhookJob(
  env: Env,
  owner: string,
  job: GitHubWebhookJob,
): Promise<WebhookProcessResult> {
  return await env.WEBHOOK_PROCESSOR.getByName(webhookProcessorObjectName(owner)).process(job);
}

// Forgets a delivery in the owner's processor: it stops counting as processed or pending.
export async function forgetWebhookProcessing(
  env: Env,
  owner: string,
  delivery: string,
): Promise<void> {
  await env.WEBHOOK_PROCESSOR.getByName(webhookProcessorObjectName(owner)).abandon(delivery);
}
