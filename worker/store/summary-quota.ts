// The AI summary limits: one Durable Object counts the summaries each user started this hour and
// all users started today, because a limit must be checked and counted in one step. It stays a
// Durable Object (docs/data-model.md).

import type { SummaryQuotaVerdict } from "../objects/summary-quota.ts";
import { summaryQuotaObjectName } from "../runtime.ts";
import type { SummaryRateLimits } from "../summary-limits.ts";

// Whether the user may start a summary within `limits`; counts one when `reserve`. Rejects when
// the object can't be reached.
export async function checkSummaryQuota(
  env: Env,
  userId: number,
  limits: SummaryRateLimits,
  reserve: boolean,
): Promise<SummaryQuotaVerdict> {
  return await env.SUMMARY_QUOTA.getByName(summaryQuotaObjectName).check(userId, limits, reserve);
}
