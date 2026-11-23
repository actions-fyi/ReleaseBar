// Dashboard profiles: what an owner saved for their dashboard, including the extra owners and
// repositories it shows and the ones it hides.
//
// A profile is a row of the table `profiles` of the D1 database (migrations/0003_registry.sql),
// keyed by the owner's slug, without expiry. Its four lists are JSON columns: a profile is saved
// and read whole, and no query looks into a list.

import * as v from "valibot";
import { slugOwner } from "../../shared/dashboard.ts";
import type { DashboardProfile } from "../../src/types.ts";
import { safeJsonParse } from "../schemas.ts";

type ProfileRow = {
  owner: string;
  include_owners: string;
  include_repos: string;
  hidden_owners: string;
  hidden_repos: string;
  updated_at: string;
  updated_by: string;
};

const stringListSchema = v.array(v.string());

function stringList(raw: string, context: string): string[] {
  return safeJsonParse(stringListSchema, raw, context) ?? [];
}

const profileColumns =
  "owner, include_owners, include_repos, hidden_owners, hidden_repos, updated_at, updated_by";

// Owners per statement of a lookup: D1 takes 100 bound parameters per statement.
const ownersPerRead = 90;

function profileFromRow(row: ProfileRow): DashboardProfile {
  const context = `profile ${row.owner}`;
  return {
    owner: row.owner,
    includeOwners: stringList(row.include_owners, context),
    includeRepos: stringList(row.include_repos, context),
    hiddenOwners: stringList(row.hidden_owners, context),
    hiddenRepos: stringList(row.hidden_repos, context),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

// The owner's profile. Null when none is stored. The owner is matched by its slug, exactly.
export async function readProfile(env: Env, owner: string): Promise<DashboardProfile | null> {
  const row = await env.DB.prepare(`SELECT ${profileColumns} FROM profiles WHERE owner = ?1`)
    .bind(slugOwner(owner))
    .first<ProfileRow>();
  return row ? profileFromRow(row) : null;
}

// The profiles of the owners, by the owner's slug: null for an owner that has none stored. One
// query, however many owners: a statement per `ownersPerRead` of them, in one batch. An owner is
// matched by its slug, exactly, as by `=`; only the number of "?" depends on the owners.
export async function readProfilesOf(
  env: Env,
  owners: string[],
): Promise<Map<string, DashboardProfile | null>> {
  const found = new Map<string, DashboardProfile | null>(
    owners.map((owner) => [slugOwner(owner), null]),
  );
  if (found.size === 0) return found;
  const slugs = [...found.keys()];
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < slugs.length; index += ownersPerRead) {
    const chunk = slugs.slice(index, index + ownersPerRead);
    statements.push(
      env.DB.prepare(
        `SELECT ${profileColumns} FROM profiles
         WHERE owner IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(...chunk),
    );
  }
  const results = await env.DB.batch<ProfileRow>(statements);
  for (const row of results.flatMap((result) => result.results)) {
    found.set(row.owner, profileFromRow(row));
  }
  return found;
}

// Stores the profile in place of the one its owner had: one statement, the last write wins.
export async function writeStoredProfile(env: Env, profile: DashboardProfile): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO profiles
       (owner, include_owners, include_repos, hidden_owners, hidden_repos, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (owner) DO UPDATE SET
       include_owners = excluded.include_owners,
       include_repos = excluded.include_repos,
       hidden_owners = excluded.hidden_owners,
       hidden_repos = excluded.hidden_repos,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(
      slugOwner(profile.owner),
      JSON.stringify(profile.includeOwners),
      JSON.stringify(profile.includeRepos),
      JSON.stringify(profile.hiddenOwners),
      JSON.stringify(profile.hiddenRepos),
      profile.updatedAt,
      profile.updatedBy,
    )
    .run();
}

export async function deleteProfile(env: Env, owner: string): Promise<void> {
  await env.DB.prepare("DELETE FROM profiles WHERE owner = ?1").bind(slugOwner(owner)).run();
}
