// Who may start an AI summary, and how many. Only a signed-in user's request starts one, and
// each one that calls the model counts against that user's hourly limit and the daily limit for
// all users. Cached summaries are served to everyone and count nothing.
//
// The counters live in one Durable Object (worker/store/summary-quota.ts), because a limit needs
// an atomic read-and-add, which KV cannot give.

import { currentSession } from "./app-shell.ts";
import { isCrawlerRequest } from "./owner-metadata-write.ts";
import { summaryRateLimits } from "./summary-limits.ts";
import type { BackgroundContext } from "./runtime.ts";
import { checkSummaryQuota } from "./store/summary-quota.ts";

export const summarySignInMessage = "Sign in to generate this AI summary.";
export const summaryUserLimitMessage =
  "You have reached the hourly AI summary limit. Try again later.";
export const summaryGlobalLimitMessage =
  "The daily AI summary limit has been reached. Try again tomorrow.";
export const summaryQuotaUnavailableMessage = "AI summaries are unavailable right now.";

// Counts one model call against the limits, and throws SummaryLimitError when one is reached.
export type SummaryReservation = () => Promise<void>;

export class SummaryLimitError extends Error {}

// Asks the quota object; returns why the user may not generate, or null when they may.
// When the object can't be reached nothing can be counted, so nothing is generated.
async function quotaRefusal(env: Env, userId: number, reserve: boolean): Promise<string | null> {
  try {
    const verdict = await checkSummaryQuota(env, userId, summaryRateLimits(env), reserve);
    if (verdict.allowed) return null;
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
