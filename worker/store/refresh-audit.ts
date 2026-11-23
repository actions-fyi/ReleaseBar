// The refresh audit log: what the scheduler, the queue handler, the webhooks and the dashboard
// responses did, newest first, with the timings browsers report.
//
// An event is a row of the D1 table `refresh_audit_events` (migrations/0002_audit.sql), kept for
// 14 days.

import type { SchedulerAuditEvent } from "../../src/types.ts";
import { tryJsonParse } from "../schemas.ts";

const refreshAuditRetentionMs = 14 * 24 * 60 * 60 * 1000;
const deleteBatchRows = 1000;
const deleteBatchRounds = 5;

// The statements that append the events, one each: for a batch.
export function refreshAuditEventStatements(
  env: Env,
  events: SchedulerAuditEvent[],
): D1PreparedStatement[] {
  if (events.length === 0) return [];
  const statement = env.DB.prepare(
    "INSERT INTO refresh_audit_events (id, at, event, data) VALUES (?1, ?2, ?3, ?4)",
  );
  return events.map((event) =>
    statement.bind(event.id, event.at, event.event, JSON.stringify(event)),
  );
}

export function isAuditEvent(value: unknown): value is SchedulerAuditEvent {
  const event = value as SchedulerAuditEvent | null;
  return Boolean(event && typeof event.id === "string" && typeof event.event === "string");
}

// Appends one event by itself. The events of a request or job go through the audit collector
// instead (worker/audit-collector.ts), which writes them as one batch.
export async function appendRefreshAuditEvent(env: Env, event: SchedulerAuditEvent): Promise<void> {
  const [statement] = refreshAuditEventStatements(env, [event]);
  await statement?.run();
}

// The newest events, at most `limit`.
export async function listRefreshAuditEvents(
  env: Env,
  limit: number,
): Promise<SchedulerAuditEvent[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, data FROM refresh_audit_events ORDER BY at DESC, id LIMIT ?1",
  )
    .bind(limit)
    .all<{ id: string; data: string }>();
  return results
    .map((row) => tryJsonParse<SchedulerAuditEvent>(row.data, `refresh audit ${row.id}`))
    .filter(isAuditEvent);
}

// Deletes events older than 14 days, at most 5,000 a call: five deletions of 1,000 rows in one
// batch, which D1 counts as one query. Returns how many.
export async function deleteExpiredRefreshAuditEvents(env: Env, now: number): Promise<number> {
  const before = new Date(now - refreshAuditRetentionMs).toISOString();
  const statement = env.DB.prepare(
    `DELETE FROM refresh_audit_events WHERE id IN (
       SELECT id FROM refresh_audit_events WHERE at < ?1 ORDER BY at LIMIT ?2
     )`,
  ).bind(before, deleteBatchRows);
  const results = await env.DB.batch(Array.from({ length: deleteBatchRounds }, () => statement));
  return results.reduce((deleted, result) => deleted + result.meta.changes, 0);
}
