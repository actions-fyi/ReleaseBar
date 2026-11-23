// The sign-in funnel: one event per step of a sign-in or an app installation, newest first, and a
// count per day, event, account and status.
//
// Events are rows of the D1 table `auth_funnel_events`, counts rows of `auth_funnel_counts`
// (migrations/0002_audit.sql). Both are kept for 90 days. The counts are a table of their own and
// not a COUNT over the events, so that the admin console reads one row per count and not every
// event of 90 days.

import type { AuthFunnelEvent } from "../../src/types.ts";

const authFunnelRetentionMs = 90 * 24 * 60 * 60 * 1000;
const deleteBatchRows = 1000;
const deleteBatchRounds = 5;

type EventRow = {
  id: string;
  at: string;
  event: string;
  account: string | null;
  installation_id: number | null;
  repository_selection: AuthFunnelEvent["repositorySelection"];
  status: string | null;
  detail: string | null;
};

type CountRow = {
  day: string;
  event: string;
  account: string;
  status: string;
  count: number;
};

// Stores the event and adds one to today's count for its event, account and status, in one
// transaction. The count is one statement, so concurrent events lose none.
export async function appendAuthFunnelEvent(env: Env, event: AuthFunnelEvent): Promise<void> {
  await appendAuthFunnelEvents(env, [event]);
}

// Events per batch: an event is two small statements. The installation sync records up to
// 1,000 removed installations, which is four queries.
const eventsPerWrite = 250;

// Stores the events and adds each to its count: one batch for `eventsPerWrite` events.
export async function appendAuthFunnelEvents(env: Env, events: AuthFunnelEvent[]): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const insertEvent = env.DB.prepare(
    `INSERT INTO auth_funnel_events
       (id, at, event, account, installation_id, repository_selection, status, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  );
  const addToCount = env.DB.prepare(
    `INSERT INTO auth_funnel_counts (day, event, account, status, count)
     VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (day, event, account, status) DO UPDATE SET count = count + 1`,
  );
  for (let index = 0; index < events.length; index += eventsPerWrite) {
    await env.DB.batch(
      events
        .slice(index, index + eventsPerWrite)
        .flatMap((event) => [
          insertEvent.bind(
            event.id,
            event.at,
            event.event,
            event.account,
            event.installationId,
            event.repositorySelection,
            event.status,
            event.detail,
          ),
          addToCount.bind(day, event.event, event.account ?? "_", event.status ?? "_"),
        ]),
    );
  }
}

// The newest events, at most `limit`.
export async function listAuthFunnelEvents(env: Env, limit: number): Promise<AuthFunnelEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, at, event, account, installation_id, repository_selection, status, detail
     FROM auth_funnel_events ORDER BY at DESC, id LIMIT ?1`,
  )
    .bind(limit)
    .all<EventRow>();
  return results.map((row) => ({
    id: row.id,
    at: row.at,
    event: row.event,
    account: row.account,
    installationId: row.installation_id,
    repositorySelection: row.repository_selection,
    status: row.status,
    detail: row.detail,
  }));
}

// How many counts exist, with the newest `sampleLimit` of them, highest first. A count's key is
// "day:event:account:status", with "_" for no account or no status.
export async function authFunnelCountInventory(
  env: Env,
  sampleLimit: number,
): Promise<{ total: number; counts: Array<{ key: string; count: number }> }> {
  const [total, sample] = await env.DB.batch<{ total: number } | CountRow>([
    env.DB.prepare("SELECT COUNT(*) AS total FROM auth_funnel_counts"),
    env.DB.prepare(
      `SELECT day, event, account, status, count FROM auth_funnel_counts
       ORDER BY day DESC, event DESC, account DESC, status DESC LIMIT ?1`,
    ).bind(sampleLimit),
  ]);
  const counts = ((sample?.results ?? []) as CountRow[]).map((row) => ({
    key: `${row.day}:${row.event}:${row.account}:${row.status}`,
    count: row.count,
  }));
  return {
    total: (total?.results[0] as { total: number } | undefined)?.total ?? 0,
    counts: counts.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}

// Deletes events and counts older than 90 days, at most 5,000 of each a call, in one batch.
// Returns how many.
export async function deleteExpiredAuthFunnelRows(env: Env, now: number): Promise<number> {
  const before = new Date(now - authFunnelRetentionMs).toISOString();
  const statements = [
    env.DB.prepare(
      `DELETE FROM auth_funnel_events WHERE id IN (
         SELECT id FROM auth_funnel_events WHERE at < ?1 ORDER BY at LIMIT ?2
       )`,
    ).bind(before, deleteBatchRows),
    env.DB.prepare(
      `DELETE FROM auth_funnel_counts WHERE (day, event, account, status) IN (
         SELECT day, event, account, status FROM auth_funnel_counts WHERE day < ?1 LIMIT ?2
       )`,
    ).bind(before.slice(0, 10), deleteBatchRows),
  ];
  const results = await env.DB.batch(
    statements.flatMap((statement) => Array.from({ length: deleteBatchRounds }, () => statement)),
  );
  return results.reduce((deleted, result) => deleted + result.meta.changes, 0);
}
