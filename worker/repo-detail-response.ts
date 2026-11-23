import { slugOwner, validRepoSlug } from "../scripts/lib/dashboard.js";
import type { RepoDetailPayload } from "../src/types.js";
import { sharedQuotaCooldown } from "./github-audit.js";
import { jsonResponse } from "./http.js";
import type { Env, ExecutionContext } from "./runtime.js";
import type { InitialPageData } from "./app-shell.js";
import { withRepoDetailContributorTrustProfiles } from "./audience-data.js";
import { sourceInstallationRegistryCovers } from "./auth-tokens.js";
import { maxDisplayStaleMs, repoDetailCacheTtlMs, repoDetailWarmingRefreshMs } from "./config.js";
import { dashboardErrorMessage, errorStatus, retryAfterHeaders } from "./dashboard-cache.js";
import { acquireBuildLock } from "./dashboard-rebuild.js";
import { repositoryPublicCacheBarrier } from "./owner-metadata-read.js";
import { allowRequestRefresh, crawlerCacheOnlyResponse } from "./owner-metadata-write.js";
import {
  readRepoDetail,
  releaseSummaryCacheKey,
  releaseSummaryModel,
  repoDetailAgeMs,
  repoDetailCacheKey,
  summarizeReleaseDelta,
  summaryFailure,
  summaryRetryDue,
  withRepoDetailState,
  writeReleaseSummary,
  writeRepoDetail,
} from "./release-summary.js";
import {
  SummaryLimitError,
  type SummaryReservation,
  refusedSummary,
  refusedSummaryHeaders,
  startGatedSummary,
} from "./summary-quota.js";
import {
  buildRepoDetailSingleFlight,
  refreshRepoDetail,
  repoDetailCredential,
} from "./repo-detail.js";

export function releaseSummaryNeedsRefresh(payload: RepoDetailPayload | null, env: Env): boolean {
  const hasComparableCommits =
    !!payload?.project.releaseDate &&
    payload.project.version !== "unreleased" &&
    !!payload.project.latestCommitSha &&
    payload.project.commitsSinceRelease !== null &&
    payload.project.commitsSinceRelease > 0;
  return (
    payload?.releaseSummary?.state === "warming" ||
    (hasComparableCommits && summaryRetryDue(payload?.releaseSummary)) ||
    (hasComparableCommits &&
      !!payload?.releaseSummary &&
      payload.releaseSummary.model !== releaseSummaryModel(env))
  );
}

export async function refreshReleaseSummary(
  key: string,
  owner: string,
  repo: string,
  payload: RepoDetailPayload,
  request: Request,
  env: Env,
  reserve: SummaryReservation,
): Promise<void> {
  if (!env.ANTHROPIC_API_KEY || !releaseSummaryNeedsRefresh(payload, env)) return;
  const lock = await acquireBuildLock(env, `${key}:release-summary`);
  if (!lock) return;
  try {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const summary = await summarizeReleaseDelta(payload.project, path, request, env, reserve);
    const summaryKey = releaseSummaryCacheKey(
      payload.project,
      summary.model ?? releaseSummaryModel(env),
    );
    if (summaryKey && summary.state === "ready") {
      await writeReleaseSummary(env, summaryKey, summary);
    }
    const latest = (await readRepoDetail(env, key)) ?? payload;
    if (
      latest.project.version !== payload.project.version ||
      latest.project.latestCommitSha !== payload.project.latestCommitSha
    ) {
      return;
    }
    await writeRepoDetail(env, key, {
      ...latest,
      releaseSummary: summary,
    });
  } catch (error) {
    // Over the limit: the summary stays pending for a request that may start it.
    if (error instanceof SummaryLimitError) return;
    const latest = (await readRepoDetail(env, key)) ?? payload;
    if (
      latest.project.version !== payload.project.version ||
      latest.project.latestCommitSha !== payload.project.latestCommitSha
    ) {
      return;
    }
    const previous = latest.releaseSummary ?? payload.releaseSummary;
    await writeRepoDetail(env, key, {
      ...latest,
      releaseSummary: {
        ...previous,
        state: "unavailable",
        text: null,
        generatedAt: null,
        model: releaseSummaryModel(env),
        releaseTag: latest.project.releaseDate ? latest.project.version : null,
        headSha: latest.project.latestCommitSha,
        commitCount: latest.project.commitsSinceRelease,
        commitsUsed: 0,
        ...summaryFailure("release", `${owner}/${repo}`, previous, error),
      },
    });
  } finally {
    await lock.release();
  }
}

