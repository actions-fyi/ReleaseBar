// Dashboard profiles: what an owner saved for their dashboard, including the extra owners and
// repositories it shows and the ones it hides.
//
// A profile is a KV entry without expiry. Step 7c of the stack migration moves them to D1
// (docs/data-model.md).

import { slugOwner } from "../../shared/dashboard.ts";
import type { DashboardProfile } from "../../src/types.ts";
import { tryJsonParse } from "../schemas.ts";

export function profileKey(owner: string): string {
  return `profile:v1:${slugOwner(owner)}`;
}

export async function readProfile(env: Env, owner: string): Promise<DashboardProfile | null> {
  const raw = await env.DASHBOARD_CACHE.get(profileKey(owner));
  if (!raw) return null;
  const parsed = tryJsonParse<DashboardProfile>(raw, `profile ${owner}`);
  return parsed?.owner === slugOwner(owner) ? parsed : null;
}

export function writeStoredProfile(env: Env, profile: DashboardProfile): Promise<void> {
  return env.DASHBOARD_CACHE.put(profileKey(profile.owner), JSON.stringify(profile));
}

export async function deleteProfile(env: Env, owner: string): Promise<void> {
  await env.DASHBOARD_CACHE.delete(profileKey(owner));
}
