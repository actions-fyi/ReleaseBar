// The installation registry: the GitHub App installations the Worker knows, one per account, with
// the repositories each may read. With it go two short-lived entries: the mark that an account
// has no installation, and the cached installation token.
//
// All are KV entries. Step 7c of the stack migration moves the registry to D1; the mark and the
// token stay in KV (docs/data-model.md).

import * as v from "valibot";
import { slugOwner } from "../../shared/dashboard.ts";
import type { AuthInstallation, AuthInstallationRecord } from "../../src/types.ts";
import { mapConcurrent } from "../concurrency.ts";
import { dashboardStorageTtlSeconds, installationTokenTtlSeconds } from "../config.ts";
import { safeJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

const installationPrefix = "auth:installation:v1:";
const installationMissTtlSeconds = 10 * 60;

export const storedInstallationSchema = v.object({
  id: v.number(),
  accountLogin: v.string(),
  accountType: v.picklist(["user", "org"]),
  accountUrl: v.string(),
  avatarUrl: v.string(),
  repositorySelection: v.picklist(["all", "selected"]),
  repositories: v.array(v.string()),
  updatedAt: v.optional(v.string()),
});

export type StoredInstallationRecord = AuthInstallation & {
  updatedAt?: string;
};

export function installationRegistryKey(accountLogin: string): string {
  return `${installationPrefix}${slugOwner(accountLogin)}`;
}

export function installationMissKey(accountLogin: string): string {
  return `auth:installation-miss:v1:${slugOwner(accountLogin)}`;
}

function storedInstallationRecord(record: StoredInstallationRecord): AuthInstallationRecord {
  return {
    ...record,
    updatedAt: record.updatedAt ?? new Date(0).toISOString(),
  };
}

// The account's installation. Null when none is stored or what is stored is invalid.
export async function readStoredInstallation(
  env: Env,
  account: string,
): Promise<StoredInstallationRecord | null> {
  const raw = await env.DASHBOARD_CACHE.get(installationRegistryKey(account));
  if (!raw) return null;
  return safeJsonParse(storedInstallationSchema, raw, `app installation ${account}`);
}

export function writeStoredInstallation(
  env: Env,
  installation: StoredInstallationRecord,
): Promise<void> {
  return env.DASHBOARD_CACHE.put(
    installationRegistryKey(installation.accountLogin),
    JSON.stringify(installation),
    { expirationTtl: dashboardStorageTtlSeconds },
  );
}

export function deleteStoredInstallation(env: Env, accountLogin: string): Promise<void> {
  return env.DASHBOARD_CACHE.delete(installationRegistryKey(accountLogin));
}

async function readListedInstallation(
  env: Env,
  name: string,
): Promise<AuthInstallationRecord | null> {
  const raw = await env.DASHBOARD_CACHE.get(name);
  if (!raw) return null;
  const parsed = safeJsonParse(storedInstallationSchema, raw, `app installation ${name}`);
  return parsed ? storedInstallationRecord(parsed) : null;
}

// Every stored installation, most recently updated first.
export async function listStoredInstallations(env: Env): Promise<AuthInstallationRecord[]> {
  const records: AuthInstallationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: installationPrefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const pageRecords = await mapConcurrent(page.keys, 16, (key) =>
      readListedInstallation(env, key.name),
    );
    records.push(
      ...pageRecords.filter((record): record is AuthInstallationRecord => record !== null),
    );
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records.sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt));
}

// How many installations are stored, with the first `sampleLimit` of them, most recently updated
// first.
export async function storedInstallationInventory(
  env: Env,
  sampleLimit: number,
): Promise<{ total: number; installations: AuthInstallationRecord[] }> {
  const sampleKeys: string[] = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DASHBOARD_CACHE.list({
      prefix: installationPrefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const key of page.keys) {
      total += 1;
      if (sampleKeys.length < sampleLimit) {
        sampleKeys.push(key.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const installations = await mapConcurrent(sampleKeys, 16, (key) =>
    readListedInstallation(env, key),
  );
  return {
    total,
    installations: installations
      .filter((record): record is AuthInstallationRecord => record !== null)
      .sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt)),
  };
}

// Whether GitHub answered, within the last ten minutes, that the account has no installation.
export async function installationMissRecorded(env: Env, account: string): Promise<boolean> {
  return Boolean(await env.DASHBOARD_CACHE.get(installationMissKey(account)));
}

export function recordInstallationMiss(env: Env, account: string): Promise<void> {
  return env.DASHBOARD_CACHE.put(installationMissKey(account), new Date().toISOString(), {
    expirationTtl: installationMissTtlSeconds,
  });
}

export function readCachedInstallationToken(
  env: Env,
  installationId: number,
): Promise<string | null> {
  return env.DASHBOARD_CACHE.get(`auth:installation-token:${installationId}`);
}

export async function writeCachedInstallationToken(
  env: Env,
  installationId: number,
  token: string,
): Promise<void> {
  await env.DASHBOARD_CACHE.put(`auth:installation-token:${installationId}`, token, {
    expirationTtl: installationTokenTtlSeconds,
  });
}
