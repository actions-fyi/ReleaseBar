import { ownerDashboardPath } from "./routing.ts";
import type { AuthInstallation, AuthPayload } from "./types.ts";

export type UserDashboard = {
  login: string;
  kind: AuthInstallation["accountType"];
  path: string;
  avatarUrl: string;
  // Null when the GitHub App is not installed on the account.
  repositorySelection: AuthInstallation["repositorySelection"] | null;
  // The installation's selected repositories that belong to this account.
  repositories: string[];
};

// The one source of "the dashboards this user has": their own first (the default), then one per
// organization the GitHub App is installed on. Anonymous visitors have none.
export function userDashboards(auth: AuthPayload | null): UserDashboard[] {
  const user = auth?.user;
  if (!user) return [];
  const userLogin = user.login.toLowerCase();
  const installations = new Map<string, AuthInstallation>();
  for (const installation of auth.installations) {
    const login = installation.accountLogin.toLowerCase();
    if (!installations.has(login)) installations.set(login, installation);
  }
  const dashboard = (
    login: string,
    kind: UserDashboard["kind"],
    avatarUrl: string,
  ): UserDashboard => {
    const installation = installations.get(login);
    return {
      login,
      kind,
      path: ownerDashboardPath(login),
      avatarUrl,
      repositorySelection: installation?.repositorySelection ?? null,
      repositories: (installation?.repositories ?? [])
        .map((repo) => repo.toLowerCase())
        .filter((repo) => repo.startsWith(`${login}/`))
        .sort((left, right) => left.localeCompare(right)),
    };
  };
  return [
    dashboard(userLogin, "user", user.avatarUrl),
    ...[...installations.values()]
      .filter(
        (installation) =>
          installation.accountType === "org" &&
          installation.accountLogin.toLowerCase() !== userLogin,
      )
      .map((installation) =>
        dashboard(installation.accountLogin.toLowerCase(), "org", installation.avatarUrl),
      )
      .sort((left, right) => left.login.localeCompare(right.login)),
  ];
}

export function userDashboardDetail(dashboard: UserDashboard): string {
  const account = dashboard.kind === "org" ? "organization" : "personal";
  if (dashboard.repositorySelection !== "selected") return account;
  const count = dashboard.repositories.length;
  return `${account} · ${count} selected ${count === 1 ? "repository" : "repositories"}`;
}
