// The installation registry: the GitHub App installations the Worker knows, one per account, with
// the repositories each may read. With it go two short-lived entries: the mark that an account
// has no installation, and the cached installation token.
//
// The registry is the table `installations` of the D1 database (migrations/0003_registry.sql).
// The mark and the token are KV entries, which expire by themselves; a token is never written to
// the database (docs/data-model.md).

import * as v from "valibot";
import { slugOwner } from "../../shared/dashboard.ts";
import type { AuthInstallation, AuthInstallationRecord } from "../../src/types.ts";
import { dashboardStorageTtlSeconds, installationTokenTtlSeconds } from "../config.ts";
import { safeJsonParse } from "../schemas.ts";
import { safeIso } from "../time.ts";

const installationMissTtlSeconds = 10 * 60;

// How long an installation counts after it was last written. The sync and each sign-in write it
// again; a row nobody wrote for this long is ignored by every read and deleted by
// `deleteExpiredInstallations`.
const installationTtlMs = dashboardStorageTtlSeconds * 1000;

// Rows per query of the full listing. A row carries the installation's repository list, which
// the sync caps at 1,000 names of at most 140 bytes: 250 rows stay below D1's 50 MB per result.
const installationPageSize = 250;

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

type InstallationRow = {
  id: number;
  account_login: string;
  account_type: string;
  account_url: string;
  avatar_url: string;
  repository_selection: string;
  repositories: string;
  updated_at: string;
};

const installationColumns =
  "id, account_login, account_type, account_url, avatar_url, repository_selection, repositories, updated_at";

export function installationMissKey(accountLogin: string): string {
  return `auth:installation-miss:v1:${slugOwner(accountLogin)}`;
}

// The row as the record it was written from. Null when the row does not hold a valid one.
function installationFromRow(row: InstallationRow): AuthInstallationRecord | null {
  const repositories = safeJsonParse(
    v.array(v.string()),
    row.repositories,
    `app installation ${row.account_login} repositories`,
  );
  if (!repositories) return null;
  const parsed = v.safeParse(storedInstallationSchema, {
    id: row.id,
    accountLogin: row.account_login,
    accountType: row.account_type,
    accountUrl: row.account_url,
    avatarUrl: row.avatar_url,
    repositorySelection: row.repository_selection,
    repositories,
    updatedAt: row.updated_at,
  });
  return parsed.success ? { ...parsed.output, updatedAt: row.updated_at } : null;
}

// Accounts per statement of a lookup: D1 takes 100 bound parameters per statement, and the time
// is one of them.
const accountsPerRead = 90;

// Installations per batch of writes. D1 counts a batch as one query whatever it holds and sets
// no number of statements; the size is kept to what one request carries easily, a repository
// list for each row. The installation sync, which GitHub's listing ends at 1,000 installations,
// writes them with 10 queries.
const installationsPerWrite = 100;

