import {
  dashboardCacheKey,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../shared/dashboard.ts";
import type {
  AuthInstallation,
  DashboardPayload,
  DashboardProfile,
  RefreshTarget,
} from "../src/types.ts";
import {
  readStoredInstallation,
  readStoredInstallationsOf,
  type StoredInstallationRecord,
  writeStoredInstallations,
} from "./store/installations.ts";
import { readProfilesOf } from "./store/profiles.ts";
import { type GitHubInstallationRepository } from "./schemas.ts";
import { uniqueSorted } from "./app-shell.ts";
import { appTokenConfigured } from "./auth-oauth.ts";
import { installationRegistryCovers, installationRegistryFor } from "./auth-tokens.ts";
import { dashboardSchemaVersion, fullTtlMs, maxCustomSources } from "./config.ts";
import { cacheAgeMs, canDisplayCached, errorMessage, readCached } from "./dashboard-cache.ts";
import { mapConcurrent } from "./concurrency.ts";
import { enqueueRefreshJobs, refreshTargetBackoffActive } from "./refresh-queue.ts";
import { auditSyncEvent, rememberRefreshTargets } from "./refresh-targets.ts";
import type { BackgroundContext } from "./runtime.ts";
import { safeIso } from "./time.ts";

export function isPublicInstallationRepository(repo: GitHubInstallationRepository): boolean {
  if (repo.private === true) {
    return false;
  }
  return repo.private === false || repo.visibility === "public";
}

export function normalizedInstallation(installation: AuthInstallation): StoredInstallationRecord {
  return {
    ...installation,
    accountLogin: slugOwner(installation.accountLogin),
    repositories: installation.repositories.map((repo) => repo.toLowerCase()).filter(validRepoSlug),
    updatedAt: new Date().toISOString(),
  };
}

type InstallationRefreshTargetInput = Pick<
  RefreshTarget,
  "key" | "owner" | "owners" | "repos" | "includeReleaseData" | "path" | "priority"
> & { profile: DashboardProfile | null };

// What to remember as the refresh target of each account's dashboard, by the account's slug:
// null for an account that has no valid slug, or whose profile adds more sources than a dashboard
// takes. Two queries, however many accounts: their profiles, and the installations of the
// accounts their dashboards show.
export async function installationRefreshTargetInputs(
  env: Env,
  accountLogins: string[],
): Promise<Map<string, InstallationRefreshTargetInput | null>> {
  const inputs = new Map<string, InstallationRefreshTargetInput | null>(
    accountLogins.map((accountLogin) => [slugOwner(accountLogin), null]),
  );
  const accounts = [...inputs.keys()].filter(validOwnerSlug);
  if (accounts.length === 0) return inputs;
  const profiles = await readProfilesOf(env, accounts);
  const drafts = accounts.flatMap((account) => {
    const profile = profiles.get(account) ?? null;
    const hiddenOwners = new Set(profile?.hiddenOwners ?? []);
    const hiddenRepos = new Set(profile?.hiddenRepos ?? []);
    const extraOwners = uniqueSorted(profile?.includeOwners ?? []).filter(
      (owner) => owner !== account && !hiddenOwners.has(owner),
    );
    const repos = uniqueSorted(profile?.includeRepos ?? []).filter(
      (repo) => !hiddenOwners.has(repo.split("/")[0] ?? "") && !hiddenRepos.has(repo),
    );
    if (extraOwners.length + repos.length > maxCustomSources) return [];
    const owners = hiddenOwners.has(account) ? extraOwners : [account, ...extraOwners];
    return [{ account, profile, extraOwners, repos, owners }];
  });
  const registry = appTokenConfigured(env)
    ? await installationRegistryFor(env, drafts).catch(() => null)
    : null;
  for (const { account, profile, extraOwners, repos, owners } of drafts) {
    const registryCovered = registry
      ? installationRegistryCovers(registry, { owners, repos })
      : false;
    const includeReleaseData = !appTokenConfigured(env) || registryCovered;
    inputs.set(account, {
      key: dashboardCacheKey({
        owner: account,
        owners: extraOwners,
        repos,
        salt: profile?.updatedAt,
        includeForks: false,
        includeArchived: false,
        includeUnreleased: true,
        includeReleaseData,
        schemaVersion: dashboardSchemaVersion,
      }),
      owner: account,
      owners,
      repos,
      profile,
      includeReleaseData,
      path: `/${account}`,
      priority: 80,
    });
  }
  return inputs;
}

// An installation that is stored with the same content and was written within this time is not
// written again. Every /api/me call checks the session's installations, several at once when a
// browser reopens its tabs; without the skip each would send D1 the batch of writes (about five
// rows written per installation, with its indexes) and the four queries that remember the
// accounts' dashboards as refresh targets. With it, such a call is one read.
const installationRegistryRewriteMinAgeMs = 5 * 60 * 1000;

function installationRegistryEntryFresh(
  existing: StoredInstallationRecord | null,
  installation: StoredInstallationRecord,
): boolean {
  if (!existing) return false;
  const updatedAt = Date.parse(existing.updatedAt ?? "");
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > installationRegistryRewriteMinAgeMs) {
    return false;
  }
  return (
    existing.id === installation.id &&
    existing.accountLogin === installation.accountLogin &&
    existing.accountType === installation.accountType &&
    existing.accountUrl === installation.accountUrl &&
    existing.avatarUrl === installation.avatarUrl &&
    existing.repositorySelection === installation.repositorySelection &&
    existing.repositories.length === installation.repositories.length &&
    existing.repositories.every((repo, index) => repo === installation.repositories[index])
  );
}

