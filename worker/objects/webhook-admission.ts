import { DurableObject } from "cloudflare:workers";
import { githubWebhookDeliveryLimit, githubWebhookDeliveryTtlMs } from "../config.ts";
import { randomNonce } from "../crypto.ts";
import { sendQueueMessage } from "../store/queue.ts";
import { SerialQueue } from "./serial.ts";

export type WebhookAdmissionResult = "queued" | "duplicate";

// Admits each GitHub webhook delivery once: the single instance named by
// `webhookAdmissionObjectName` remembers the deliveries it put on the queue, so a delivery GitHub
// sends again is not processed again.
export class WebhookAdmission extends DurableObject<Env> {
  readonly #calls = new SerialQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS accepted_deliveries (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        accepted_at INTEGER NOT NULL
      );
    `);
  }

  // Puts the delivery on the queue unless it is already there.
  //
  // The delivery is recorded only once the queue has it, so a failed send leaves it open to
  // GitHub's next attempt. Sending waits on the queue, which would let another call for the same
  // delivery in before it is recorded: the calls run one at a time, through a queue.
  enqueue(
    event: string,
    delivery: string,
    payload: Record<string, unknown>,
  ): Promise<WebhookAdmissionResult> {
    return this.#calls.run(async () => {
      const sql = this.ctx.storage.sql;
      const now = Date.now();
      sql.exec(
        "DELETE FROM accepted_deliveries WHERE accepted_at <= ?",
        now - githubWebhookDeliveryTtlMs,
      );
      if (sql.exec("SELECT 1 FROM accepted_deliveries WHERE id = ?", delivery).toArray().length) {
        return "duplicate";
      }
      await sendQueueMessage(this.env, {
        kind: "github-webhook",
        id: randomNonce(),
        event,
        delivery,
        payload,
        createdAt: new Date(now).toISOString(),
        attempts: 0,
      });
      sql.exec("INSERT INTO accepted_deliveries (id, accepted_at) VALUES (?, ?)", delivery, now);
      // Only the newest deliveries are remembered.
      sql.exec(
        `DELETE FROM accepted_deliveries WHERE sequence <= (
          SELECT sequence FROM accepted_deliveries ORDER BY sequence DESC LIMIT 1 OFFSET ?
        )`,
        githubWebhookDeliveryLimit,
      );
      return "queued";
    });
  }

  // Forgets a delivery that could not be processed, so GitHub can send it again.
  abandon(delivery: string): void {
    this.ctx.storage.sql.exec("DELETE FROM accepted_deliveries WHERE id = ?", delivery);
  }
}
