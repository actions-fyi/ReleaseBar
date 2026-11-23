import { DurableObject } from "cloudflare:workers";

type CountRow = { window: number; count: number };

// Limits how often one client may call an endpoint within a window of time. One instance per
// endpoint, named by `rateLimiterObjectName`, counts every client of that endpoint: a limit needs
// a read and an add in one step, which this object's single thread gives.
export class RateLimiter extends DurableObject<Env> {
  // The newest window whose predecessors were deleted.
  #sweptWindow = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A client's count within one fixed window: `window` is the window's index since the epoch,
    // as the caller counts it (minutes, for both endpoints).
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS request_counts (
        client TEXT PRIMARY KEY,
        window INTEGER NOT NULL,
        count INTEGER NOT NULL
      ) WITHOUT ROWID`,
    );
  }

  // Counts a request of `client` in `window` against `limit`. True when the limit was reached
  // already; the request is then not counted. The method never awaits, so the check and the count
  // are one step.
  reached(client: string, window: number, limit: number): boolean {
    const sql = this.ctx.storage.sql;
    if (window > this.#sweptWindow) {
      // Counts of windows that have passed, once per window. The one before is kept: the callers'
      // clocks need not agree to the second.
      sql.exec("DELETE FROM request_counts WHERE window < ?", window - 1);
      this.#sweptWindow = window;
    }
    const [row] = sql
      .exec<CountRow>("SELECT window, count FROM request_counts WHERE client = ?", client)
      .toArray();
    const count = row?.window === window ? row.count : 0;
    if (count >= limit) return true;
    sql.exec(
      `INSERT INTO request_counts (client, window, count) VALUES (?, ?, ?)
       ON CONFLICT (client) DO UPDATE SET window = excluded.window, count = excluded.count`,
      client,
      window,
      count + 1,
    );
    return false;
  }
}
