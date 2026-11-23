import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../dashboard.js";
import { buildCommands } from "../../../src/app-commands.js";
import type { AuthInstallation, AuthPayload } from "../../../src/types.js";
import { userDashboardDetail, userDashboards } from "../../../src/user-dashboards.js";

function installation(
  accountLogin: string,
  accountType: AuthInstallation["accountType"],
  overrides: Partial<AuthInstallation> = {},
): AuthInstallation {
  return {
    id: accountLogin.length,
    accountLogin,
    accountType,
    accountUrl: `https://github.com/${accountLogin}`,
    avatarUrl: `https://avatars.example/${accountLogin}`,
    repositorySelection: "all",
    repositories: [],
    ...overrides,
  };
}

function signedInAuth(installations: AuthInstallation[] = []): AuthPayload {
  return {
    configured: true,
    quotaConfigured: true,
    user: {
      id: 1,
      login: "Octocat",
      name: null,
      avatarUrl: "https://avatars.example/octocat",
      url: "https://github.com/octocat",
    },
    installations,
    installNeeded: false,
    installReason: null,
    loginUrl: "/api/auth/login",
    logoutUrl: "/api/auth/logout",
    installUrl: "/api/auth/install",
    appUrl: "https://github.com/apps/releasebar-app",
  };
}

test("anonymous visitors have no dashboards list", () => {
  assert.deepEqual(userDashboards(null), []);
  assert.deepEqual(
    userDashboards({ ...signedInAuth([installation("acme", "org")]), user: null }),
    [],
  );
});

test("a signed-in user without organizations has only their own dashboard", () => {
  assert.deepEqual(userDashboards(signedInAuth()), [
    {
      login: "octocat",
      kind: "user",
      path: "/octocat",
      avatarUrl: "https://avatars.example/octocat",
      repositorySelection: null,
      repositories: [],
    },
  ]);
  assert.deepEqual(
    userDashboards(signedInAuth([installation("octocat", "user")])).map((entry) => [
      entry.login,
      entry.repositorySelection,
    ]),
    [["octocat", "all"]],
  );
});

test("the user's dashboard comes first, then one per installed organization", () => {
  const dashboards = userDashboards(
    signedInAuth([
      installation("Zeta-Org", "org"),
      installation("octocat", "user"),
      installation("acme", "org"),
      installation("ACME", "org"),
      installation("someone-else", "user"),
    ]),
  );
  assert.deepEqual(
    dashboards.map((entry) => [entry.login, entry.kind, entry.path]),
    [
      ["octocat", "user", "/octocat"],
      ["acme", "org", "/acme"],
      ["zeta-org", "org", "/zeta-org"],
    ],
  );
});

test("an organization installed on selected repositories keeps only its own repositories", () => {
  const [user, org] = userDashboards(
    signedInAuth([
      installation("acme", "org", {
        repositorySelection: "selected",
        repositories: ["acme/widgets", "Acme/API", "octocat/dotfiles"],
      }),
    ]),
  );
  assert.deepEqual(user?.repositories, []);
  assert.equal(org?.path, "/acme");
  assert.equal(org?.repositorySelection, "selected");
  assert.deepEqual(org?.repositories, ["acme/api", "acme/widgets"]);
  assert.equal(userDashboardDetail(org!), "organization · 2 selected repositories");
  assert.equal(userDashboardDetail(user!), "personal");
});

test("the command palette lists the signed-in user's dashboards", () => {
  const opened: string[] = [];
  const noop = (): void => {};
  const commands = (auth: AuthPayload | null) =>
    buildCommands(
      {
        projects: [],
        owners: [],
        languages: [],
        language: "",
        typedText: "",
        hiddenOwners: new Set(),
        hiddenRepos: new Set(),
        auth,
        devMode: false,
        sortKey: "freshness",
        sortDirection: "desc",
        filter: "all",
        settingsSummary: "",
        adminRoute: false,
        discoverPeriods: [],
      } as unknown as Parameters<typeof buildCommands>[0],
      new Proxy(
        { openOwner: (owner: string) => opened.push(owner) },
        { get: (target, key) => (key === "openOwner" ? target.openOwner : noop) },
      ) as unknown as Parameters<typeof buildCommands>[1],
    ).filter((command) => String(command.actionId).startsWith("account:dashboard"));

  assert.deepEqual(commands({ ...signedInAuth([installation("acme", "org")]), user: null }), []);
  const listed = commands(signedInAuth([installation("acme", "org")]));
  assert.deepEqual(
    listed.map((command) => [command.actionId, command.title, command.subTitle]),
    [
      ["account:dashboard", "Open my dashboard", "@octocat"],
      ["account:dashboard:acme", "Open @acme dashboard", "organization"],
    ],
  );
  for (const command of listed) command.onRun?.(undefined);
  assert.deepEqual(opened, ["octocat", "acme"]);
});

function listedRepo(owner: string, name: string): Record<string, unknown> {
  return {
    owner: { login: owner },
    name,
    full_name: `${owner}/${name}`,
    description: null,
    html_url: `https://github.com/${owner}/${name}`,
    default_branch: "main",
    language: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    archived: false,
    pushed_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    fork: false,
    private: false,
  };
}

async function builtRepos(
  owner: { type: "user" | "org"; login: string },
  includeRepos: string[] = [],
): Promise<string[]> {
  const listing = [listedRepo("octocat", "dotfiles"), listedRepo("acme", "widgets")];
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname.toLowerCase();
    if (path === "/users/octocat/repos" || path === "/orgs/acme/repos") {
      return Response.json(listing);
    }
    const repo = listing.find((entry) => path === `/repos/${String(entry.full_name)}`);
    if (repo) return Response.json(repo);
    if (path.endsWith("/releases")) return Response.json([]);
    return new Response("not found", { status: 404 });
  };
  const payload = await buildDashboard({
    title: "ReleaseBar",
    subtitle: "test",
    canonicalDomain: "example.com",
    owners: [owner],
    includeRepos,
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    fetch: fetcher,
  });
  return payload.projects.map((project) => project.fullName.toLowerCase()).sort();
}

test("user and organization dashboards only list their own account's repositories", async () => {
  assert.deepEqual(await builtRepos({ type: "user", login: "Octocat" }), ["octocat/dotfiles"]);
  assert.deepEqual(await builtRepos({ type: "org", login: "acme" }), ["acme/widgets"]);
});

test("a dashboard still shows another account's repository it deliberately lists", async () => {
  assert.deepEqual(await builtRepos({ type: "user", login: "octocat" }, ["acme/widgets"]), [
    "acme/widgets",
    "octocat/dotfiles",
  ]);
});
