// Sign-in sessions: what the session cookie points to, including the user's GitHub tokens. A
// session is a KV entry that expires with the session, and stays one (docs/data-model.md).

import type { StoredAuthSession } from "../config.ts";
import { safeJsonParse, storedAuthSessionSchema } from "../schemas.ts";

function sessionKey(id: string): string {
  return `auth:session:${id}`;
}

// The stored session. `session` is null when what is stored is invalid; the result is null when
// nothing is stored.
export async function readStoredSession(
  env: Env,
  id: string,
): Promise<{ session: StoredAuthSession | null } | null> {
  const stored = await env.DASHBOARD_CACHE.get(sessionKey(id));
  if (!stored) return null;
  return { session: safeJsonParse(storedAuthSessionSchema, stored, "auth session") };
}

export async function writeStoredSession(
  env: Env,
  id: string,
  session: StoredAuthSession,
  ttlSeconds: number,
): Promise<void> {
  await env.DASHBOARD_CACHE.put(sessionKey(id), JSON.stringify(session), {
    expirationTtl: ttlSeconds,
  });
}

export async function deleteStoredSession(env: Env, id: string): Promise<void> {
  await env.DASHBOARD_CACHE.delete(sessionKey(id));
}
