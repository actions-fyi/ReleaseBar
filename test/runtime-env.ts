// Every test runs the Worker with the env of the Workers runtime: the local KV namespace, D1
// database, queue, assets and Durable Objects that wrangler.jsonc binds. No binding is faked.
//
// What a test passes as an env are the variables and secrets of its case, such as GITHUB_TOKEN,
// and at most a wrapper around a real binding (`observedDatabase`). `testEnv` sets them on the
// runtime's env for the rest of the test, so the Durable Objects and the queue consumer, which
// the runtime constructs with that same env, see them too. test/reset-storage.ts takes them off
// again after each test.
import { env as runtimeEnv } from "cloudflare:workers";

export type TestEnv = Partial<Env>;

const runtimeEntries = runtimeEnv as unknown as Record<string, unknown>;

// The env as the runtime made it, before any test set a variable on it: the real bindings, for
// the helpers below that seed and read storage.
export const realEnv: Env = { ...runtimeEnv };

// The D1 database of the Workers runtime itself, also while a test's env has a wrapper around
// it.
export const testDatabase = realEnv.DB;

// The KV namespace of the Workers runtime.
export const testCache = realEnv.DASHBOARD_CACHE;

// What the tests set on the runtime's env, with the value each entry had before.
const changedEntries = new Map<string, { had: boolean; value: unknown }>();

// Takes every variable a test set off the runtime's env again.
export function resetTestEnv(): void {
  for (const [name, { had, value }] of changedEntries) {
    if (had) runtimeEntries[name] = value;
    else delete runtimeEntries[name];
  }
  changedEntries.clear();
}

// Sets the variables of a test's case on the runtime's env, in place of the ones the test set
// before, and returns the env as it is now. The result is a copy: a test may hold two, such as
// one with a database that fails and one without.
export function testEnv(vars: TestEnv = {}): Env {
  resetTestEnv();
  for (const [name, value] of Object.entries(vars)) {
    changedEntries.set(name, { had: name in runtimeEntries, value: runtimeEntries[name] });
    runtimeEntries[name] = value;
  }
  return { ...runtimeEnv };
}
