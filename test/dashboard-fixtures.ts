// Dashboard data for tests. Imports nothing of the Workers runtime, so the tests of the `node`
// project can use it; the others get it through dashboard-test-harness.ts.
import type { DashboardPayload, Project } from "../src/types.ts";

export function testProject(
  overrides: Partial<Project> & Pick<Project, "owner" | "name">,
): Project {
  const { owner, name, ...rest } = overrides;
  const fullName = `${owner}/${name}`;
  return {
    owner,
    name,
    fullName,
    description: null,
    url: `https://github.com/${fullName}`,
    defaultBranch: "main",
    language: null,
    topics: [],
    stars: 1,
    forks: 0,
    openIssues: 0,
    openPullRequests: 0,
    issuesUrl: `https://github.com/${fullName}/issues`,
    pullRequestsUrl: `https://github.com/${fullName}/pulls`,
    archived: false,
    pushedAt: "2026-05-15T00:00:00Z",
    updatedAt: "2026-05-15T00:00:00Z",
    latestCommitSha: "abcdef1",
    latestCommitDate: "2026-05-15T00:00:00Z",
    version: "v1.0.0",
    releaseName: null,
    releaseUrl: `https://github.com/${fullName}/releases/tag/v1.0.0`,
    releaseDate: "2026-05-01T00:00:00Z",
    commitsSinceRelease: 0,
    compareUrl: `https://github.com/${fullName}/compare/v1.0.0...main`,
    ciState: "success",
    ciStatus: null,
    ciConclusion: null,
    ciWorkflow: null,
    ciUrl: null,
    ciRunDate: null,
    freshness: "fresh",
    ...rest,
  };
}

export function testDashboard(owner: string, projects: Project[]): DashboardPayload {
  return {
    title: "ReleaseBar",
    subtitle: `Release freshness for @${owner}.`,
    canonicalDomain: "release.bar",
    generatedAt: "2026-05-15T12:00:00Z",
    owners: [{ type: "user", login: owner }],
    options: {
      includeForks: false,
      includeArchived: false,
      includeUnreleased: false,
      repoLimit: 200,
    },
    cache: {
      state: "fresh",
      stale: false,
      capped: false,
      repoLimit: 200,
      generatedAt: "2026-05-15T12:00:00Z",
    },
    totals: {
      repos: projects.length,
      released: projects.filter((project) => project.releaseDate).length,
      unreleased: projects.filter((project) => !project.releaseDate).length,
      commitsSinceRelease: projects.reduce(
        (sum, project) => sum + (project.commitsSinceRelease ?? 0),
        0,
      ),
    },
    projects,
  };
}
