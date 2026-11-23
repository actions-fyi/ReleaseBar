import { DurableObject } from "cloudflare:workers";
import type { RefreshTarget } from "../../src/types.ts";
import {
  dashboardStorageTtlSeconds,
  durableRefreshTargetEntryLimitBytes,
  durableRefreshTargetIndexLimit,
  durableRefreshTargetIndexLimitBytes,
  refreshTargetSourceLimit,
  webhookTargetPageSize,
} from "../config.ts";
import { safeIso } from "../owner-metadata-write.ts";
import { isRefreshTarget } from "../refresh-targets.ts";
import { compareWebhookTargets } from "../webhook-targets.ts";
import { parseStored } from "./sql.ts";

// "created" and "updated" store the target. "too-large" refuses a target over the entry limit,
// and "full" one that would take the index over its limits.
export type RefreshTargetIndexUpsert = "created" | "updated" | "too-large" | "full";

export type RefreshTargetIndexPage = { targets: RefreshTarget[]; nextCursor: string | null };

type TargetRow = { value: string };

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

// The refresh targets that show one source: an instance is named by `refreshTargetIndexName`
// for an owner or a repository, and a webhook for that source asks it which dashboards to
// refresh. Targets not seen within the storage lifetime are dropped.
//
// No method awaits, so each one runs to completion before the next call starts.
export class RefreshTargetIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        key TEXT PRIMARY KEY,
        last_seen_at INTEGER NOT NULL,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  }

  upsert(target: RefreshTarget): RefreshTargetIndexUpsert {
    if (!isRefreshTarget(target)) throw new TypeError("invalid refresh target");
    if (byteLength(target) > durableRefreshTargetEntryLimitBytes) return "too-large";
    const sql = this.ctx.storage.sql;
    const targets = new Map(this.#current().map((candidate) => [candidate.key, candidate]));
    const created = !targets.has(target.key);
    if (created && targets.size >= refreshTargetSourceLimit) return "full";
    targets.set(target.key, target);
    const updated = [...targets.values()]
      .sort((left, right) => safeIso(right.lastSeenAt) - safeIso(left.lastSeenAt))
      .slice(0, durableRefreshTargetIndexLimit);
    if (byteLength(updated) > durableRefreshTargetIndexLimitBytes) return "full";
    // Both writes commit together: nothing is awaited between them.
    sql.exec("DELETE FROM targets WHERE last_seen_at < ?", this.#cutoff());
    if (updated.length < targets.size) {
      const kept = new Set(updated.map((candidate) => candidate.key));
      for (const key of targets.keys()) {
        if (!kept.has(key)) sql.exec("DELETE FROM targets WHERE key = ?", key);
      }
    }
    if (updated.includes(target)) {
      sql.exec(
        `INSERT INTO targets (key, last_seen_at, value) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE
         SET last_seen_at = excluded.last_seen_at, value = excluded.value`,
        target.key,
        safeIso(target.lastSeenAt),
        JSON.stringify(target),
      );
    }
    return created ? "created" : "updated";
  }

  remove(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM targets WHERE key = ?", key);
  }

  // Every current target, most recently seen first.
  list(): RefreshTarget[] {
    return this.#current().sort(compareWebhookTargets).slice(0, durableRefreshTargetIndexLimit);
  }

  // The current targets in key order, after `cursor`.
  page(cursor = "", limit = webhookTargetPageSize): RefreshTargetIndexPage {
    const size = Math.max(1, Math.min(webhookTargetPageSize, Math.floor(limit)));
    const targets = this.#current()
      .filter((target) => !cursor || target.key > cursor)
      .sort((left, right) => left.key.localeCompare(right.key));
    const page = targets.slice(0, size);
    return {
      targets: page,
      nextCursor: page.length < targets.length ? (page.at(-1)?.key ?? null) : null,
    };
  }

  #cutoff(): number {
    return Date.now() - dashboardStorageTtlSeconds * 1000;
  }

  #current(): RefreshTarget[] {
    return this.ctx.storage.sql
      .exec<TargetRow>("SELECT value FROM targets WHERE last_seen_at >= ?", this.#cutoff())
      .toArray()
      .map((row) => parseStored<RefreshTarget>(row.value))
      .filter((target) => isRefreshTarget(target));
  }
}
