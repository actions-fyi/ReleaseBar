// What the audit collector writes for one request or job (worker/audit-collector.ts): its refresh
// audit events and its GitHub call counts, as one batch. D1 counts a batch as one query against
// the limit per invocation, whatever the number of statements.

import type { SchedulerAuditEvent } from "../../src/types.ts";
import { type GitHubAccessCalls, gitHubAccessCountStatements } from "./github-access.ts";
import { refreshAuditEventStatements } from "./refresh-audit.ts";

export async function writeAuditBatch(
  env: Env,
  events: SchedulerAuditEvent[],
  calls: GitHubAccessCalls[],
): Promise<void> {
  const statements = [
    ...refreshAuditEventStatements(env, events),
    ...gitHubAccessCountStatements(env, calls),
  ];
  if (statements.length > 0) await env.DB.batch(statements);
}