function notNull<Value>(value: Value | null): value is Value {
  return value !== null;
}

// Stores the installations that are not stored as they are already, and remembers the dashboard
// of each account that installed the app for all its repositories as a refresh target. The
// queries do not grow with the installations: the stored ones are one read, the writes one batch
// for 25, and the targets are remembered together.
export async function writeInstallationRegistry(
  env: Env,
  installations: AuthInstallation[],
): Promise<void> {
  if (installations.length === 0) return;
  const normalized = installations.map(normalizedInstallation);
  const existing = await readInstallationRegistries(
    env,
    normalized.map((installation) => installation.accountLogin),
  ).catch(() => null);
  const stale = normalized.filter(
    (installation) =>
      !installationRegistryEntryFresh(
        existing?.get(installation.accountLogin) ?? null,
        installation,
      ),
  );
  if (stale.length === 0) return;
  await writeStoredInstallations(env, stale);
  const inputs = await installationRefreshTargetInputs(
    env,
    stale
      .filter((installation) => installation.repositorySelection === "all")
      .map((installation) => installation.accountLogin),
  );
  await rememberRefreshTargets(env, [...inputs.values()].filter(notNull));
}

export async function warmInstallationCaches(
  env: Env,
  context: BackgroundContext,
  installations: AuthInstallation[],
): Promise<void> {
  const accounts = [
    ...new Set(
      installations
        .filter((installation) => installation.repositorySelection === "all")
        .map((installation) => slugOwner(installation.accountLogin))
        .filter(validOwnerSlug),
    ),
  ];
  if (accounts.length === 0) return;
  const inputs = await installationRefreshTargetInputs(env, accounts);
  const targets = (await rememberRefreshTargets(env, [...inputs.values()].filter(notNull))).filter(
    notNull,
  );
  const cold = (
    await mapConcurrent(targets, 8, async (target) =>
      installationCacheNeedsWarm(target, await readCached(env, target.key)) ? target : null,
    )
  ).filter(notNull);
  await enqueueRefreshJobs(
    env,
    context,
    cold.map((target) => ({ target, reason: "installation-warm" })),
    { delaySeconds: 0, concurrency: 4 },
  );
}

export function installationCacheNeedsWarm(
  target: RefreshTarget,
  cached: DashboardPayload | null,
  now = Date.now(),
): boolean {
  if (refreshTargetBackoffActive(target, now)) return false;
  if (target.failureCount > 0 && now < safeIso(target.nextDueAt)) return false;
  if (!cached || !canDisplayCached(cached)) return true;
  if (
    cached.cache?.state === "error" ||
    cached.cache?.state === "stale" ||
    cached.cache?.progress?.done === false
  ) {
    return true;
  }
  return cacheAgeMs(cached) >= fullTtlMs || now >= safeIso(target.nextDueAt);
}

export function scheduleInstallationCacheWarm(
  env: Env,
  context: BackgroundContext,
  installations: AuthInstallation[],
): void {
  if (installations.length === 0) return;
  context.waitUntil(
    warmInstallationCaches(env, context, installations).catch((error) =>
      auditSyncEvent(env, {
        event: "installation_warm_failed",
        status: "failed",
        reason: errorMessage(error),
      }),
    ),
  );
}

export async function readInstallationRegistry(
  env: Env,
  accountLogin: string,
): Promise<StoredInstallationRecord | null> {
  const account = slugOwner(accountLogin);
  if (!validOwnerSlug(account)) return null;
  return readStoredInstallation(env, account);
}

// The stored installations of the accounts, by the account's slug: null for an account that has
// none, or no valid slug. One query, however many accounts.
export async function readInstallationRegistries(
  env: Env,
  accountLogins: string[],
): Promise<Map<string, StoredInstallationRecord | null>> {
  const accounts = [...new Set(accountLogins.map(slugOwner))];
  const stored = await readStoredInstallationsOf(env, accounts.filter(validOwnerSlug));
  return new Map(accounts.map((account) => [account, stored.get(account) ?? null]));
}
