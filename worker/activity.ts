import {
  resolveOwnerType,
  slugOwner,
  validOwnerSlug,
  validRepoSlug,
} from "../scripts/lib/dashboard.js";
import type {
  ActivityRange,
  ApiQuota,
  OwnerActivityPayload,
  OwnerActivitySummary,
  RepoDetailActivityPayload,
} from "../src/types.js";
import { sha256Base64Url } from "./crypto.js";
import { auditGitHubFetch } from "./github-audit.js";
import { jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import { gitHubRepositorySchema } from "./schemas.js";
import {
  type ActivitySummaryPayload,
  activityEventsForCurrentRange,
  activityRepositories,
  activitySummaryEvents,
  activitySummaryInput,
  activitySummaryInstructions,
  activitySummaryModel,
  activitySummaryState,
  activityTotals,
  fetchOwnerActivityEvents,
  fetchRepoActivityEvents,
  filterForksOfOwner,
  ownerActivityAgeMs,
  ownerActivitySummaryCacheKey,
  ownerActivitySummaryOutputTokens,
  parseOwnerActivitySummaryText,
  polishActivitySummaryText,
  publicOwnerActivity,
  readOwnerActivity,
  readOwnerActivitySummary,
  readRepoActivity,
  repoActivityCacheKey,
  repoActivitySummaryCacheKey,
  unavailableActivitySummary,
  writeOwnerActivity,
  writeOwnerActivitySummary,
  writeRepoActivity,
} from "./activity-data.js";
import { bestInstallationToken } from "./auth-tokens.js";
import {
  activityRepositorySummaryLimit,
  activitySummaryPromptVersion,
  maxDisplayStaleMs,
} from "./config.js";
import { dashboardErrorMessage, errorStatus, retryAfterHeaders } from "./dashboard-cache.js";
import { acquireBuildLock } from "./dashboard-rebuild.js";
import { repositoryPublicCacheBarrier } from "./owner-metadata-read.js";
import { allowRequestRefresh, crawlerCacheOnlyResponse } from "./owner-metadata-write.js";
import { claudeSummaryText, summaryFailure, summaryRetryDue } from "./release-summary.js";
import {
  activityCacheTtlMs,
  activityRangeFromUrl,
  activityRangeMs,
  detailGitHubJson,
  ownerActivityCacheKey,
} from "./repo-github.js";

async function prepareActivitySummary(
  payload: ActivitySummaryPayload,
  env: Env,
): Promise<
  | { summary: OwnerActivitySummary }
  | { model: string; input: string; inputHash: string; eventsUsed: number }
> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return {
      summary: unavailableActivitySummary(model, null, "Not enough recent work to summarize."),
    };
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  if (!env.ANTHROPIC_API_KEY) {
    return {
      summary: unavailableActivitySummary(
        model,
        inputHash,
        "AI activity summaries are not configured.",
      ),
    };
  }
  return { model, input, inputHash, eventsUsed: activitySummaryEvents(payload).length };
}

export async function summarizeOwnerActivity(
  payload: OwnerActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const prepared = await prepareActivitySummary(payload, env);
  if ("summary" in prepared) return prepared.summary;
  const { model, input, inputHash, eventsUsed } = prepared;
  const text = await claudeSummaryText(env, {
    model,
    maxTokens: ownerActivitySummaryOutputTokens(payload.repositories.length),
    system: activitySummaryInstructions(true),
    schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        repositories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fullName: {
                type: "string",
                enum: payload.repositories
                  .slice(0, activityRepositorySummaryLimit)
                  .map((repository) => repository.fullName),
              },
              summary: { type: "string" },
            },
            required: ["fullName", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "repositories"],
      additionalProperties: false,
    },
    user: [
      `Owner: @${payload.owner.login}`,
      `Owner type: ${payload.owner.type}`,
      `Range: ${payload.range}`,
      `Events included: ${eventsUsed}`,
      "",
      input,
    ].join("\n"),
  });
  if (!text) throw new Error("Claude response did not include activity summary text");
  const parsed = parseOwnerActivitySummaryText(text, payload.repositories);
  if (!parsed) {
    throw new Error("Claude response did not include complete structured activity summaries");
  }
  const summary = {
    state: "ready",
    text: parsed.text,
    generatedAt: new Date().toISOString(),
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    repositories: parsed.repositories,
  } satisfies OwnerActivitySummary;
  await writeOwnerActivitySummary(
    env,
    ownerActivitySummaryCacheKey(payload.owner.login, payload.range, model, inputHash),
    summary,
  );
  return summary;
}

