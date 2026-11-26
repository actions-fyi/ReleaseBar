// What ReleaseBar stores about an account beyond GitHub's public data, and the three ways it goes:
// the user deletes the account (`DELETE /api/me`), the user revokes the app's authorization, or the
// app is uninstalled from an account. GitHub reports the last two with webhooks, which
// `worker/webhook.ts` hands to `processAccountWebhook`. docs/privacy.md says what is stored and for
// how long.

import { slugOwner, validOwnerSlug } from "../shared/dashboard.ts";
import type { AuthUser } from "../src/types.ts";
import { authCookie, currentSessionRecord } from "./app-shell.ts";
import { recordAuthFunnelEvent } from "./auth-observability.ts";
import { mapConcurrent } from "./concurrency.ts";
import { hotCacheKey } from "./config.ts";
import { jsonResponse } from "./http.ts";
import { deleteAuthFunnelRowsOf } from "./store/auth-funnel.ts";
import { deleteCacheEntry } from "./store/cache.ts";
import {
  deleteCachedInstallationToken,
  deleteStoredInstallation,
  deleteStoredInstallationById,
  readStoredInstallation,
  recordInstallationMiss,
} from "./store/installations.ts";
import { deleteProfileSnapshotsOf, profileSnapshotKeyRange } from "./store/profile-snapshots.ts";
import { deleteProfile } from "./store/profiles.ts";
import {
  deleteRefreshTargets,
  refreshTargetKeysOfProfileSnapshots,
} from "./store/refresh-targets.ts";
import { deleteStoredSession, deleteStoredSessionsOf } from "./store/sessions.ts";

const cacheDeleteConcurrency = 16;
const httpOk = 200;
const httpUnauthorized = 401;

// A webhook that is about an account and names no repository.
export type AccountWebhookEvent =
  | { kind: "installation-deleted"; account: string; installationId: number }
  | { kind: "authorization-revoked"; login: string; userId: number };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function accountSlug(value: unknown): string | null {
  const slug = typeof value === "string" ? slugOwner(value) : "";
  return validOwnerSlug(slug) ? slug : null;
}

// The account event of a delivery, from GitHub's payload or the compact one. Null for every other
// delivery, and for one that does not name its account.
//
// GitHub sends both events to every GitHub App, whatever the App subscribes to: `installation`
// with the action "deleted" when the app is uninstalled from an account, and
// `github_app_authorization` with the action "revoked" when a user revokes its authorization.
export function accountWebhookEvent(
  event: string,
  payload: Record<string, unknown>,
): AccountWebhookEvent | null {
  if (event === "installation" && payload.action === "deleted") {
    const installation = record(payload.installation);
    const account = accountSlug(record(installation?.account)?.login);
    const installationId = installation?.id;
    if (!account || typeof installationId !== "number") return null;
    return { kind: "installation-deleted", account, installationId };
  }
  if (event === "github_app_authorization" && payload.action === "revoked") {
    const sender = record(payload.sender);
    const login = accountSlug(sender?.login);
    const userId = sender?.id;
    if (!login || typeof userId !== "number") return null;
    return { kind: "authorization-revoked", login, userId };
  }
  return null;
}

// What of the payload the queue carries: the fields `accountWebhookEvent` reads.
export function compactAccountWebhookPayload(event: AccountWebhookEvent): Record<string, unknown> {
  return event.kind === "installation-deleted"
    ? {
        action: "deleted",
        installation: { id: event.installationId, account: { login: event.account } },
      }
    : { action: "revoked", sender: { id: event.userId, login: event.login } };
}

// The account of a compact payload without a repository. Null when it names none.
export function accountWebhookOwner(payload: Record<string, unknown>): string | null {
  return (
    accountSlug(record(record(payload.installation)?.account)?.login) ??
    accountSlug(record(payload.sender)?.login)
  );
}

// The app was uninstalled: the installation goes from the registry, with its cached token. The
// row is deleted by its id, so an installation the account made since, under a new id, stays.
async function removeInstallation(
  env: Env,
  event: Extract<AccountWebhookEvent, { kind: "installation-deleted" }>,
): Promise<void> {
  const [account] = await Promise.all([
    deleteStoredInstallationById(env, event.installationId),
    deleteCachedInstallationToken(env, event.installationId),
  ]);
  if (!account) return;
  await recordInstallationMiss(env, account);
  await recordAuthFunnelEvent(env, {
    event: "install_removed",
    account,
    installationId: event.installationId,
    repositorySelection: null,
    status: "webhook",
    detail: null,
  });
}

export async function processAccountWebhook(env: Env, event: AccountWebhookEvent): Promise<void> {
  if (event.kind === "installation-deleted") {
    await removeInstallation(env, event);
    return;
  }
  // The authorization is gone and the tokens with it: no session of the user is of use.
  const sessions = await deleteStoredSessionsOf(env, event.userId);
  console.log(JSON.stringify({ area: "auth", event: "authorization_revoked", sessions }));
}

// Deletes what is stored for the user's account: every session with its tokens, the dashboard
// profile with its snapshots, the dashboards built with them, the installation of the user's own
// account, and the sign-in events. Seven queries, however much there is.
//
// What stays is GitHub's public data about the account, which a dashboard shows for any public
// account and builds again when it is opened, and the audit rows of the last 14 days
// (docs/privacy.md).
export async function eraseAccount(env: Env, user: Pick<AuthUser, "id" | "login">): Promise<void> {
  const account = slugOwner(user.login);
  const [targetKeys, installation] = await Promise.all([
    refreshTargetKeysOfProfileSnapshots(env, profileSnapshotKeyRange(account)),
    readStoredInstallation(env, account),
  ]);
  await Promise.all([
    deleteStoredSessionsOf(env, user.id),
    deleteProfile(env, account),
    deleteProfileSnapshotsOf(env, account),
    deleteRefreshTargets(env, targetKeys),
    deleteAuthFunnelRowsOf(env, account),
    deleteStoredInstallation(env, account),
    ...(installation ? [deleteCachedInstallationToken(env, installation.id)] : []),
    deleteCacheEntry(env, hotCacheKey),
    mapConcurrent(targetKeys, cacheDeleteConcurrency, (key) => deleteCacheEntry(env, key)),
  ]);
}

// `DELETE /api/me`: deletes the signed-in user's account and signs the browser out.
export async function deleteAccountResponse(request: Request, env: Env): Promise<Response> {
  const session = await currentSessionRecord(request, env);
  if (!session) {
    return jsonResponse({ error: "login required" }, httpUnauthorized, {
      "cache-control": "no-store",
    });
  }
  await eraseAccount(env, session.session.user);
  // A session stored before sessions were listed under their user is not among the ones deleted.
  await deleteStoredSession(env, session.id);
  console.log(JSON.stringify({ area: "auth", event: "account_deleted" }));
  return jsonResponse({ deleted: true }, httpOk, {
    "cache-control": "no-store",
    "set-cookie": authCookie("", 0),
  });
}
