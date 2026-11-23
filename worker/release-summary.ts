import Anthropic from "@anthropic-ai/sdk";
import { slugOwner } from "../shared/dashboard.ts";
import type {
  ApiQuota,
  Project,
  RepoDetailPayload,
  RepoDetailReleaseSummary,
} from "../src/types.ts";
import { workerFetch } from "./http.ts";
import {
  gitHubCheckRunsSchema,
  gitHubCommitSchema,
  gitHubCompareSchema,
  gitHubContributorSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
  tryJsonParse,
} from "./schemas.ts";
import type { InferOutput } from "valibot";
import { cachedUserTrustSignals } from "./audience-data.ts";
import { bestInstallationToken } from "./auth-tokens.ts";
import {
  dashboardStorageTtlSeconds,
  releaseSummaryCommitLimit,
  releaseSummaryPromptVersion,
  summaryRetryBaseMs,
  summaryRetryMaxMs,
  summaryRetryMultiplier,
  type UserTrustSignal,
} from "./config.ts";
import { errorMessage, isGitHubRateLimit } from "./dashboard-cache.ts";
import { detailGitHubJson } from "./repo-github.ts";
import { releaseSummaryLimits } from "./summary-limits.ts";
import type { SummaryReservation } from "./summary-quota.ts";

export function repoDetailCacheKey(owner: string, repo: string): string {
  return `repo-detail:v4:${slugOwner(owner)}/${repo.toLowerCase()}`;
}

export function releaseSummaryModel(env: Env): string {
  return env.ANTHROPIC_SUMMARY_MODEL || "claude-haiku-5-5";
}

export function releaseSummaryCacheKey(project: Project, model: string): string | null {
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return null;
  }
  return [
    `release-summary:v${releaseSummaryPromptVersion}`,
    project.fullName.toLowerCase(),
    encodeURIComponent(project.version),
    project.latestCommitSha,
    encodeURIComponent(model),
  ].join(":");
}

export async function readRepoDetail(env: Env, key: string): Promise<RepoDetailPayload | null> {
  const raw = await env.DASHBOARD_CACHE.get(key);
  return raw ? tryJsonParse<RepoDetailPayload>(raw, `repo detail ${key}`) : null;
}

export async function writeRepoDetail(
  env: Env,
  key: string,
  payload: RepoDetailPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function readReleaseSummary(
  env: Env,
  key: string | null,
): Promise<RepoDetailReleaseSummary | null> {
  if (!key) return null;
  const raw = await env.DASHBOARD_CACHE.get(key);
  return raw ? tryJsonParse<RepoDetailReleaseSummary>(raw, `release summary ${key}`) : null;
}

export async function writeReleaseSummary(
  env: Env,
  key: string,
  summary: RepoDetailReleaseSummary,
): Promise<void> {
  await env.DASHBOARD_CACHE.put(key, JSON.stringify(summary), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export function repoDetailAgeMs(payload: RepoDetailPayload | null): number {
  if (!payload) return Number.POSITIVE_INFINITY;
  const generatedAt = Date.parse(payload.generatedAt);
  return Number.isFinite(generatedAt) ? Date.now() - generatedAt : Number.POSITIVE_INFINITY;
}

export function withRepoDetailState(
  payload: RepoDetailPayload,
  state: RepoDetailPayload["cache"]["state"],
  message = payload.cache.message,
): RepoDetailPayload {
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

export async function optionalRepoDetail<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isGitHubRateLimit(error)) throw error;
    return fallback;
  }
}

export function unavailableReleaseSummary(
  project: Project,
  model: string | null,
  message: string,
): RepoDetailReleaseSummary {
  return {
    state: "unavailable",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.releaseDate ? project.version : null,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message,
  };
}

export const summaryFailedMessage = "AI summary failed; retrying later.";

type SummaryFailureFields = { state: string; failedAt?: string; failures?: number };

// Logs why a summary failed and returns the fields the failed summary stores. The stored message
// is generic: summaries are public payloads, and the error can carry provider responses.
export function summaryFailure(
  kind: "owner-activity" | "repo-activity" | "release",
  target: string,
  previous: SummaryFailureFields | undefined,
  error: unknown,
): { message: string; failedAt: string; failures: number } {
  const failures = (previous?.failedAt ? (previous.failures ?? 1) : 0) + 1;
  console.error(
    JSON.stringify({
      area: "ai-summary",
      event: "summary_failed",
      kind,
      target,
      failures,
      error: errorMessage(error),
    }),
  );
  return { message: summaryFailedMessage, failedAt: new Date().toISOString(), failures };
}

// Whether a failed summary has waited out its backoff and should be requested again.
export function summaryRetryDue(
  summary: SummaryFailureFields | null | undefined,
  now = Date.now(),
): boolean {
  if (summary?.state !== "unavailable" || !summary.failedAt) return false;
  const failedAt = Date.parse(summary.failedAt);
  if (!Number.isFinite(failedAt)) return true;
  const delay = Math.min(
    summaryRetryBaseMs * summaryRetryMultiplier ** Math.max(0, (summary.failures ?? 1) - 1),
    summaryRetryMaxMs,
  );
  return now - failedAt >= delay;
}

export async function releaseSummaryState(
  project: Project,
  env: Env,
): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!project.releaseDate || project.version === "unreleased") {
    return unavailableReleaseSummary(project, model, "No prior release to summarize.");
  }
  if (!project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "Latest commit is unavailable.");
  }
  if (project.commitsSinceRelease === null) {
    return unavailableReleaseSummary(project, model, "Commit comparison is unavailable.");
  }
  if (project.commitsSinceRelease === 0) {
    return {
      state: "ready",
      text: "No commits have landed since the latest release.",
      generatedAt: new Date().toISOString(),
      model,
      releaseTag: project.version,
      headSha: project.latestCommitSha,
      commitCount: 0,
      commitsUsed: 0,
    };
  }
  const key = releaseSummaryCacheKey(project, model);
  const cached = await readReleaseSummary(env, key);
  if (cached?.state === "ready") return cached;
  if (!env.ANTHROPIC_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  return {
    state: "warming",
    text: null,
    generatedAt: null,
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: project.commitsSinceRelease,
    commitsUsed: 0,
    message: "Summarizing commits since the latest release.",
  };
}

