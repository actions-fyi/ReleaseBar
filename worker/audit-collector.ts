// The audit collector: what one request, scheduler tick or queue job adds to the audit tables is
// kept in memory and written as one batch once its work is done, not one statement per event.
// D1 limits the queries of an invocation (50 on the Workers free plan) and counts a batch as one.
//
// `collectAudit` gives a handler an env and a context of its own. Code that audits with that env
// adds to the collector; with any other env it writes at once, as a test that calls a function
// directly does. The context tells the collector which background work is under way, so the
// batch is written when all of it has settled. Work that takes long is not kept waiting: what
// is collected is written at least every two minutes, and when it reaches `flushRows`.

import type { SchedulerAuditEvent } from "../src/types.ts";
import type { BackgroundContext } from "./runtime.ts";
import { writeAuditBatch } from "./store/audit-batch.ts";
import type { GitHubAccessCalls } from "./store/github-access.ts";

const flushIntervalMs = 2 * 60 * 1000;
const flushRows = 200;

type Collector = {
  // The env the handler got: the one the batch is written with.
  env: Env;
  events: SchedulerAuditEvent[];
  // GitHub calls not yet counted, by route key.
  calls: Map<string, GitHubAccessCalls>;
  waitUntil: (promise: Promise<unknown>) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  // Set once the last batch is written: what comes later is written at once.
  closed: boolean;
};

const collectors = new WeakMap<Env, Collector>();

async function write(collector: Collector): Promise<void> {
  if (collector.timer !== undefined) {
    clearTimeout(collector.timer);
    collector.timer = undefined;
  }
  const events = collector.events.splice(0);
  const calls = [...collector.calls.values()];
  collector.calls.clear();
  if (events.length === 0 && calls.length === 0) return;
  try {
    await writeAuditBatch(collector.env, events, calls);
  } catch (error) {
    // As before the collector: an audit row that can't be written fails nothing.
    console.warn(
      JSON.stringify({
        area: "audit",
        event: "audit_write_failed",
        events: events.length,
        calls: calls.length,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function collected(collector: Collector): void {
  if (collector.events.length + collector.calls.size >= flushRows) {
    collector.waitUntil(write(collector));
    return;
  }
  collector.timer ??= setTimeout(() => {
    collector.timer = undefined;
    collector.waitUntil(write(collector));
  }, flushIntervalMs);
}

// Starts collecting for one invocation. The handler works with the `env` and `context` it gets
// back and calls `finish` when its own work is done. The batch is then written once the
// background work has settled: in the `waitUntil` promise of the work that settles last, or in
// one of its own when the handler left none. The promise of `finish` resolves when it is.
export function collectAudit(
  env: Env,
  context: BackgroundContext,
): { env: Env; context: BackgroundContext; finish: () => Promise<void> } {
  // Background work that has not settled.
  let waiting = 0;
  let finished = false;
  let draining: Promise<void> | undefined;
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const drain = async (): Promise<void> => {
    while (collector.events.length > 0 || collector.calls.size > 0) {
      await write(collector);
    }
    draining = undefined;
    // Work that began meanwhile drains again when it settles.
    if (waiting > 0) return;
    if (collector.timer !== undefined) clearTimeout(collector.timer);
    collector.timer = undefined;
    collector.closed = true;
    close();
  };
  const settled = async (): Promise<void> => {
    waiting -= 1;
    if (finished && waiting === 0 && !collector.closed) await (draining ??= drain());
  };
  const collector: Collector = {
    env,
    events: [],
    calls: new Map(),
    waitUntil(promise) {
      waiting += 1;
      context.waitUntil(
        Promise.resolve(promise).then(
          async (value: unknown) => {
            await settled();
            return value;
          },
          async (error: unknown) => {
            await settled();
            throw error;
          },
        ),
      );
    },
    timer: undefined,
    closed: false,
  };
  // An env of this invocation's own: the runtime hands every invocation of an isolate the same
  // one. It reads through to the env it stands for.
  const scoped = new Proxy(env, {});
  collectors.set(scoped, collector);
  return {
    env: scoped,
    context: { waitUntil: (promise) => collector.waitUntil(promise) },
    finish(): Promise<void> {
      finished = true;
      if (waiting === 0 && !collector.closed) {
        const nothing = collector.events.length === 0 && collector.calls.size === 0;
        draining ??= drain();
        if (!nothing) context.waitUntil(draining);
      }
      return closed;
    },
  };
}

function openCollector(env: Env | undefined): Collector | undefined {
  const collector = env && collectors.get(env);
  return collector && !collector.closed ? collector : undefined;
}

// Adds the event to the batch of the invocation `env` belongs to. False when there is none: the
// caller writes the event itself.
export function collectAuditEvent(env: Env, event: SchedulerAuditEvent): boolean {
  const collector = openCollector(env);
  if (!collector) return false;
  collector.events.push(event);
  collected(collector);
  return true;
}

// Lets `add` put a GitHub call into the uncounted calls of the invocation `env` belongs to.
// False when there is none: the caller counts the call itself.
export function collectGitHubAccess(
  env: Env | undefined,
  add: (pending: Map<string, GitHubAccessCalls>) => void,
): boolean {
  const collector = openCollector(env);
  if (!collector) return false;
  add(collector.calls);
  collected(collector);
  return true;
}
