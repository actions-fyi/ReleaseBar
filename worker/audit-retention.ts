import { deleteExpiredAuthFunnelRows } from "./store/auth-funnel.ts";
import { deleteExpiredGitHubAccessCounts } from "./store/github-access.ts";
import { deleteExpiredRefreshAuditEvents } from "./store/refresh-audit.ts";

// Deletes the audit rows that are past their retention, a bounded number per table: D1
// expires nothing by itself. Run by the scheduled handler; what one run leaves, the
// next takes. A table that fails is logged and does not stop the others.
export async function deleteExpiredAuditRows(env: Env, now = Date.now()): Promise<void> {
  const tables: Array<[string, (env: Env, now: number) => Promise<number>]> = [
    ["refresh_audit_events", deleteExpiredRefreshAuditEvents],
    ["github_access_counts", deleteExpiredGitHubAccessCounts],
    ["auth_funnel", deleteExpiredAuthFunnelRows],
  ];
  for (const [table, deleteExpired] of tables) {
    try {
      const deleted = await deleteExpired(env, now);
      if (deleted > 0) {
        console.log(JSON.stringify({ area: "audit", event: "retention_deleted", table, deleted }));
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          area: "audit",
          event: "retention_failed",
          table,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
