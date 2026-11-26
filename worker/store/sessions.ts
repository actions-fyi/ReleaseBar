// Sign-in sessions: what the session cookie points to, including the user's GitHub tokens. A
// session is a KV entry that expires with the session, and stays one (docs/data-model.md).
//
// Beside each session is an entry that lists it under its user, `auth:user-session:<user id>:<id>`,
// with the same lifetime and no content. It is what finds a user's sessions when the user revokes
// the app's authorization or deletes the account: the only listing is by that prefix, to delete.

import type { StoredAuthSession } from "../config.ts";
import { mapConcurrent } from "../concurrency.ts";
import { safeJsonParse, storedAuthSessionSchema } from "../schemas.ts";

function sessionKey(id: string): string {
  return `auth:session:${id}`;
}

function userSessionsPrefix(userId: number): string {
  return `auth:user-session:${userId}:`;
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

// Stores a new session and lists it under its user. Later writes of the session go through
// `writeStoredSession`: the listing entry is written once and expires with the session.
export async function createStoredSession(
  env: Env,
  id: string,
  session: StoredAuthSession,
  ttlSeconds: number,
): Promise<void> {
  await Promise.all([
    writeStoredSession(env, id, session, ttlSeconds),
    env.DASHBOARD_CACHE.put(`${userSessionsPrefix(session.user.id)}${id}`, "1", {
      expirationTtl: ttlSeconds,
    }),
  ]);
}

// Deletes the session, and the entry that lists it under its user.
export async function deleteStoredSession(env: Env, id: string): Promise<void> {
  const userId = (await readStoredSession(env, id))?.session?.user.id;
  await Promise.all([
    env.DASHBOARD_CACHE.delete(sessionKey(id)),
    ...(userId === undefined
      ? []
      : [env.DASHBOARD_CACHE.delete(`${userSessionsPrefix(userId)}${id}`)]),
  ]);
}

// Deletes every session listed under the user, with the tokens it holds, and returns how many.
// The prefix ends with ":", so user 12 does not match the sessions of user 123.
export async function deleteStoredSessionsOf(env: Env, userId: number): Promise<number> {
  const prefix = userSessionsPrefix(userId);
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    await mapConcurrent(page.keys, 16, (key) =>
      Promise.all([
        env.DASHBOARD_CACHE.delete(sessionKey(key.name.slice(prefix.length))),
        env.DASHBOARD_CACHE.delete(key.name),
      ]),
    );
    deleted += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return deleted;
}
