// The sign-in funnel: one event per step of a sign-in or an app installation, newest first, and a
// counter per day, event, account and status.
//
// Events and counters are KV entries; a counter is read and written in two steps, so concurrent
// events can lose a count. Step 7b of the stack migration moves both to D1
// (docs/data-model.md).

import type { AuthFunnelEvent } from "../../src/types.ts";
import { mapConcurrent } from "../concurrency.ts";
import { tryJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

const authFunnelPrefix = "auth:funnel:v1:";
const authFunnelCounterPrefix = "auth:funnel-counter:v1:";
const authFunnelTtlSeconds = 90 * 24 * 60 * 60;

function authFunnelStorageKey(event: Pick<AuthFunnelEvent, "id" | "at">): string {
  const timestamp = safeIso(event.at) || Date.now();
  const reverseTimestamp = String(Number.MAX_SAFE_INTEGER - timestamp).padStart(16, "0");
  return `${authFunnelPrefix}${reverseTimestamp}:${event.id}`;
}

function authFunnelCounterKey(
  event: string,
  account: string | null,
  status: string | null,
): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${authFunnelCounterPrefix}${day}:${event}:${account ?? "_"}:${status ?? "_"}`;
}

async function readCounter(env: Env, key: string): Promise<number> {
  const current = Number.parseInt((await env.DASHBOARD_CACHE.get(key)) ?? "0", 10);
  return Number.isFinite(current) ? current : 0;
}

// Stores the event and adds one to today's counter for its event, account and status.
export async function appendAuthFunnelEvent(env: Env, event: AuthFunnelEvent): Promise<void> {
  const cache = env.DASHBOARD_CACHE;
  const counterKey = authFunnelCounterKey(event.event, event.account, event.status);
  await Promise.all([
    cache.put(authFunnelStorageKey(event), JSON.stringify(event), {
      expirationTtl: authFunnelTtlSeconds,
    }),
    readCounter(env, counterKey).then((count) =>
      cache.put(counterKey, String(count + 1), {
        expirationTtl: authFunnelTtlSeconds,
      }),
    ),
  ]);
}

// The newest events, at most `limit`.
export async function listAuthFunnelEvents(env: Env, limit: number): Promise<AuthFunnelEvent[]> {
  const events: AuthFunnelEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: authFunnelPrefix,
      limit: Math.min(1000, limit - events.length),
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      const raw = await env.DASHBOARD_CACHE.get(key.name);
      if (!raw) continue;
      const parsed = tryJsonParse<AuthFunnelEvent>(raw, `auth funnel ${key.name}`);
      if (parsed?.id && parsed.at && parsed.event) events.push(parsed);
      if (events.length >= limit) break;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && events.length < limit);
  return events.sort((a, b) => safeIso(b.at) - safeIso(a.at));
}

// How many counters exist, with the counts of the last `sampleLimit` of them, highest first. A
// count's key is "day:event:account:status".
export async function authFunnelCountInventory(
  env: Env,
  sampleLimit: number,
): Promise<{ total: number; counts: Array<{ key: string; count: number }> }> {
  const sampleKeys: string[] = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: authFunnelCounterPrefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      total += 1;
      sampleKeys.push(key.name);
      if (sampleKeys.length > sampleLimit) sampleKeys.shift();
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const counts = await mapConcurrent(sampleKeys, 16, async (key) => {
    const count = Number.parseInt((await env.DASHBOARD_CACHE.get(key)) ?? "0", 10);
    return Number.isFinite(count) && count > 0
      ? { key: key.slice(authFunnelCounterPrefix.length), count }
      : null;
  });
  return {
    total,
    counts: counts
      .filter((count): count is { key: string; count: number } => count !== null)
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}
