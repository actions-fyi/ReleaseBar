// Request counters that limit how often one client may call an endpoint within a minute.
//
// A counter is a short-lived KV entry, read and written in two steps, so concurrent requests can
// pass the limit. Step 7b of the stack migration moves them into a Durable Object, which checks
// and adds in one step (docs/data-model.md).

const rateLimitPrefixes = {
  "client-timing": "client:timing:rate:v1:",
  "install-callback": "auth:install-callback:rate:v1:",
} as const;

// Counts a request of `client` in `minute` against `limit`. True when the limit was reached
// already; the request is then not counted.
export async function rateLimitReached(
  env: Env,
  endpoint: keyof typeof rateLimitPrefixes,
  client: string,
  minute: number,
  limit: number,
): Promise<boolean> {
  const key = `${rateLimitPrefixes[endpoint]}${client}:${minute}`;
  const current = Number.parseInt((await env.DASHBOARD_CACHE.get(key)) ?? "0", 10);
  if (Number.isFinite(current) && current >= limit) return true;
  await env.DASHBOARD_CACHE.put(key, String((Number.isFinite(current) ? current : 0) + 1), {
    expirationTtl: 120,
  });
  return false;
}
