// The refresh audit log: what the scheduler, the queue handler, the webhooks and the dashboard
// responses did, newest first, with the timings browsers report.
//
// An event is a KV entry. Step 7b of the stack migration moves the log to D1
// (docs/data-model.md).

import type { SchedulerAuditEvent } from "../../src/types.ts";
import { refreshAuditPrefix } from "../config.ts";
import { tryJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

const refreshAuditTtlSeconds = 14 * 24 * 60 * 60;

export function refreshAuditStorageKey(event: Pick<SchedulerAuditEvent, "id" | "at">): string {
  const timestamp = safeIso(event.at) || Date.now();
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${refreshAuditPrefix}${reverseTimestamp}:${event.id}`;
}

export function isAuditEvent(value: unknown): value is SchedulerAuditEvent {
  const event = value as SchedulerAuditEvent | null;
  return Boolean(event && typeof event.id === "string" && typeof event.event === "string");
}

export async function appendRefreshAuditEvent(env: Env, event: SchedulerAuditEvent): Promise<void> {
  await env.DASHBOARD_CACHE.put(refreshAuditStorageKey(event), JSON.stringify(event), {
    expirationTtl: refreshAuditTtlSeconds,
  });
}

// The newest events, at most `limit`.
export async function listRefreshAuditEvents(
  env: Env,
  limit: number,
): Promise<SchedulerAuditEvent[]> {
  const events: SchedulerAuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: refreshAuditPrefix,
      limit: Math.min(1000, limit - events.length),
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      if (!raw) continue;
      const parsed = tryJsonParse<SchedulerAuditEvent>(raw, `refresh audit ${key.name}`);
      if (isAuditEvent(parsed)) events.push(parsed);
      if (events.length >= limit) break;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && events.length < limit);
  return events;
}
