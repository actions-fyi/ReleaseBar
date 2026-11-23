// Who may start an AI summary, and how many. Only a signed-in user's request starts one, and
// each one that calls the model counts against that user's hourly limit and the daily limit for
// all users. Cached summaries are served to everyone and count nothing.
//
// The counters live in one Durable Object, the DASHBOARD_LOCKS instance named below, because a
// limit needs an atomic read-and-add, which KV cannot give.

import { currentSession } from "./app-shell.js";
import { jsonResponse } from "./http.js";
import { isCrawlerRequest } from "./owner-metadata-write.js";
import { summaryRateLimits } from "./summary-limits.js";
import type { BackgroundContext } from "./runtime.js";

export const summarySignInMessage = "Sign in to generate this AI summary.";
export const summaryUserLimitMessage =
  "You have reached the hourly AI summary limit. Try again later.";
export const summaryGlobalLimitMessage =
  "The daily AI summary limit has been reached. Try again tomorrow.";
export const summaryQuotaUnavailableMessage = "AI summaries are unavailable right now.";

const quotaObjectName = "summary-quota";
const globalCounterKey = "summary-quota:global";
const hourMs = 3_600_000;
const dayMs = 86_400_000;

// A count within one fixed window: `window` is the window's index since the epoch.
type StoredSummaryCount = { window: number; count: number };

type QuotaVerdict = { allowed: boolean; scope?: "user" | "global" };

// Counts one model call against the limits, and throws SummaryLimitError when one is reached.
export type SummaryReservation = () => Promise<void>;

export class SummaryLimitError extends Error {}

// The Durable Object side: checks both limits for a user and, with `reserve`, counts one
// generation against them. Check and count happen as one step.
export async function summaryQuotaResponse(
  state: DurableObjectState,
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    userId?: unknown;
    reserve?: unknown;
  } | null;
  const userId = body?.userId;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId)) {
    return new Response(null, { status: 400 });
  }
  const check = async (): Promise<Response> => {
    const limits = summaryRateLimits(env);
    const now = Date.now();
    const userWindow = Math.floor(now / hourMs);
    const globalWindow = Math.floor(now / dayMs);
    const userKey = `summary-quota:user:${userId}`;
    const [user, global] = await Promise.all([
      state.storage.get<StoredSummaryCount>(userKey),
      state.storage.get<StoredSummaryCount>(globalCounterKey),
    ]);
    const userCount = user?.window === userWindow ? user.count : 0;
    const globalCount = global?.window === globalWindow ? global.count : 0;
    const headers = { "cache-control": "no-store" };
    if (userCount >= limits.userHourly) {
      return jsonResponse({ allowed: false, scope: "user" } satisfies QuotaVerdict, 200, headers);
    }
    if (globalCount >= limits.globalDaily) {
      return jsonResponse({ allowed: false, scope: "global" } satisfies QuotaVerdict, 200, headers);
    }
    if (body?.reserve === true) {
      await Promise.all([
        state.storage.put(userKey, {
          window: userWindow,
          count: userCount + 1,
        } satisfies StoredSummaryCount),
        state.storage.put(globalCounterKey, {
          window: globalWindow,
          count: globalCount + 1,
        } satisfies StoredSummaryCount),
      ]);
    }
    return jsonResponse({ allowed: true } satisfies QuotaVerdict, 200, headers);
  };
  return state.blockConcurrencyWhile ? state.blockConcurrencyWhile(check) : check();
}

// Asks the quota object; returns why the user may not generate, or null when they may.
// Without the object nothing can be counted, so nothing is generated.
async function quotaRefusal(env: Env, userId: number, reserve: boolean): Promise<string | null> {
  const locks = env.DASHBOARD_LOCKS;
  if (!locks) return summaryQuotaUnavailableMessage;
  try {
    const response = await locks.get(locks.idFromName(quotaObjectName)).fetch(
      new Request("https://releasebar.internal/summary-quota", {
        method: "POST",
        body: JSON.stringify({ userId, reserve }),
      }),
    );
    if (!response.ok) return summaryQuotaUnavailableMessage;
    const verdict = (await response.json()) as QuotaVerdict;
    if (verdict.allowed === true) return null;
    return verdict.scope === "global" ? summaryGlobalLimitMessage : summaryUserLimitMessage;
  } catch {
    return summaryQuotaUnavailableMessage;
  }
}

export type SummaryGate =
  | { allowed: true; reserve: SummaryReservation }
  | { allowed: false; message: string };

// Whether this request may start a summary: it must come from a signed-in user who is under
// the limits. Nothing is counted until `reserve` runs, right before the model is called.
export async function summaryGate(request: Request, env: Env): Promise<SummaryGate> {
  if (isCrawlerRequest(request)) return { allowed: false, message: summarySignInMessage };
  const session = await currentSession(request, env).catch(() => null);
  if (!session) return { allowed: false, message: summarySignInMessage };
  const userId = session.user.id;
  const refusal = await quotaRefusal(env, userId, false);
  if (refusal) return { allowed: false, message: refusal };
  return {
    allowed: true,
    reserve: async () => {
      const reserveRefusal = await quotaRefusal(env, userId, true);
      if (reserveRefusal) throw new SummaryLimitError(reserveRefusal);
    },
  };
}

// Starts a summary in the background when the request may; otherwise returns why it may not.
export async function startGatedSummary(
  request: Request,
  env: Env,
  context: BackgroundContext,
  start: (reserve: SummaryReservation) => Promise<unknown>,
): Promise<string | null> {
  const gate = await summaryGate(request, env);
  if (!gate.allowed) return gate.message;
  context.waitUntil(start(gate.reserve).catch(() => undefined));
  return null;
}

// A pending summary as shown to a request that may not start it: unavailable, with the reason,
// so the client stops polling. Stored payloads keep `warming` for the next request that may.
export function refusedSummary<Summary extends { state: string; message?: string }>(
  summary: Summary | undefined,
  message: string,
): Summary | undefined {
  return summary?.state === "warming" ? { ...summary, state: "unavailable", message } : summary;
}

// Responses that depend on who asked must not be reused for someone else, such as the same
// visitor after signing in.
export const refusedSummaryHeaders = { "cache-control": "no-store" };
