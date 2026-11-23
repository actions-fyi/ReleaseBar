import { DurableObject } from "cloudflare:workers";
import {
  githubWebhookCoalescingWaitMs,
  githubWebhookDeliveryLimit,
  githubWebhookDeliveryTtlMs,
  githubWebhookProcessingLeaseMs,
  type StoredWebhookProcessing,
} from "../config.ts";
import { collectAudit } from "../audit-collector.ts";
import { randomNonce } from "../crypto.ts";
import { sleep } from "../dashboard-rebuild.ts";
import { safeIso } from "../owner-metadata-write.ts";
import type { GitHubWebhookJob, StoredWebhookPending } from "../runtime.ts";
import { withLockJurisdiction } from "../store/bindings.ts";
import { sendQueueMessage } from "../store/queue.ts";
import { processGitHubWebhook } from "../webhook.ts";
import {
  mergePendingWebhook,
  pendingWebhookBatch,
  pendingWebhookFits,
} from "../webhook-targets.ts";
import { firstRow, parseStored } from "./sql.ts";

// How a call to `process` ended.
// - "processed": the job led a batch; `coalesced` entries were processed and `remaining` tells
//   whether a queue job was sent for entries that are still pending.
// - "duplicate": the delivery was processed before.
// - "coalesced": another job is processing; this delivery is pending and will be covered by it.
// - "busy": the job's own earlier attempt still holds the lease; the caller retries later.
// - "full": too many deliveries are pending; the caller retries later.
export type WebhookProcessResult =
  | { state: "processed"; coalesced: number; remaining: boolean }
  | { state: "duplicate" | "coalesced" | "busy" | "full" };

type ActiveRow = {
  job_id: string | null;
  lease_id: string | null;
  delivery: string;
  expires_at: number;
};
type PendingRow = { value: string };

