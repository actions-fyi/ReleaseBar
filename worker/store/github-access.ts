// The GitHub audit log: how often the Worker called each GitHub route, by hour, with which
// credentials and with what result.
//
// A count is a row of the D1 table `github_access_counts` (migrations/0002_audit.sql) per hour
// and route key, kept for 14 days. A call adds to it with one statement, so concurrent calls
// lose none. No row is kept per call: there are too many.

import type { GitHubAccessRouteSummary } from "../../src/types.ts";

const githubAccessRetentionMs = 14 * 24 * 60 * 60 * 1000;
const listPageRows = 1000;
const listPageLimit = 20;
const deleteBatchRows = 1000;
const deleteBatchRounds = 5;

// GitHub calls of one route key: how many, and the time and path of the last.
export type GitHubAccessCalls = Omit<GitHubAccessRouteSummary, "lastAt"> & { lastAt: string };

type CountRow = {
  hour: string;
  route_key: string;
  area: string;
  route: string;
  status: number;
  source: GitHubAccessRouteSummary["source"];
  account: string | null;
  resource: string | null;
  count: number;
  last_at: string;
  last_path: string | null;
};

// Adds the calls to the counts of the hour of their `lastAt`: one batch, which D1 counts as one
// query, whatever the number of route keys.
export async function countGitHubAccess(env: Env, calls: GitHubAccessCalls[]): Promise<void> {
  if (calls.length === 0) return;
  const statement = env.DB.prepare(
    `INSERT INTO github_access_counts
       (hour, route_key, area, route, status, source, account, resource, count, last_at, last_path)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT (hour, route_key) DO UPDATE SET
       count = count + excluded.count,
       last_path = CASE WHEN excluded.last_at >= last_at THEN excluded.last_path ELSE last_path END,
       last_at = max(last_at, excluded.last_at)`,
  );
  await env.DB.batch(
    calls.map((call) =>
      statement.bind(
        call.lastAt.slice(0, 13),
        call.key,
        call.area,
        call.route,
        call.status,
        call.source,
        call.account,
        call.resource,
        call.count,
        call.lastAt,
        call.lastPath,
      ),
    ),
  );
}

// The counts of the hours from `sinceHour` ("2026-06-13T12") on, one per hour and route key, read
// in pages of 1,000 rows. `complete` is false when there were more than 20,000.
export async function listGitHubAccessCounts(
  env: Env,
  sinceHour: string,
): Promise<{ counts: GitHubAccessRouteSummary[]; complete: boolean }> {
  const statement = env.DB.prepare(
    `SELECT hour, route_key, area, route, status, source, account, resource, count, last_at,
       last_path
     FROM github_access_counts
     WHERE hour >= ?1 AND (hour, route_key) > (?2, ?3)
     ORDER BY hour, route_key LIMIT ?4`,
  );
  const counts: GitHubAccessRouteSummary[] = [];
  let after = { hour: "", routeKey: "" };
  for (let page = 0; page < listPageLimit; page += 1) {
    const { results } = await statement
      .bind(sinceHour, after.hour, after.routeKey, listPageRows)
      .all<CountRow>();
    for (const row of results) {
      counts.push({
        key: row.route_key,
        area: row.area,
        route: row.route,
        status: row.status,
        source: row.source,
        account: row.account,
        resource: row.resource,
        count: row.count,
        lastAt: row.last_at,
        lastPath: row.last_path,
      });
    }
    const last = results.at(-1);
    if (!last || results.length < listPageRows) return { counts, complete: true };
    after = { hour: last.hour, routeKey: last.route_key };
  }
  return { counts, complete: false };
}

// Deletes counts older than 14 days, at most 5,000 a call. Returns how many.
export async function deleteExpiredGitHubAccessCounts(env: Env, now: number): Promise<number> {
  const before = new Date(now - githubAccessRetentionMs).toISOString().slice(0, 13);
  const statement = env.DB.prepare(
    `DELETE FROM github_access_counts WHERE (hour, route_key) IN (
       SELECT hour, route_key FROM github_access_counts WHERE hour < ?1 LIMIT ?2
     )`,
  ).bind(before, deleteBatchRows);
  let deleted = 0;
  for (let round = 0; round < deleteBatchRounds; round += 1) {
    const changes = (await statement.run()).meta.changes;
    deleted += changes;
    if (changes < deleteBatchRows) break;
  }
  return deleted;
}
