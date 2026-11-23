import { expect, test } from "vitest";
import { buildDashboard } from "../shared/dashboard.ts";
import { buildCommands } from "../src/app-commands.ts";
import type { AuthInstallation, AuthPayload } from "../src/types.ts";
import { userDashboardDetail, userDashboards } from "../src/user-dashboards.ts";

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
  expect(userDashboards(null)).toStrictEqual([]);
  expect(
    userDashboards({ ...signedInAuth([installation("acme", "org")]), user: null }),
  ).toStrictEqual([]);
});

test("a signed-in user without organizations has only their own dashboard", () => {
  expect(userDashboards(signedInAuth())).toStrictEqual([
    {
      login: "octocat",
      kind: "user",
      path: "/octocat",
      avatarUrl: "https://avatars.example/octocat",
      repositorySelection: null,
      repositories: [],
    },
  ]);
  expect(
    userDashboards(signedInAuth([installation("octocat", "user")])).map((entry) => [
      entry.login,
      entry.repositorySelection,
    ]),
  ).toStrictEqual([["octocat", "all"]]);
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
  expect(dashboards.map((entry) => [entry.login, entry.kind, entry.path])).toStrictEqual([
    ["octocat", "user", "/octocat"],
    ["acme", "org", "/acme"],
    ["zeta-org", "org", "/zeta-org"],
  ]);
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
  expect(user?.repositories).toStrictEqual([]);
  expect(org?.path).toBe("/acme");
  expect(org?.repositorySelection).toBe("selected");
  expect(org?.repositories).toStrictEqual(["acme/api", "acme/widgets"]);
  expect(userDashboardDetail(org!)).toBe("organization · 2 selected repositories");
  expect(userDashboardDetail(user!)).toBe("personal");
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

  expect(commands({ ...signedInAuth([installation("acme", "org")]), user: null })).toStrictEqual(
    [],
  );
  const listed = commands(signedInAuth([installation("acme", "org")]));
  expect(
    listed.map((command) => [command.actionId, command.title, command.subTitle]),
  ).toStrictEqual([
    ["account:dashboard", "Open my dashboard", "@octocat"],
    ["account:dashboard:acme", "Open @acme dashboard", "organization"],
  ]);
  for (const command of listed) command.onRun?.(undefined);
  expect(opened).toStrictEqual(["octocat", "acme"]);
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
  expect(await builtRepos({ type: "user", login: "Octocat" })).toStrictEqual(["octocat/dotfiles"]);
  expect(await builtRepos({ type: "org", login: "acme" })).toStrictEqual(["acme/widgets"]);
});

test("a dashboard still shows another account's repository it deliberately lists", async () => {
  expect(await builtRepos({ type: "user", login: "octocat" }, ["acme/widgets"])).toStrictEqual([
    "acme/widgets",
    "octocat/dotfiles",
  ]);
});
