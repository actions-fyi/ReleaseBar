// Request counters that limit how often one client may call an endpoint within a minute.
//
// One `RateLimiter` Durable Object per endpoint holds the counters, because a limit must be
// checked and counted in one step (docs/data-model.md). The AI summary limits are not here: they
// span users and two windows, and stay in `SummaryQuota`.

import { type RateLimitedEndpoint, rateLimiterObjectName } from "../runtime.ts";

// Counts a request of `client` in `minute` against `limit`. True when the limit was reached
// already; the request is then not counted. Rejects when the object can't be reached.
export async function rateLimitReached(
  env: Env,
  endpoint: RateLimitedEndpoint,
  client: string,
  minute: number,
  limit: number,
): Promise<boolean> {
  return await env.RATE_LIMITER.getByName(rateLimiterObjectName(endpoint)).reached(
    client,
    minute,
    limit,
  );
}
