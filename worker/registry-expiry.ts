import { deleteExpiredInstallations } from "./store/installations.ts";
import { deleteExpiredOwnerMetadata } from "./store/owner-metadata.ts";

// Rows deleted per table and run. The scheduled handler runs every 15 minutes, and a row expires
// 90 days after its last write: more than this many at once only means the rest waits for the
// next run. Reads ignore an expired row whether it was deleted yet or not.
const expiredRowsPerRun = 500;

// Deletes the installations and owner metadata snapshots whose time ran out: D1 expires
// nothing by itself. A failure is logged and left to the next run.
export async function deleteExpiredRegistryRows(env: Env): Promise<void> {
  try {
    const [installations, ownerMetadata] = await Promise.all([
      deleteExpiredInstallations(env, expiredRowsPerRun),
      deleteExpiredOwnerMetadata(env, expiredRowsPerRun),
    ]);
    if (installations + ownerMetadata > 0) {
      console.log(
        JSON.stringify({
          area: "registry",
          event: "expired_rows_deleted",
          installations,
          ownerMetadata,
        }),
      );
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        area: "registry",
        event: "expired_rows_delete_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
