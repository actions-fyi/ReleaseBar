import { expect, test } from "vitest";
import {
  primaryAuthActionFor,
  primaryAuthLabelFor,
  primaryAuthTitleFor,
} from "../../../src/auth-ui.js";
import type { AuthPayload } from "../../../src/types.js";

function authPayload(overrides: Partial<AuthPayload> = {}): AuthPayload {
  return {
    configured: true,
    quotaConfigured: true,
    user: null,
    installations: [],
    installNeeded: false,
    installReason: null,
    loginUrl: "https://release.bar/api/auth/login",
    logoutUrl: "https://release.bar/api/auth/logout",
    installUrl: "https://release.bar/api/auth/install",
    appUrl: "https://github.com/apps/releasebar-app",
    ...overrides,
  };
}

test("anonymous GitHub action logs in before offering App installation", () => {
  const auth = authPayload();
  expect(primaryAuthActionFor(auth, false)).toBe("login");
  expect(primaryAuthLabelFor(auth, false)).toBe("Log in with GitHub");
  expect(primaryAuthLabelFor(auth, false, true)).toBe("Log in");
  expect(primaryAuthTitleFor(auth, false)).toBe("Log in with GitHub");
});

test("App-only deployments keep installation as the available anonymous action", () => {
  const auth = authPayload({ configured: false });
  expect(primaryAuthActionFor(auth, false)).toBe("install");
  expect(primaryAuthLabelFor(auth, false)).toBe("Install GitHub App");
});

test("signed-in GitHub action only offers installation when coverage is missing", () => {
  const user = {
    id: 1,
    login: "octocat",
    name: null,
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
    url: "https://github.com/octocat",
  };
  const covered = authPayload({ user });
  expect(primaryAuthActionFor(covered, false)).toBe(null);
  expect(primaryAuthLabelFor(covered, false)).toBe("GitHub Connected");

  const uncovered = authPayload({ user, installNeeded: true });
  expect(primaryAuthActionFor(uncovered, false)).toBe("install");
  expect(primaryAuthLabelFor(uncovered, false)).toBe("Install GitHub App");
});
