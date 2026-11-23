// Runs before each test file of the `workers` project. The Durable Objects, the KV namespace and
// the queue of the Workers runtime are shared by the tests of a file: this empties them after each
// test, so no test sees the locks, reservations or deliveries of the one before. Spies a test put
// on a Durable Object class end with it too.
import { reset } from "cloudflare:test";
import { afterEach, vi } from "vitest";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
