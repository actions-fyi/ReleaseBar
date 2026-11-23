// The coordinator of one dashboard: a Durable Object named by the dashboard's cache key, which is
// also its refresh target's key. It holds what must be checked and changed in one step: the build
// lock, the progress of the running build, the reservation of the target's refresh job with its
// dirty marker, and the target's scheduling state. It stays a Durable Object (docs/data-model.md).
//
// Every function rejects when the object can't be reached; the callers decide what stands in.

import type { RefreshTarget } from "../../src/types.ts";
import type { RefreshTargetMutation, StoredBuildProgress, StoredRefreshDirty } from "../config.ts";
import type { RefreshTargetSeed } from "../objects/build-coordinator.ts";

function coordinator(env: Env, key: string) {
  return env.BUILD_COORDINATOR.getByName(key);
}

// Takes the dashboard's build lock for `token`. False when another token holds it.
export async function acquireBuildLock(env: Env, key: string, token: string): Promise<boolean> {
  return await coordinator(env, key).acquireLock(token);
}

// Extends the lock. False when `token` no longer holds it.
export async function refreshBuildLock(env: Env, key: string, token: string): Promise<boolean> {
  return await coordinator(env, key).refreshLock(token);
}

export async function releaseBuildLock(env: Env, key: string, token: string): Promise<void> {
  await coordinator(env, key).releaseLock(token);
}

// The progress of the dashboard's running build, not validated. Null when there is none.
export async function readCoordinatedProgress(
  env: Env,
  key: string,
): Promise<StoredBuildProgress | null> {
  return await coordinator(env, key).progress();
}

export async function writeCoordinatedProgress(
  env: Env,
  key: string,
  progress: StoredBuildProgress,
): Promise<void> {
  await coordinator(env, key).putProgress(progress);
}

export async function deleteCoordinatedProgress(env: Env, key: string): Promise<void> {
  await coordinator(env, key).deleteProgress();
}

// Reserves the target for one refresh job. False when another job holds the reservation;
// `dirtyOnConflict` is then kept for that job to pick up when it releases.
export async function reserveCoordinatedJob(
  env: Env,
  targetKey: string,
  jobId: string,
  dirtyOnConflict?: StoredRefreshDirty,
): Promise<boolean> {
  return await coordinator(env, targetKey).reserveJob(jobId, dirtyOnConflict);
}

// Ends the job's reservation. Returns the dirty marker kept meanwhile, taken when `consumeDirty`.
export async function releaseCoordinatedJob(
  env: Env,
  targetKey: string,
  jobId: string,
  consumeDirty: boolean,
): Promise<StoredRefreshDirty | null> {
  return await coordinator(env, targetKey).releaseJob(jobId, consumeDirty);
}

// Whether a refresh job holds the target's reservation.
export async function coordinatedJobActive(env: Env, targetKey: string): Promise<boolean> {
  return await coordinator(env, targetKey).jobActive();
}

// Applies `mutation` to the target's scheduling state. Null when the object has no state for the
// target yet and no `seed` came with the call: the caller then calls again with what is stored.
export async function mutateCoordinatedTarget(
  env: Env,
  key: string,
  snapshot: RefreshTarget | null,
  mutation: RefreshTargetMutation,
  seed?: RefreshTargetSeed,
): Promise<RefreshTarget | null> {
  return await coordinator(env, key).mutateTarget(snapshot, mutation, seed);
}
