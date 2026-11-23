// Runs before each test file of the `workers` project. The Durable Objects, the KV namespace, the
// D1 database and the queue of the Workers runtime are shared by the tests of a file: this empties
// them after each test, so no test sees the locks, reservations, rows or deliveries of the one
// before. Spies a test put on a Durable Object class end with it too, and so do the reservations
// the Worker keeps in memory while an object can't be reached.
//
// Emptying the database drops its tables, so each test starts by applying the SQL files of
// migrations/ again.
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { localRefreshDirtyMarkers, localRefreshJobReservations } from "../worker/config.ts";
import { resetTestEnv } from "./runtime-env.ts";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetTestEnv();
  localRefreshJobReservations.clear();
  localRefreshDirtyMarkers.clear();
  await reset();
});