export async function buildOwnerActivity(
  ownerSlug: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<OwnerActivityPayload> {
  const requestToken = await bestInstallationToken(request, env, {
    owners: [ownerSlug],
    repos: [],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (nextQuota: ApiQuota) => {
    quota = nextQuota;
  };
  const owner = await resolveOwnerType(ownerSlug, {
    token: token ?? undefined,
    fetch: auditGitHubFetch("owner-activity", quotaSource, quotaAccount, env),
  });
  if (!owner) {
    throw new Error(`owner not found: ${ownerSlug}`);
  }
  const since = Date.now() - activityRangeMs(range);
  const fetchedEvents = await fetchOwnerActivityEvents(
    owner,
    since,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  const events = await filterForksOfOwner(
    owner,
    fetchedEvents,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  const generatedAt = new Date().toISOString();
  const payload: OwnerActivityPayload = {
    owner,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public data only",
      ...(quota ? { quota } : {}),
    },
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  return {
    ...payload,
    summary: await activitySummaryState(payload, env),
  };
}

export async function repoActivitySummaryState(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const model = activitySummaryModel(env);
  const input = activitySummaryInput(payload);
  if (!input.trim()) {
    return unavailableActivitySummary(model, null, "Not enough recent work to summarize.");
  }
  const inputHash = (await sha256Base64Url(input)).slice(0, 32);
  const eventsUsed = activitySummaryEvents(payload).length;
  const cacheKey = repoActivitySummaryCacheKey(payload.fullName, payload.range, model, inputHash);
  const cached = await readOwnerActivitySummary(env, cacheKey);
  if (cached?.state === "ready" && cached.promptVersion === activitySummaryPromptVersion) {
    return cached;
  }
  if (!env.ANTHROPIC_API_KEY) {
    return unavailableActivitySummary(
      model,
      inputHash,
      "AI activity summaries are not configured.",
    );
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
    message: "Summarizing recent work.",
  };
}

export async function summarizeRepoActivity(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<OwnerActivitySummary> {
  const prepared = await prepareActivitySummary(payload, env);
  if ("summary" in prepared) return prepared.summary;
  const { model, input, inputHash, eventsUsed } = prepared;
  const text = await claudeSummaryText(env, {
    model,
    maxTokens: 420,
    system: activitySummaryInstructions(),
    user: [
      `Repository: ${payload.fullName}`,
      `Range: ${payload.range}`,
      `Events included: ${eventsUsed}`,
      "",
      input,
    ].join("\n"),
  });
  if (!text) throw new Error("Claude response did not include activity summary text");
  const summary = {
    state: "ready",
    text: polishActivitySummaryText(text),
    generatedAt: new Date().toISOString(),
    model,
    inputHash,
    eventsUsed,
    promptVersion: activitySummaryPromptVersion,
  } satisfies OwnerActivitySummary;
  await writeOwnerActivitySummary(
    env,
    repoActivitySummaryCacheKey(payload.fullName, payload.range, model, inputHash),
    summary,
  );
  return summary;
}

export async function currentRepoActivity(
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<RepoDetailActivityPayload> {
  const events = activityEventsForCurrentRange(payload.events, payload.range);
  const current = {
    ...payload,
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  if (events.length === payload.events.length) return current;
  return {
    ...current,
    summary: await repoActivitySummaryState(current, env),
  };
}

export async function buildRepoActivity(
  owner: string,
  repoName: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<RepoDetailActivityPayload> {
  const fullName = `${slugOwner(owner)}/${repoName.toLowerCase()}`;
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  let quota: ApiQuota | undefined;
  const onQuota = (nextQuota: ApiQuota) => {
    quota = nextQuota;
  };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
  const repo = await detailGitHubJson(
    path,
    gitHubRepositorySchema,
    "repository detail",
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    undefined,
    undefined,
    env,
  );
  if (repo.private) {
    throw new Error("private repositories are not visible in public dashboards");
  }
  const since = Date.now() - activityRangeMs(range);
  const events = await fetchRepoActivityEvents(
    path,
    since,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  const generatedAt = new Date().toISOString();
  const payload: RepoDetailActivityPayload = {
    fullName: repo.full_name,
    range,
    generatedAt,
    cache: {
      state: "fresh",
      stale: false,
      generatedAt,
      message: "public data only",
      ...(quota ? { quota } : {}),
    },
    totals: activityTotals(events),
    repositories: activityRepositories(events),
    events,
  };
  return {
    ...payload,
    summary: await repoActivitySummaryState(payload, env),
  };
}

export function withOwnerActivityState(
  payload: OwnerActivityPayload,
  state: OwnerActivityPayload["cache"]["state"],
  message = payload.cache.message,
): OwnerActivityPayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

export function ownerActivitySummaryNeedsRefresh(
  payload: OwnerActivityPayload | null,
  env: Env,
): boolean {
  return (
    payload?.summary?.state === "warming" ||
    summaryRetryDue(payload?.summary) ||
    (!!payload?.summary && payload.summary.promptVersion !== activitySummaryPromptVersion) ||
    (!!payload?.summary && payload.summary.model !== activitySummaryModel(env))
  );
}

export function withPendingOwnerActivitySummary(
  payload: OwnerActivityPayload,
  env: Env,
): OwnerActivityPayload {
  const inputHash = payload.summary?.inputHash ?? null;
  return {
    ...payload,
    summary: {
      state: "warming",
      text: null,
      generatedAt: null,
      model: activitySummaryModel(env),
      inputHash,
      eventsUsed: activitySummaryEvents(payload).length,
      promptVersion: activitySummaryPromptVersion,
      message: "Summarizing recent work.",
    },
  };
}

export async function refreshOwnerActivitySummary(
  key: string,
  payload: OwnerActivityPayload,
  env: Env,
): Promise<void> {
  if (!ownerActivitySummaryNeedsRefresh(payload, env)) return;
  const payloadInputHash = (await sha256Base64Url(activitySummaryInput(payload))).slice(0, 32);
  const lock = await acquireBuildLock(env, `${key}:summary`);
  if (!lock) return;
  try {
    const summary = await summarizeOwnerActivity(payload, env);
    const latest = await publicOwnerActivity(env, (await readOwnerActivity(env, key)) ?? payload);
    if (!latest) return;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.owner.login.toLowerCase() !== payload.owner.login.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash ||
      (summary.inputHash !== null && latestInputHash !== summary.inputHash)
    ) {
      return;
    }
    await writeOwnerActivity(env, key, {
      ...latest,
      summary,
    });
  } catch (error) {
    const latest = await publicOwnerActivity(env, (await readOwnerActivity(env, key)) ?? payload);
    if (!latest) return;
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.owner.login.toLowerCase() !== payload.owner.login.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash
    ) {
      return;
    }
    const previous = latest.summary ?? payload.summary;
    await writeOwnerActivity(env, key, {
      ...latest,
      summary: {
        ...previous,
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: activitySummaryModel(env),
        inputHash: payloadInputHash,
        eventsUsed: activitySummaryEvents(latest).length,
        promptVersion: activitySummaryPromptVersion,
        ...summaryFailure("owner-activity", key, previous, error),
      },
    });
  } finally {
    await lock.release();
  }
}

export async function refreshOwnerActivity(
  key: string,
  ownerSlug: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, key);
  if (!lock) return;
  try {
    const payload = await publicOwnerActivity(
      env,
      await buildOwnerActivity(ownerSlug, range, request, env),
    );
    if (!payload) return;
    await writeOwnerActivity(env, key, payload);
    if (ownerActivitySummaryNeedsRefresh(payload, env)) {
      await refreshOwnerActivitySummary(key, payload, env);
    }
  } finally {
    await lock.release();
  }
}

export async function ownerActivityResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const ownerSlug = slugOwner(url.pathname.replace(/^\/api\//, "").split("/")[0] ?? "");
  if (!validOwnerSlug(ownerSlug)) {
    return jsonResponse({ error: "invalid owner" }, 400);
  }
  const range = activityRangeFromUrl(url);
  const key = ownerActivityCacheKey(ownerSlug, range);
  const rawCached = await readOwnerActivity(env, key);
  const cached = rawCached ? await publicOwnerActivity(env, rawCached) : null;
  const age = ownerActivityAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && age < activityCacheTtlMs(range)) {
    const summaryNeedsRefresh = allowRefresh && ownerActivitySummaryNeedsRefresh(cached, env);
    if (summaryNeedsRefresh) {
      context.waitUntil(refreshOwnerActivitySummary(key, cached, env).catch(() => undefined));
    }
    const responsePayload = summaryNeedsRefresh
      ? withPendingOwnerActivitySummary(cached, env)
      : cached;
    return jsonResponse(responsePayload, responsePayload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    });
  }
  if (cached && age < maxDisplayStaleMs) {
    if (allowRefresh) {
      context.waitUntil(
        refreshOwnerActivity(key, ownerSlug, range, request, env).catch(() => undefined),
      );
    }
    return jsonResponse(
      withOwnerActivityState(
        cached,
        "stale",
        allowRefresh ? "showing cached work while refreshing" : "showing cached work",
      ),
      200,
      { "cache-control": "no-store" },
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached owner activity unavailable for crawler");
  }

  try {
    const payload = await publicOwnerActivity(
      env,
      await buildOwnerActivity(ownerSlug, range, request, env),
    );
    if (!payload) {
      throw new Error("repository privacy metadata unavailable");
    }
    await writeOwnerActivity(env, key, payload);
    if (allowRefresh && ownerActivitySummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshOwnerActivitySummary(key, payload, env).catch(() => undefined));
    }
    return jsonResponse(payload, payload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withOwnerActivityState(cached, "stale", dashboardErrorMessage(error)),
        200,
        retryAfterHeaders(error),
      );
    }
    return jsonResponse(
      { error: dashboardErrorMessage(error) },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

export function repoActivityAgeMs(payload: RepoDetailActivityPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export function withRepoActivityState(
  payload: RepoDetailActivityPayload,
  state: RepoDetailActivityPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailActivityPayload {
  return {
    ...payload,
    cache: {
      ...payload.cache,
      state,
      stale: state !== "fresh",
      ...(message ? { message } : {}),
    },
  };
}

export function repoActivitySummaryNeedsRefresh(
  payload: RepoDetailActivityPayload | null,
  env: Env,
): boolean {
  return (
    payload?.summary?.state === "warming" ||
    summaryRetryDue(payload?.summary) ||
    (!!payload?.summary && payload.summary.promptVersion !== activitySummaryPromptVersion) ||
    (!!payload?.summary && payload.summary.model !== activitySummaryModel(env))
  );
}

export async function refreshRepoActivitySummary(
  key: string,
  payload: RepoDetailActivityPayload,
  env: Env,
): Promise<void> {
  if (!repoActivitySummaryNeedsRefresh(payload, env)) return;
  const payloadInputHash = (await sha256Base64Url(activitySummaryInput(payload))).slice(0, 32);
  const lock = await acquireBuildLock(env, `${key}:summary`);
  if (!lock) return;
  try {
    const summary = await summarizeRepoActivity(payload, env);
    const latest = await currentRepoActivity((await readRepoActivity(env, key)) ?? payload, env);
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.fullName.toLowerCase() !== payload.fullName.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash ||
      (summary.inputHash !== null && latestInputHash !== summary.inputHash)
    ) {
      return;
    }
    await writeRepoActivity(env, key, {
      ...latest,
      summary,
    });
  } catch (error) {
    const latest = await currentRepoActivity((await readRepoActivity(env, key)) ?? payload, env);
    const latestInputHash = (await sha256Base64Url(activitySummaryInput(latest))).slice(0, 32);
    if (
      latest.fullName.toLowerCase() !== payload.fullName.toLowerCase() ||
      latest.range !== payload.range ||
      latestInputHash !== payloadInputHash
    ) {
      return;
    }
    const previous = latest.summary ?? payload.summary;
    await writeRepoActivity(env, key, {
      ...latest,
      summary: {
        ...previous,
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: activitySummaryModel(env),
        inputHash: payloadInputHash,
        eventsUsed: activitySummaryEvents(latest).length,
        promptVersion: activitySummaryPromptVersion,
        ...summaryFailure("repo-activity", key, previous, error),
      },
    });
  } finally {
    await lock.release();
  }
}

export async function refreshRepoActivity(
  key: string,
  owner: string,
  repo: string,
  range: ActivityRange,
  request: Request,
  env: Env,
): Promise<void> {
  const lock = await acquireBuildLock(env, key);
  if (!lock) return;
  try {
    const payload = await buildRepoActivity(owner, repo, range, request, env);
    await writeRepoActivity(env, key, payload);
    if (repoActivitySummaryNeedsRefresh(payload, env)) {
      await refreshRepoActivitySummary(key, payload, env);
    }
  } finally {
    await lock.release();
  }
}

export async function repoActivityResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const [, , , rawOwner, rawRepo] = url.pathname.split("/");
  const owner = slugOwner(decodeURIComponent(rawOwner ?? ""));
  const repo = decodeURIComponent(rawRepo ?? "").toLowerCase();
  const fullName = `${owner}/${repo}`;
  if (!validRepoSlug(fullName)) {
    return jsonResponse({ error: "invalid repository" }, 400, { "cache-control": "no-store" });
  }
  const barrier = await repositoryPublicCacheBarrier(env, fullName);
  if (barrier === "blocked") {
    return jsonResponse({ error: "repository unavailable" }, 404, {
      "cache-control": "no-store",
    });
  }
  const range = activityRangeFromUrl(url);
  const key = repoActivityCacheKey(owner, repo, range);
  const rawCached = barrier === "clear" ? await readRepoActivity(env, key) : null;
  const cached = rawCached ? await currentRepoActivity(rawCached, env) : null;
  const age = repoActivityAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  if (cached && age < activityCacheTtlMs(range)) {
    if (allowRefresh && repoActivitySummaryNeedsRefresh(cached, env)) {
      context.waitUntil(refreshRepoActivitySummary(key, cached, env).catch(() => undefined));
    }
    return jsonResponse(cached, cached.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    });
  }
  if (cached && age < maxDisplayStaleMs) {
    if (allowRefresh) {
      context.waitUntil(
        refreshRepoActivity(key, owner, repo, range, request, env).catch(() => undefined),
      );
    }
    return jsonResponse(
      withRepoActivityState(
        cached,
        "stale",
        allowRefresh ? "showing cached work while refreshing" : "showing cached work",
      ),
      200,
      { "cache-control": "no-store" },
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached repository activity unavailable for crawler");
  }

  try {
    const payload = await buildRepoActivity(owner, repo, range, request, env);
    await writeRepoActivity(env, key, payload);
    if (allowRefresh && repoActivitySummaryNeedsRefresh(payload, env)) {
      context.waitUntil(refreshRepoActivitySummary(key, payload, env).catch(() => undefined));
    }
    return jsonResponse(payload, payload.summary?.state === "warming" ? 202 : 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    if (cached) {
      return jsonResponse(
        withRepoActivityState(cached, "stale", dashboardErrorMessage(error)),
        200,
        retryAfterHeaders(error),
      );
    }
    return jsonResponse(
      { error: dashboardErrorMessage(error) },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}
