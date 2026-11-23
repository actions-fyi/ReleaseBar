import { DurableObject } from "cloudflare:workers";
import { slugOwner, validOwnerSlug } from "../../shared/dashboard.ts";
import {
  type OwnerMetadataMutation,
  type OwnerMetadataSnapshot,
  ownerMetadataTtlSeconds,
} from "../config.ts";
import { normalizeOwnerMetadataSnapshot } from "../dashboard-cache.ts";
import {
  readOwnerMetadataKv,
  reconcileOwnerMetadataSnapshots,
  writeOwnerMetadata,
} from "../owner-metadata-read.ts";
import {
  applyOwnerMetadataMutation,
  isOwnerMetadataMutation,
  safeIso,
} from "../owner-metadata-write.ts";
import { SerialQueue } from "./serial.ts";
import { firstRow, parseStored } from "./sql.ts";

type SnapshotRow = { value: string };

// What is known about one owner's repositories: an instance is named by `ownerMetadataObjectName`
// and holds the owner's metadata snapshot, which includes the repositories that turned private or
// were removed and must stay hidden.
//
// The snapshot is also cached in KV, and both methods reconcile the two. A call reads and writes
// KV between reading and writing the object's own copy, so the calls run one at a time, through a
// queue: waiting on KV would otherwise let another call in, and the cache could end up with the
// older of two snapshots. Step 7c of the stack migration moves the snapshot to D1 and ends this.
export class OwnerMetadata extends DurableObject<Env> {
  readonly #calls = new SerialQueue();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Holds at most one row.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `);
  }

  // The owner's snapshot, reconciled with the cached copy. Null when neither has one.
  read(owner: string): Promise<OwnerMetadataSnapshot | null> {
    const slug = ownerSlug(owner);
    return this.#calls.run(async () => {
      const snapshot = await this.#reconciled(slug);
      if (snapshot) this.#put(snapshot);
      return snapshot;
    });
  }

  // Applies `mutation` and stores the result in the object and the cache. Null when the mutation
  // leaves no snapshot to store.
  mutate(owner: string, mutation: OwnerMetadataMutation): Promise<OwnerMetadataSnapshot | null> {
    const slug = ownerSlug(owner);
    if (!isOwnerMetadataMutation(mutation)) throw new TypeError("invalid owner metadata mutation");
    return this.#calls.run(async () => {
      const updated = applyOwnerMetadataMutation(slug, await this.#reconciled(slug), mutation);
      if (!updated) return null;
      this.#put(updated);
      await writeOwnerMetadata(this.env, updated);
      return updated;
    });
  }

  async #reconciled(owner: string): Promise<OwnerMetadataSnapshot | null> {
    const sql = this.ctx.storage.sql;
    const row = firstRow(sql.exec<SnapshotRow>("SELECT value FROM owner_metadata"));
    let stored = row
      ? normalizeOwnerMetadataSnapshot(owner, parseStored<OwnerMetadataSnapshot>(row.value))
      : null;
    if (stored && Date.now() - safeIso(stored.generatedAt) > ownerMetadataTtlSeconds * 1000) {
      sql.exec("DELETE FROM owner_metadata");
      stored = null;
    }
    const cached = await readOwnerMetadataKv(this.env, owner);
    return reconcileOwnerMetadataSnapshots(owner, stored, cached, true);
  }

  #put(snapshot: OwnerMetadataSnapshot): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO owner_metadata (id, value) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET value = excluded.value`,
      JSON.stringify(snapshot),
    );
  }
}

function ownerSlug(owner: string): string {
  const slug = slugOwner(owner);
  if (!validOwnerSlug(slug)) throw new TypeError("invalid owner");
  return slug;
}
