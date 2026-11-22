import Anthropic from "@anthropic-ai/sdk";
import { slugOwner } from "../scripts/lib/dashboard.js";
import type {
  ApiQuota,
  Project,
  RepoDetailPayload,
  RepoDetailReleaseSummary,
} from "../src/types.js";
import { workerFetch } from "./http.js";
import type { Env } from "./runtime.js";
import {
  gitHubCheckRunsSchema,
  gitHubCommitSchema,
  gitHubCompareSchema,
  gitHubContributorSchema,
  gitHubReleaseSchema,
  gitHubRepositorySchema,
  tryJsonParse,
} from "./schemas.js";
import type { InferOutput } from "valibot";
import { cachedUserTrustSignals } from "./audience-data.js";
import { bestInstallationToken } from "./auth-tokens.js";
import {
  dashboardStorageTtlSeconds,
  releaseSummaryBodyChars,
  releaseSummaryCommitLimit,
  releaseSummaryInputChars,
  releaseSummaryTitleChars,
  releaseSummaryPromptVersion,
  type UserTrustSignal,
} from "./config.js";
import { isGitHubRateLimit } from "./dashboard-cache.js";
import { detailGitHubJson } from "./repo-github.js";

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
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailPayload>(raw, `repo detail ${key}`) : null;
}

export async function writeRepoDetail(
  env: Env,
  key: string,
  payload: RepoDetailPayload,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(payload), {
    expirationTtl: dashboardStorageTtlSeconds,
  });
}

export async function readReleaseSummary(
  env: Env,
  key: string | null,
): Promise<RepoDetailReleaseSummary | null> {
  if (!key) return null;
  const raw = await env.DASHBOARD_CACHE?.get(key);
  return raw ? tryJsonParse<RepoDetailReleaseSummary>(raw, `release summary ${key}`) : null;
}

export async function writeReleaseSummary(
  env: Env,
  key: string,
  summary: RepoDetailReleaseSummary,
): Promise<void> {
  await env.DASHBOARD_CACHE?.put(key, JSON.stringify(summary), {
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

// A commit message without its title and its closing block of trailers, such as Signed-off-by.
export function commitBody(message: string): string {
  const paragraphs = message
    .split("\n")
    .slice(1)
    .join("\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (last && last.split("\n").every((line) => /^[A-Za-z][\w-]*: \S/.test(line.trim()))) {
    paragraphs.pop();
  }
  return clipText(paragraphs.join("\n\n"), releaseSummaryBodyChars);
}

export type ReleaseDeltaCommit = { title: string; body: string };

export async function compareCommitMessages(
  path: string,
  releaseTag: string,
  head: string,
  token: string | null,
  quotaSource: ApiQuota["source"],
  quotaAccount: string | null,
  onQuota: (quota: ApiQuota) => void,
  env: Env,
): Promise<{ commits: ReleaseDeltaCommit[]; total: number | null }> {
  const commits: ReleaseDeltaCommit[] = [];
  let total: number | null = null;
  for (let page = 1; commits.length < releaseSummaryCommitLimit; page += 1) {
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
    const pageCommits = (compare.commits ?? [])
      .map((commit) => ({
        title: clipText(commitTitle(commit.commit.message), releaseSummaryTitleChars),
        body: commitBody(commit.commit.message),
      }))
      .filter((commit) => commit.title);
    commits.push(...pageCommits);
    if (pageCommits.length === 0 || (total !== null && commits.length >= total)) break;
  }
  return { commits: commits.slice(0, releaseSummaryCommitLimit), total };
}

// Builds the model's input within releaseSummaryInputChars: the titles of the newest commits,
// then the newest commits' bodies.
export function releaseDeltaInput(commits: ReleaseDeltaCommit[]): {
  text: string;
  commitsUsed: number;
} {
  const lineChars = (text: string) => text.length + 8;
  let first = commits.length;
  let titleChars = 0;
  while (first > 0) {
    const chars = lineChars(commits[first - 1]?.title ?? "");
    if (titleChars + chars > releaseSummaryInputChars / 2) break;
    titleChars += chars;
    first -= 1;
  }
  let bodyBudget = releaseSummaryInputChars - titleChars;
  const keepBody = new Set<number>();
  for (let index = commits.length - 1; index >= first; index -= 1) {
    const body = commits[index]?.body ?? "";
    // The indent adds three characters per line.
    const chars = body.length + 3 * (body.split("\n").length + 1);
    if (body && chars <= bodyBudget) {
      keepBody.add(index);
      bodyBudget -= chars;
    }
  }
  const commitLines = commits.slice(first).map((commit, offset) => {
    const index = first + offset;
    const body = keepBody.has(index)
      ? `\n${commit.body
          .split("\n")
          .map((line) => `   ${line}`)
          .join("\n")}`
      : "";
    return `${offset + 1}. ${commit.title}${body}`;
  });
  const text = [
    `Commits, oldest first${first > 0 ? ` (the ${first} oldest left out)` : ""}:`,
    commitLines.join("\n"),
  ].join("\n");
  return { text, commitsUsed: commits.length - first };
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
): Promise<string> {
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
  const { commits, total } = await compareCommitMessages(
    path,
    project.version,
    project.latestCommitSha,
    token,
    quotaSource,
    quotaAccount,
    onQuota,
    env,
  );
  if (commits.length === 0) {
    return unavailableReleaseSummary(project, model, "No commits were available to summarize.");
  }
  const input = releaseDeltaInput(commits);
  const text = await claudeSummaryText(env, {
    model,
    maxTokens: 450,
    system:
      "You summarize the public GitHub commits since a repository's latest release for release dashboards. You get each commit's title and, where it has one, its message body. Write 2-4 concise sentences, past tense, no bullets, no hype, no markdown. Lead with user-visible changes and broad themes; use the bodies to be specific, but do not list commits. Do not invent details beyond what the commits say.",
    user: [
      `Repository: ${project.fullName}`,
      `Latest release: ${project.version}`,
      `Default branch head: ${project.latestCommitSha}`,
      `Commits included: ${input.commitsUsed} of ${total ?? project.commitsSinceRelease ?? commits.length}`,
      "",
      input.text,
    ].join("\n"),
  });
  if (!text) throw new Error("Claude response did not include summary text");
  return {
    state: "ready",
    text,
    generatedAt: new Date().toISOString(),
    model,
    releaseTag: project.version,
    headSha: project.latestCommitSha,
    commitCount: total ?? project.commitsSinceRelease,
    commitsUsed: input.commitsUsed,
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
