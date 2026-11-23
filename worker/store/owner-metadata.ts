// Owner metadata: what is known about one owner's repositories, including the ones that turned
// private or were removed and must stay hidden.
//
// The snapshot of an owner lives in a Durable Object, which also keeps a copy in KV and
// reconciles the two; reads that must not wait for the object take the copy. Step 7c of the stack
// migration moves the snapshot to D1 (docs/data-model.md).

import { slugOwner } from "../../shared/dashboard.ts";
import {
  type OwnerMetadataMutation,
  type OwnerMetadataSnapshot,
  ownerMetadataPrefix,
  ownerMetadataTtlSeconds,
} from "../config.ts";
import { ownerMetadataObjectName } from "../runtime.ts";
import { tryJsonParse } from "../schemas.ts";

export function ownerMetadataKey(owner: string): string {
  return `${ownerMetadataPrefix}${slugOwner(owner)}`;
}

// The copy of the owner's snapshot, as it was stored, not validated.
export async function readOwnerMetadataCopy(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  const raw = await env.DASHBOARD_CACHE.get(ownerMetadataKey(owner));
  if (!raw) return null;
  return tryJsonParse<OwnerMetadataSnapshot>(raw, `owner metadata ${owner}`);
}

export async function writeOwnerMetadata(env: Env, snapshot: OwnerMetadataSnapshot): Promise<void> {
  await env.DASHBOARD_CACHE.put(ownerMetadataKey(snapshot.owner), JSON.stringify(snapshot), {
    expirationTtl: ownerMetadataTtlSeconds,
  });
}

// The owner's snapshot from its object, reconciled with the copy, not validated. `owner` is the
// owner's slug. Rejects when the object can't be reached.
export async function readCoordinatedOwnerMetadata(
  env: Env,
  owner: string,
): Promise<OwnerMetadataSnapshot | null> {
  return await env.OWNER_METADATA.getByName(ownerMetadataObjectName(owner)).read(owner);
}

// Applies `mutation` in the owner's object, which stores the result in the object and the copy.
// `owner` is the owner's slug. Null when the mutation leaves no snapshot to store. Rejects when
// the object can't be reached.
export async function mutateCoordinatedOwnerMetadata(
  env: Env,
  owner: string,
  mutation: OwnerMetadataMutation,
): Promise<OwnerMetadataSnapshot | null> {
  return await env.OWNER_METADATA.getByName(ownerMetadataObjectName(owner)).mutate(
    owner,
    mutation,
  );
}