export function commitTitle(message: string): string {
  return message.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
}

// Cuts text to at most maxChars UTF-16 units plus an ellipsis, never inside a surrogate pair.
export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const code = text.charCodeAt(maxChars - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars;
  return `${text.slice(0, end).trimEnd()}…`;
}

// The numbered title list the model reads, within inputChars, header included. Titles arrive
// oldest first; the newest ones are kept when they don't all fit.
export function releaseTitlesInput(
  titles: string[],
  inputChars: number,
): { text: string; titlesUsed: number } {
  const header = (left: number) =>
    `Commit titles, oldest first${left > 0 ? ` (the ${left} oldest left out)` : ""}:`;
  // The longest the header can get, so that adding it never breaks the cap.
  let budget = inputChars - header(titles.length).length;
  let first = titles.length;
  while (first > 0) {
    // "\n" plus a number of up to three digits, ". " and the title.
    const chars = 6 + (titles[first - 1]?.length ?? 0);
    if (chars > budget) break;
    budget -= chars;
    first -= 1;
  }
  const lines = titles.slice(first).map((title, index) => `${index + 1}. ${title}`);
  return { text: [header(first), ...lines].join("\n"), titlesUsed: titles.length - first };
}

export async function compareCommitTitles(
  path: string,
  releaseTag: string,
  head: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<{ titles: string[]; total: number | null }> {
  const { titleChars } = releaseSummaryLimits(env);
  const titles: string[] = [];
  let total: number | null = null;
  for (let page = 1; titles.length < releaseSummaryCommitLimit; page += 1) {
    const compare = await detailGitHubJson(
      `${path}/compare/${encodeURIComponent(releaseTag)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
      gitHubCompareSchema,
      "release summary compare",
      token,
      quotaSource,
      quotaAccount,
      onQuota,
      "release-summary",
      undefined,
      env,
    );
    total = compare.total_commits ?? total;
    const pageTitles = (compare.commits ?? [])
      .map((commit) => clipText(commitTitle(commit.commit.message), titleChars))
      .filter(Boolean);
    titles.push(...pageTitles);
    if (pageTitles.length === 0 || (total !== null && titles.length >= total)) break;
  }
  return { titles: titles.slice(0, releaseSummaryCommitLimit), total };
}

// Thinking is always on for current Claude models and counts against max_tokens.
const summaryThinkingHeadroomTokens = 2_000;

export async function claudeSummaryText(
  env: Env,
  request: {
    model: string;
    maxTokens: number;
    system: string;
    user: string;
    schema?: Record<string, unknown>;
  },
  reserve: SummaryReservation,
): Promise<string> {
  // Every model call is counted first, so none can go around the limits.
  await reserve();
  // ANTHROPIC_BASE_URL points the client at another Messages API endpoint, such as a gateway.
  const baseURL = env.ANTHROPIC_BASE_URL?.trim();
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    fetch: workerFetch,
    ...(baseURL ? { baseURL } : {}),
  });
  const response = await client.messages.create({
    model: request.model,
    max_tokens: request.maxTokens + summaryThinkingHeadroomTokens,
    system: request.system,
    output_config: {
      effort: "low",
      ...(request.schema ? { format: { type: "json_schema", schema: request.schema } } : {}),
    },
    messages: [{ role: "user", content: request.user }],
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    throw new Error(`Claude summary stopped early: ${response.stop_reason}`);
  }
  return response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function summarizeReleaseDelta(
  project: Project,
  path: string,
  request: Request,
  env: Env,
  reserve: SummaryReservation,
): Promise<RepoDetailReleaseSummary> {
  const model = releaseSummaryModel(env);
  if (!env.ANTHROPIC_API_KEY) {
    return unavailableReleaseSummary(project, model, "AI release summaries are not configured.");
  }
  if (!project.releaseDate || project.version === "unreleased" || !project.latestCommitSha) {
    return unavailableReleaseSummary(project, model, "No comparable release delta is available.");
  }
  const requestToken = await bestInstallationToken(request, env, {
    owners: [],
    repos: [project.fullName],
  }).catch(() => null);
  const token = requestToken?.token ?? env.GITHUB_TOKEN ?? null;
  const quotaSource = requestToken?.quotaSource ?? (env.GITHUB_TOKEN ? "shared" : "anonymous");
  const quotaAccount = requestToken?.quotaAccount ?? null;
  const onQuota = () => undefined;
  const { titles, total } = await compareCommitTitles(
    path,
    project.version,
    project.latestCommitSha,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  if (titles.length === 0) {
    return unavailableReleaseSummary(
      project,
      model,
      "No commit titles were available to summarize.",
    );
  }
  const input = releaseTitlesInput(titles, releaseSummaryLimits(env).inputChars);
  const text = await claudeSummaryText(
    env,
    {
      model,
      maxTokens: 450,
      system:
        "You summarize public GitHub commit titles for release dashboards. Write 2-4 concise sentences, past tense, no bullets, no hype, no markdown. Mention broad themes and user-visible changes when commit titles support them. Do not invent details beyond the commit titles.",
      user: [
        `Repository: ${project.fullName}`,
        `Latest release: ${project.version}`,
        `Default branch head: ${project.latestCommitSha}`,
        `Commit titles included: ${input.titlesUsed} of ${total ?? project.commitsSinceRelease ?? titles.length}`,
        "",
        input.text,
      ].join("\n"),
    },
    reserve,
  );
  if (!text) throw new Error("Claude response did not include summary text");
  return {
    state: "ready",
    text,
    generatedAt: new Date().toISOString(),
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: total ?? project.commitsSinceRelease,
    commitsUsed: input.titlesUsed,
  };
}

export type ContributorTrustSignal = UserTrustSignal;

export async function cachedContributorTrustSignals(
  env: Env,
  contributors: Array<InferOutput<typeof gitHubContributorSchema>>,
): Promise<Map<string, ContributorTrustSignal>> {
  const logins = Array.from(
    new Set(
      contributors
        .map((contributor) => contributor.login)
        .filter((login): login is string => Boolean(login))
        .map(slugOwner),
    ),
  );
  return cachedUserTrustSignals(env, logins);
}

export type RepoDetailCredential = {
  token: string | null;
  quotaSource: ApiQuota["source"];
  quotaAccount: string | null;
};

export type RepoDetailCore = {
  repo: InferOutput<typeof gitHubRepositorySchema>;
  releases: Array<InferOutput<typeof gitHubReleaseSchema>>;
  latestCommit: InferOutput<typeof gitHubCommitSchema> | null;
  openPullRequests: number;
  checks: InferOutput<typeof gitHubCheckRunsSchema> | null;
};
