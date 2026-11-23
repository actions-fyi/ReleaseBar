import { DurableObject } from "cloudflare:workers";
import type { SummaryRateLimits } from "../summary-limits.ts";

export type SummaryQuotaVerdict = { allowed: true } | { allowed: false; scope: "user" | "global" };

const hourMs = 3_600_000;
const dayMs = 86_400_000;
const globalScope = "global";

type CountRow = { period: number; count: number };

// Counts AI summary generations against the hourly limit of each user and the daily limit of all
// users. One instance, named by `summaryQuotaObjectName`, holds every counter: a limit needs a
// read and an add in one step, and the daily limit spans all users.
export class SummaryQuota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A count within one fixed window: `period` is the window's index since the epoch, in hours
    // for a user's scope and in days for the global one.
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS summary_counts (
        scope TEXT PRIMARY KEY,
        period INTEGER NOT NULL,
        count INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
  }

  // Checks both limits for a user and, with `reserve`, counts one generation against them. The
  // method never awaits, so the check and the count are one step.
  check(userId: number, limits: SummaryRateLimits, reserve: boolean): SummaryQuotaVerdict {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const userWindow = Math.floor(now / hourMs);
    const globalWindow = Math.floor(now / dayMs);
    const userScope = `user:${userId}`;
    const count = (scope: string, window: number): number => {
      const [row] = sql
        .exec<CountRow>("SELECT period, count FROM summary_counts WHERE scope = ?", scope)
        .toArray();
      return row?.period === window ? row.count : 0;
    };
    const userCount = count(userScope, userWindow);
    const globalCount = count(globalScope, globalWindow);
    if (userCount >= limits.userHourly) return { allowed: false, scope: "user" };
    if (globalCount >= limits.globalDaily) return { allowed: false, scope: "global" };
    if (reserve) {
      const put = (scope: string, window: number, value: number): void => {
        sql.exec(
          `INSERT INTO summary_counts (scope, period, count) VALUES (?, ?, ?)
           ON CONFLICT (scope) DO UPDATE SET period = excluded.period, count = excluded.count`,
          scope,
          window,
          value,
        );
      };
      // Counts of users whose hour has passed.
      sql.exec(
        "DELETE FROM summary_counts WHERE scope <> ? AND period < ?",
        globalScope,
        userWindow,
      );
      put(userScope, userWindow, userCount + 1);
      put(globalScope, globalWindow, globalCount + 1);
    }
    return { allowed: true };
  }
}