function chunks<Item>(items: Item[], size: number): Item[][] {
  const result: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

// The installations of the accounts, by the account's slug: null for an account that has none
// stored. One query, however many accounts: a statement per `accountsPerRead` of them, in one
// batch. An account is matched by its slug, exactly, as by `=`: no prefix, no pattern, no case
// folding beyond the slug's own. Only the number of "?" depends on the accounts; the slugs are
// bound.
export async function readStoredInstallationsOf(
  env: Env,
  accounts: string[],
): Promise<Map<string, StoredInstallationRecord | null>> {
  const found = new Map<string, StoredInstallationRecord | null>(
    accounts.map((account) => [slugOwner(account), null]),
  );
  if (found.size === 0) return found;
  const now = Date.now();
  const results = await env.DB.batch<InstallationRow>(
    chunks([...found.keys()], accountsPerRead).map((chunk) =>
      env.DB.prepare(
        `SELECT ${installationColumns} FROM installations
         WHERE account_login IN (${chunk.map(() => "?").join(", ")}) AND expires_at > ?`,
      ).bind(...chunk, now),
    ),
  );
  for (const row of results.flatMap((result) => result.results)) {
    found.set(row.account_login, installationFromRow(row));
  }
  return found;
}

// The account's installation. Null when none is stored. The account is matched by its slug,
// exactly: no prefix, no pattern, no case folding beyond the slug's own.
export async function readStoredInstallation(
  env: Env,
  account: string,
): Promise<StoredInstallationRecord | null> {
  const row = await env.DB.prepare(
    `SELECT ${installationColumns} FROM installations
     WHERE account_login = ?1 AND expires_at > ?2`,
  )
    .bind(slugOwner(account), Date.now())
    .first<InstallationRow>();
  return row ? installationFromRow(row) : null;
}

// The two statements that store the installation as the one of its account: an installation the
// account had before under another id goes, and the row of this id is inserted or replaced.
function installationWrite(
  env: Env,
  installation: StoredInstallationRecord,
): D1PreparedStatement[] {
  const account = slugOwner(installation.accountLogin);
  return [
    env.DB.prepare("DELETE FROM installations WHERE account_login = ?1 AND id <> ?2").bind(
      account,
      installation.id,
    ),
    env.DB.prepare(
      `INSERT INTO installations
         (id, account_login, account_type, account_url, avatar_url, repository_selection,
          repositories, updated_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (id) DO UPDATE SET
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         account_url = excluded.account_url,
         avatar_url = excluded.avatar_url,
         repository_selection = excluded.repository_selection,
         repositories = excluded.repositories,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
    ).bind(
      installation.id,
      account,
      installation.accountType,
      installation.accountUrl,
      installation.avatarUrl,
      installation.repositorySelection,
      JSON.stringify(installation.repositories),
      installation.updatedAt ?? new Date(0).toISOString(),
      Date.now() + installationTtlMs,
    ),
  ];
}

// Stores each installation as the one of its account, `installationsPerWrite` to a batch. A
// batch is one transaction, and its statements run in the order given: an account never has two
// rows, and a reader never sees none in between.
export async function writeStoredInstallations(
  env: Env,
  installations: StoredInstallationRecord[],
): Promise<void> {
  for (const chunk of chunks(installations, installationsPerWrite)) {
    await env.DB.batch(chunk.flatMap((installation) => installationWrite(env, installation)));
  }
}

// Stores the installation as the one of its account. One transaction: an installation the
// account had before under another id goes, and the row of this id is inserted or replaced, so
// an account never has two rows and a reader never sees none in between.
export async function writeStoredInstallation(
  env: Env,
  installation: StoredInstallationRecord,
): Promise<void> {
  await writeStoredInstallations(env, [installation]);
}

// Deletes the installations of the accounts: one query, a statement per `accountsPerRead` of
// them in one batch.
export async function deleteStoredInstallations(env: Env, accountLogins: string[]): Promise<void> {
  const accounts = [...new Set(accountLogins.map(slugOwner))];
  if (accounts.length === 0) return;
  await env.DB.batch(
    chunks(accounts, accountsPerRead).map((chunk) =>
      env.DB.prepare(
        `DELETE FROM installations WHERE account_login IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(...chunk),
    ),
  );
}

export async function deleteStoredInstallation(env: Env, accountLogin: string): Promise<void> {
  await deleteStoredInstallations(env, [accountLogin]);
}

function newestFirst(records: AuthInstallationRecord[]): AuthInstallationRecord[] {
  return records.sort((a, b) => safeIso(b.updatedAt) - safeIso(a.updatedAt));
}

function validInstallations(rows: InstallationRow[]): AuthInstallationRecord[] {
  return rows
    .map(installationFromRow)
    .filter((record): record is AuthInstallationRecord => record !== null);
}

// Every stored installation, most recently updated first. Read in pages by id, so no query
// returns more than `installationPageSize` rows.
export async function listStoredInstallations(env: Env): Promise<AuthInstallationRecord[]> {
  const records: AuthInstallationRecord[] = [];
  const now = Date.now();
  let afterId = -1;
  for (;;) {
    const page = await env.DB.prepare(
      `SELECT ${installationColumns} FROM installations
       WHERE id > ?1 AND expires_at > ?2
       ORDER BY id
       LIMIT ?3`,
    )
      .bind(afterId, now, installationPageSize)
      .all<InstallationRow>();
    records.push(...validInstallations(page.results));
    const last = page.results.at(-1);
    if (!last || page.results.length < installationPageSize) break;
    afterId = last.id;
  }
  return newestFirst(records);
}

// How many installations are stored, with the `sampleLimit` most recently updated of them, most
// recently updated first.
export async function storedInstallationInventory(
  env: Env,
  sampleLimit: number,
): Promise<{ total: number; installations: AuthInstallationRecord[] }> {
  const now = Date.now();
  const [count, sample] = await env.DB.batch<{ total: number } | InstallationRow>([
    env.DB.prepare("SELECT COUNT(*) AS total FROM installations WHERE expires_at > ?1").bind(now),
    env.DB.prepare(
      `SELECT ${installationColumns} FROM installations
       WHERE expires_at > ?1
       ORDER BY updated_at DESC, id
       LIMIT ?2`,
    ).bind(now, sampleLimit),
  ]);
  const total = (count?.results[0] as { total: number } | undefined)?.total ?? 0;
  return {
    total,
    installations: newestFirst(validInstallations((sample?.results ?? []) as InstallationRow[])),
  };
}

// Deletes up to `limit` installations whose time ran out, and returns how many. KV expired them
// by itself; the scheduled handler calls this instead.
export async function deleteExpiredInstallations(env: Env, limit: number): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM installations
     WHERE id IN (SELECT id FROM installations WHERE expires_at <= ?1 LIMIT ?2)`,
  )
    .bind(Date.now(), limit)
    .run();
  return result.meta.changes;
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