export async function repoDetailResponse(
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

  const key = repoDetailCacheKey(owner, repo);
  const cached = barrier === "clear" ? await readRepoDetail(env, key) : null;
  const ageMs = repoDetailAgeMs(cached);
  const allowRefresh = allowRequestRefresh(request);
  const sharedCritical = allowRefresh
    ? await sharedQuotaCooldown(env, "core").catch(() => null)
    : null;
  const appCovered =
    sharedCritical?.active &&
    (await sourceInstallationRegistryCovers(env, {
      owners: [],
      repos: [fullName],
    }).catch(() => false));
  const refreshAllowed = allowRefresh && (!sharedCritical?.active || appCovered);
  // Starts the release summary when it is due and this request may start one. A request that
  // may not gets the pending summary marked unavailable, with the reason.
  const withReleaseSummary = async (
    payload: RepoDetailPayload,
  ): Promise<{ payload: RepoDetailPayload; headers: Record<string, string> | undefined }> => {
    const due = (refreshAllowed || !allowRefresh) && releaseSummaryNeedsRefresh(payload, env);
    const refused = due
      ? await startGatedSummary(request, env, context, (reserve) =>
          refreshReleaseSummary(key, owner, repo, payload, request, env, reserve),
        )
      : null;
    if (!refused) return { payload, headers: undefined };
    return {
      payload: { ...payload, releaseSummary: refusedSummary(payload.releaseSummary, refused) },
      headers: refusedSummaryHeaders,
    };
  };
  if (cached?.cache.state === "warming" && ageMs < repoDetailWarmingRefreshMs) {
    const { payload } = await withReleaseSummary(cached);
    return jsonResponse(await withRepoDetailContributorTrustProfiles(payload, env), 202, {
      "cache-control": "no-store",
    });
  }
  if (cached && ageMs < repoDetailCacheTtlMs && cached.cache.state !== "warming") {
    const { payload, headers } = await withReleaseSummary(cached);
    return jsonResponse(await withRepoDetailContributorTrustProfiles(payload, env), 200, headers);
  }
  if (cached && ageMs <= maxDisplayStaleMs) {
    if (refreshAllowed) {
      context.waitUntil(refreshRepoDetail(key, owner, repo, request, env).catch(() => undefined));
    }
    const summarized = await withReleaseSummary(cached);
    return jsonResponse(
      await withRepoDetailContributorTrustProfiles(
        withRepoDetailState(
          summarized.payload,
          "stale",
          refreshAllowed
            ? "refreshing repository statistics"
            : sharedCritical?.active
              ? "showing cached repository statistics while shared GitHub quota recovers"
              : "showing cached repository statistics",
        ),
        env,
      ),
      200,
      summarized.headers,
    );
  }
  if (!allowRefresh) {
    return crawlerCacheOnlyResponse("cached repository statistics unavailable for crawler");
  }

  try {
    const credential = await repoDetailCredential(owner, repo, request, env);
    if (credential.quotaSource === "shared" && sharedCritical?.active) {
      return jsonResponse(
        {
          error: "GitHub shared API quota is reserved for essential requests until reset.",
          cache: {
            state: "error",
            stale: true,
            generatedAt: new Date().toISOString(),
            message: "Repository detail is cache-only while shared GitHub quota recovers.",
          },
        },
        429,
        {
          "cache-control": "no-store",
          ...(sharedCritical.resetAt
            ? {
                "retry-after": String(
                  Math.max(1, Math.ceil((Date.parse(sharedCritical.resetAt) - Date.now()) / 1000)),
                ),
              }
            : {}),
        },
      );
    }
    const payload = await buildRepoDetailSingleFlight(key, owner, repo, request, env, credential);
    if (!payload) {
      return jsonResponse(
        {
          cache: {
            state: "warming",
            stale: true,
            generatedAt: new Date().toISOString(),
            message: "Repository detail build is already in progress.",
          },
        },
        202,
        { "cache-control": "no-store", "retry-after": "2" },
      );
    }
    const summarized = await withReleaseSummary(payload);
    return jsonResponse(
      await withRepoDetailContributorTrustProfiles(summarized.payload, env),
      payload.cache.state === "warming" ? 202 : 200,
      summarized.headers ?? {
        "cache-control": payload.cache.state === "warming" ? "no-store" : "public, max-age=60",
      },
    );
  } catch (error) {
    return jsonResponse(
      {
        error: dashboardErrorMessage(error),
        cache: {
          state: "error",
          stale: true,
          generatedAt: new Date().toISOString(),
          message: dashboardErrorMessage(error),
        },
      },
      errorStatus(error),
      retryAfterHeaders(error),
    );
  }
}

export async function cachedRepoInitialData(
  env: Env,
  fullName: string,
): Promise<InitialPageData | null> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  if ((await repositoryPublicCacheBarrier(env, fullName)) !== "clear") return null;
  const cached = await readRepoDetail(env, repoDetailCacheKey(owner, repo));
  if (!cached || repoDetailAgeMs(cached) > maxDisplayStaleMs) return null;
  const payload =
    repoDetailAgeMs(cached) < repoDetailCacheTtlMs
      ? cached
      : withRepoDetailState(cached, "stale", "refreshing repository statistics");
  return { route: "repo", payload };
}