// Processes the GitHub webhooks of one owner, one batch at a time: an instance is named by
// `webhookProcessorObjectName`. The first job to arrive becomes the leader; deliveries that arrive
// while it works are kept as pending, merged by what they refresh, and the leader processes them
// in the same batch.
//
// Every step that reads and changes the object's state runs without awaiting, so no other call
// can come between its reads and writes. Processing itself waits on GitHub, KV and the queue;
// calls that arrive meanwhile see the leader's lease and add to the pending entries.
export class WebhookProcessor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_deliveries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_webhooks (
        position INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS active_processing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        job_id TEXT,
        lease_id TEXT,
        delivery TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  async process(job: GitHubWebhookJob): Promise<WebhookProcessResult> {
    const reservation = this.#reserve(job);
    if (reservation.state !== "leader") return reservation;
    const { leaseId } = reservation;
    // Processing calls other Durable Objects, which live in the Worker's jurisdiction.
    // The audit rows of the whole batch are written together, before the object answers.
    const audit = collectAudit(withLockJurisdiction(this.env), {
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });
    const env = audit.env;
    try {
      await sleep(githubWebhookCoalescingWaitMs);
      const batch = pendingWebhookBatch(this.#pending(), job.delivery);
      for (const entry of batch) {
        const waits: Promise<unknown>[] = [];
        await processGitHubWebhook(
          entry.job.event,
          entry.job.delivery,
          entry.job.payload,
          entry.job.createdAt,
          env,
          { waitUntil: (promise) => waits.push(promise) },
        );
        await Promise.all(waits);
        this.#completeEntry(entry);
      }
      if (this.#active()?.leaseId !== leaseId) {
        return { state: "processed", coalesced: batch.length, remaining: false };
      }
      // The lease is released only once the queue has a job for what is still pending.
      const remaining = await this.#sendNextPending();
      this.#releaseLease(leaseId);
      return { state: "processed", coalesced: batch.length, remaining };
    } catch (error) {
      this.#releaseLease(leaseId);
      throw error;
    } finally {
      await audit.finish();
    }
  }

  // Forgets a delivery that could not be processed: it stops counting as processed or pending,
  // and its lease ends. A queue job is sent for entries that are still pending and have no leader.
  async abandon(delivery: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const active = this.#active();
    const pending = this.#pending().flatMap((entry) => {
      const deliveries = entry.deliveries.filter((item) => item !== delivery);
      const lastDelivery = deliveries.at(-1);
      if (lastDelivery === undefined) return [];
      return [
        {
          ...entry,
          job:
            entry.job.delivery === delivery ? { ...entry.job, delivery: lastDelivery } : entry.job,
          deliveries,
        },
      ];
    });
    const releaseActive =
      active?.delivery === delivery || Boolean(active && active.expiresAt <= Date.now());
    sql.exec("DELETE FROM processed_deliveries WHERE id = ?", delivery);
    this.#putPending(pending);
    if (releaseActive) sql.exec("DELETE FROM active_processing");
    if (!active || releaseActive) await this.#sendNextPending();
  }

  // Decides what `job` does, in one step: lead a batch, wait as a pending entry, or stop.
  #reserve(
    job: GitHubWebhookJob,
  ): { state: "leader"; leaseId: string } | { state: "duplicate" | "coalesced" | "busy" | "full" } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec(
      "DELETE FROM processed_deliveries WHERE processed_at <= ?",
      now - githubWebhookDeliveryTtlMs,
    );
    const processed =
      sql.exec("SELECT 1 FROM processed_deliveries WHERE id = ?", job.delivery).toArray().length >
      0;
    const currentPending = this.#pending().filter(
      (entry) => now - safeIso(entry.job.createdAt) < githubWebhookDeliveryTtlMs,
    );
    const pending = processed ? currentPending : mergePendingWebhook(currentPending, job);
    if (!pendingWebhookFits(pending)) return { state: "full" };
    const active = this.#active();
    if (processed && pending.length === 0) {
      if (
        active &&
        (active.jobId === job.id || active.delivery === job.delivery || active.expiresAt <= now)
      ) {
        sql.exec("DELETE FROM active_processing");
      }
      return { state: "duplicate" };
    }
    this.#putPending(pending);
    if (active && active.expiresAt > now) {
      if (processed && active.jobId === job.id) return this.#lead(job, now);
      // Keep the active delivery retryable after a crash; followers are now durably covered.
      if (!active.jobId || active.jobId === job.id) return { state: "busy" };
      return { state: "coalesced" };
    }
    return this.#lead(job, now);
  }

  #lead(job: GitHubWebhookJob, now: number): { state: "leader"; leaseId: string } {
    const leaseId = randomNonce();
    this.ctx.storage.sql.exec(
      `INSERT INTO active_processing (id, job_id, lease_id, delivery, expires_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET job_id = excluded.job_id, lease_id = excluded.lease_id,
         delivery = excluded.delivery, expires_at = excluded.expires_at`,
      job.id,
      leaseId,
      job.delivery,
      now + githubWebhookProcessingLeaseMs,
    );
    return { state: "leader", leaseId };
  }

  // Records the entry's deliveries as processed and takes the entry off the pending ones.
  #completeEntry(entry: StoredWebhookPending): void {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec(
      "DELETE FROM processed_deliveries WHERE processed_at <= ?",
      now - githubWebhookDeliveryTtlMs,
    );
    const completed = new Set(entry.deliveries);
    for (const delivery of completed) {
      sql.exec(
        "INSERT OR IGNORE INTO processed_deliveries (id, processed_at) VALUES (?, ?)",
        delivery,
        now,
      );
    }
    // Only the newest deliveries are remembered.
    sql.exec(
      `DELETE FROM processed_deliveries WHERE sequence <= (
        SELECT sequence FROM processed_deliveries ORDER BY sequence DESC LIMIT 1 OFFSET ?
      )`,
      githubWebhookDeliveryLimit,
    );
    this.#putPending(
      this.#pending().flatMap((candidate) => {
        if (candidate.key !== entry.key) return [candidate];
        if (candidate.revision === entry.revision) return [];
        // A newer event arrived while this entry ran; retain only its unprocessed deliveries.
        const remaining = candidate.deliveries.filter((item) => !completed.has(item));
        return remaining.length > 0 ? [{ ...candidate, deliveries: remaining }] : [];
      }),
    );
  }

  // Sends a queue job for the oldest pending entry. False when nothing is pending.
  async #sendNextPending(): Promise<boolean> {
    const pending = this.#pending();
    if (pending.length === 0) return false;
    const next = pendingWebhookBatch(pending, "")[0];
    if (!next) throw new Error("webhook batch unavailable");
    await sendQueueMessage(this.env, { ...next.job, id: randomNonce(), attempts: 0 });
    return true;
  }

  #releaseLease(leaseId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM active_processing WHERE lease_id = ?", leaseId);
  }

  #active(): StoredWebhookProcessing | null {
    const row = firstRow(
      this.ctx.storage.sql.exec<ActiveRow>(
        "SELECT job_id, lease_id, delivery, expires_at FROM active_processing",
      ),
    );
    return row
      ? {
          ...(row.job_id === null ? {} : { jobId: row.job_id }),
          ...(row.lease_id === null ? {} : { leaseId: row.lease_id }),
          delivery: row.delivery,
          expiresAt: row.expires_at,
        }
      : null;
  }

  #pending(): StoredWebhookPending[] {
    return this.ctx.storage.sql
      .exec<PendingRow>("SELECT value FROM pending_webhooks ORDER BY position")
      .toArray()
      .map((row) => parseStored<StoredWebhookPending>(row.value));
  }

  #putPending(pending: StoredWebhookPending[]): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM pending_webhooks");
    pending.forEach((entry, position) => {
      sql.exec(
        "INSERT INTO pending_webhooks (position, value) VALUES (?, ?)",
        position,
        JSON.stringify(entry),
      );
    });
  }
}
