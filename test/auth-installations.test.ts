import { generateKeyPairSync } from "node:crypto";
import { assert, expect, test } from "vitest";
import { dashboardCacheKey } from "../shared/dashboard.ts";
import type { RefreshJob } from "../src/types.ts";
import {
  authFunnelEventCount,
  kvStore,
  signedJson,
  storedRefreshJobSnapshot,
  testDashboard,
  testEnv,
  worker,
  seedProfile,
  storedInstallationJson,
} from "./dashboard-test-harness.ts";

test("worker rejects oversized custom source requests", async () => {
  const owners = Array.from({ length: 9 }, (_, index) => `owner-${index}`).join(",");
  const response = await worker.fetch(
    new Request(`https://release.bar/api/dashboard?owners=${owners}`),
    {},
    { waitUntil: () => undefined },
  );

  expect(response.status).toBe(400);
  expect(await response.text()).toMatch(/too many custom sources/);
});

test("worker exposes GitHub App auth endpoints", async () => {
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const context = { waitUntil: () => undefined };

  const anonymous = await worker.fetch(new Request("https://release.bar/api/me"), env, context);
  expect(anonymous.status).toBe(200);
  expect(await anonymous.json()).toStrictEqual({
    configured: true,
    quotaConfigured: false,
    user: null,
    admin: false,
    installations: [],
    installNeeded: false,
    installReason: null,
    loginUrl: "https://release.bar/api/auth/login",
    logoutUrl: "https://release.bar/api/auth/logout",
    installUrl: "https://release.bar/api/auth/install",
    appUrl: "https://github.com/apps/releasebar-app",
  });

  const login = await worker.fetch(
    new Request("https://release.bar/api/auth/login?returnTo=/openclaw?owners=steipete"),
    env,
    context,
  );
  expect(login.status).toBe(302);
  const location = login.headers.get("location") ?? "";
  expect(location.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
  expect(location).toMatch(/client_id=Iv123/);
  expect(location).toMatch(/redirect_uri=https%3A%2F%2Frelease.bar%2Fapi%2Fauth%2Fcallback/);
  expect(new URL(location).searchParams.has("scope")).toBe(false);
  expect(login.headers.get("set-cookie") ?? "").toMatch(/rd_oauth_state_[^=]+=.+HttpOnly/);

  const badCallback = await worker.fetch(
    new Request("https://release.bar/api/auth/callback?code=x&state=bad"),
    env,
    context,
  );
  expect(badCallback.status).toBe(400);
  expect(await authFunnelEventCount()).toBe(0);

  const install = await worker.fetch(
    new Request("https://release.bar/api/auth/install?returnTo=/openclaw"),
    env,
    context,
  );
  expect(install.status).toBe(302);
  expect(install.headers.get("location")).toBe(
    "https://github.com/apps/releasebar-app/installations/new",
  );
});

test("worker binds OAuth callbacks to the initiating browser", async () => {
  const returnTo = "/openclaw?owners=steipete";
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore(),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const context = { waitUntil: () => undefined };
  const login = await worker.fetch(
    new Request(`https://release.bar/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    env,
    context,
  );
  const location = new URL(login.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(stateCookie.length < 256).toBe(true);

  const longLogin = await worker.fetch(
    new Request(
      `https://release.bar/api/auth/login?returnTo=${encodeURIComponent(`/openclaw?filter=${"x".repeat(5000)}`)}`,
    ),
    env,
    context,
  );
  const longState =
    new URL(longLogin.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const longStatePayload = JSON.parse(
    Buffer.from(longState.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as { returnTo: string };
  expect(longState.length < 2048).toBe(true);
  expect(longStatePayload.returnTo).toBe("/");

  let oauthExchanges = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      oauthExchanges += 1;
      return Response.json({ access_token: "user-token", token_type: "bearer", scope: "" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: 1,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/1",
        html_url: "https://github.com/octocat",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const callbackUrl = `https://release.bar/api/auth/callback?code=code&state=${encodeURIComponent(state)}`;
    const unbound = await worker.fetch(new Request(callbackUrl), env, context);
    expect(unbound.status).toBe(400);
    expect(oauthExchanges).toBe(0);

    const callback = await worker.fetch(
      new Request(callbackUrl, { headers: { cookie: stateCookie } }),
      env,
      context,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(returnTo);
    expect(callback.headers.get("set-cookie") ?? "").toMatch(/rd_session=/);
    expect(callback.headers.get("set-cookie") ?? "").toMatch(/rd_oauth_state_[^=]+=;.*Max-Age=0/);
    expect(oauthExchanges).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker queues shared cache warming after login discovers an installation", async () => {
  const profile = {
    owner: "openclaw",
    includeOwners: [],
    includeRepos: ["outside/releasebar"],
    hiddenOwners: [],
    hiddenRepos: [],
    updatedAt: "2026-06-15T09:00:00.000Z",
    updatedBy: "openclaw",
  };
  const cacheKey = dashboardCacheKey({
    owner: "openclaw",
    owners: [],
    repos: ["outside/releasebar"],
    salt: profile.updatedAt,
    includeForks: false,
    includeArchived: false,
    includeUnreleased: true,
    includeReleaseData: false,
    schemaVersion: 6,
  });
  const staleDashboard = testDashboard("openclaw", []);
  const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  staleDashboard.generatedAt = staleAt;
  assert.ok(staleDashboard.cache);
  staleDashboard.cache.generatedAt = staleAt;
  await seedProfile(JSON.stringify(profile));
  const cache = kvStore({
    [cacheKey]: JSON.stringify(staleDashboard),
  });
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const context = { waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
  const login = await worker.fetch(
    new Request("https://release.bar/api/auth/login?returnTo=/openclaw"),
    env,
    context,
  );
  const location = new URL(login.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      return Response.json({ access_token: "user-token", token_type: "bearer", scope: "" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: 2,
        login: "openclaw",
        name: "OpenClaw",
        avatar_url: "https://avatars.githubusercontent.com/u/2",
        html_url: "https://github.com/openclaw",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 77,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/77",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const callback = await worker.fetch(
      new Request(
        `https://release.bar/api/auth/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: stateCookie } },
      ),
      env,
      context,
    );
    await Promise.all(waits);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/openclaw");
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("installation-warm");
    expect(sentJobs[0]?.targetKey ?? "").toMatch(/openclaw/);
    const snapshot = ((await storedRefreshJobSnapshot(sentJobs[0]?.targetSnapshotKey)) ??
      {}) as RefreshJob;
    expect(snapshot.target?.owners).toStrictEqual(["openclaw"]);
    expect(snapshot.target?.repos).toStrictEqual(["outside/releasebar"]);
    expect(snapshot.target?.includeReleaseData).toBe(false);
    expect(snapshot.target?.profileSnapshotKey).toBe(
      `profile-snapshot:openclaw:${encodeURIComponent(profile.updatedAt)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker remembers GitHub App installs without OAuth session", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const installReturn = await signedJson("test-secret", {
    returnTo: "/openclaw",
    iat: Math.floor(Date.now() / 1000),
    nonce: "install-nonce",
  });
  const cache = kvStore();
  const sentJobs: RefreshJob[] = [];
  const waits: Promise<unknown>[] = [];
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
    REFRESH_QUEUE: {
      async send(job: RefreshJob) {
        sentJobs.push(job);
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/77") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 77,
        account: {
          login: "openclaw",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/2",
          html_url: "https://github.com/openclaw",
        },
        html_url: "https://github.com/organizations/openclaw/settings/installations/77",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const install = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=77&setup_action=install", {
        headers: { cookie: `rd_install_return=${installReturn}` },
      }),
      env,
      { waitUntil: (promise) => waits.push(promise) },
    );
    await Promise.all(waits);
    expect(install.status).toBe(302);
    expect(install.headers.get("location")).toBe("/openclaw");
    const remembered = JSON.parse((await storedInstallationJson("openclaw")) ?? "{}");
    expect(remembered.id).toBe(77);
    expect(remembered.accountLogin).toBe("openclaw");
    expect(remembered.repositorySelection).toBe("all");
    expect(sentJobs.length).toBe(1);
    expect(sentJobs[0]?.reason).toBe("installation-warm");
    expect(sentJobs[0]?.targetKey ?? "").toMatch(/openclaw/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker reports GitHub App installation coverage for signed-in users", async () => {
  const sessionId = "session-1";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "octocat",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/octocat",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.user.login).toBe("octocat");
    expect(body.installNeeded).toBe(false);
    expect(body.installReason).toBe(null);
    expect(body.quotaConfigured).toBe(true);
    expect(body.installations[0].accountLogin).toBe("openclaw");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker detects the signed-in user's GitHub App install with app auth fallback", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-app-fallback";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json([
        {
          id: 99,
          account: {
            login: "steipete",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1",
            html_url: "https://github.com/steipete",
          },
          html_url: "https://github.com/settings/installations/99",
          repository_selection: "all",
          target_type: "User",
        },
        {
          id: 100,
          account: {
            login: "someone-else",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/2",
            html_url: "https://github.com/someone-else",
          },
          html_url: "https://github.com/settings/installations/100",
          repository_selection: "all",
          target_type: "User",
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.installNeeded).toBe(false);
    expect(body.installReason).toBe(null);
    expect(
      body.installations.map((installation: { accountLogin: string }) => installation.accountLogin),
    ).toStrictEqual(["steipete"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker does not prompt signed-in users to install the app for third-party repos", async () => {
  const sessionId = "session-third-party";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/-/f/prompts.chat", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.installNeeded).toBe(false);
    expect(body.installReason).toMatch(/shared API quota unless f\/prompts\.chat installs/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker still prompts signed-in users to install the app for owner dashboards", async () => {
  const sessionId = "session-owner-install";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: kvStore({
      [`auth:session:${sessionId}`]: JSON.stringify({
        user: {
          id: 1,
          login: "steipete",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          url: "https://github.com/steipete",
        },
        accessToken: "user-token",
        iat: exp - 600,
        exp,
      }),
    }),
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/installations") {
      return Response.json({ installations: [] });
    }
    if (url.pathname === "/app/installations") {
      return Response.json([]);
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/openclaw", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.installNeeded).toBe(true);
    expect(body.installReason).toMatch(/Install the GitHub App for @openclaw/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker remembers a just-completed GitHub App install while GitHub catches up", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const sessionId = "session-install-return";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const installReturn = await signedJson("test-secret", {
    returnTo: "/steipete",
    iat: Math.floor(Date.now() / 1000),
    nonce: "install-nonce",
  });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_CLIENT_ID: "Iv123",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/user/installations") {
      return Response.json({
        installations: [
          {
            id: 1,
            account: {
              login: "openclaw",
              type: "Organization",
              avatar_url: "https://avatars.githubusercontent.com/u/2",
              html_url: "https://github.com/openclaw",
            },
            html_url: "https://github.com/organizations/openclaw/settings/installations/1",
            repository_selection: "all",
            target_type: "Organization",
          },
        ],
      });
    }
    if (url.pathname === "/app/installations/99") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 99,
        account: {
          login: "steipete",
          type: "User",
          avatar_url: "https://avatars.githubusercontent.com/u/1",
          html_url: "https://github.com/steipete",
        },
        html_url: "https://github.com/settings/installations/99",
        repository_selection: "all",
        target_type: "User",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const install = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=99&setup_action=install", {
        headers: { cookie: `rd_session=${authCookie}; rd_install_return=${installReturn}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(install.status).toBe(302);
    expect(install.headers.get("location")).toBe("/steipete");

    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    const acknowledgedAt = stored.installationsUpdatedAt;
    const remembered = stored.installations.find(
      (installation: { id: number }) => installation.id === 99,
    );
    expect(remembered.accountLogin).toBe("steipete");
    expect(remembered.repositorySelection).toBe("all");

    const me = await worker.fetch(
      new Request("https://release.bar/api/me?returnTo=/steipete", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(me.status).toBe(200);
    const body = await me.json<any>();
    expect(body.installNeeded).toBe(false);
    expect(body.installReason).toBe(null);
    expect(
      body.installations.some(
        (installation: { accountLogin: string }) => installation.accountLogin === "steipete",
      ),
    ).toBe(true);
    const afterMe = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    expect(afterMe.installationsUpdatedAt).toBe(acknowledgedAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker ignores install callback acknowledgements without signed return state", async () => {
  const sessionId = "session-install-forged";
  const exp = Math.floor(Date.now() / 1000) + 600;
  const authCookie = await signedJson("test-secret", { id: sessionId, exp });
  const cache = kvStore({
    [`auth:session:${sessionId}`]: JSON.stringify({
      user: {
        id: 1,
        login: "steipete",
        name: null,
        avatarUrl: "https://avatars.githubusercontent.com/u/1",
        url: "https://github.com/steipete",
      },
      accessToken: "user-token",
      iat: exp - 600,
      exp,
    }),
  });
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=99&setup_action=install", {
        headers: { cookie: `rd_session=${authCookie}` },
      }),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const stored = JSON.parse((await cache.get(`auth:session:${sessionId}`)) ?? "{}");
    expect(stored.installations).toBe(undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker records server-verified install callbacks without signed return state", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cache = kvStore();
  const env = {
    AUTH_COOKIE_SECRET: "test-secret",
    DASHBOARD_CACHE: cache,
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: "releasebar-app",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/app/installations/101") {
      expect(authorization ?? "").toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({
        id: 101,
        account: {
          login: "outside-org",
          type: "Organization",
          avatar_url: "https://avatars.githubusercontent.com/u/101",
          html_url: "https://github.com/outside-org",
        },
        html_url: "https://github.com/organizations/outside-org/settings/installations/101",
        repository_selection: "all",
        target_type: "Organization",
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  try {
    const response = await worker.fetch(
      new Request("https://release.bar/api/auth/install?installation_id=101&setup_action=install"),
      env,
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const remembered = JSON.parse((await storedInstallationJson("outside-org")) ?? "{}");
    expect(remembered.id).toBe(101);
    expect(remembered.accountLogin).toBe("outside-org");
    expect(await authFunnelEventCount()).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin logins come from ADMIN_LOGINS and default to nobody", async () => {
  const { isAdminLogin } = await import("../worker/auth-oauth.ts");
  expect(isAdminLogin("steipete", testEnv({}))).toBe(false);
  expect(isAdminLogin("anyone", testEnv({ ADMIN_LOGINS: "" }))).toBe(false);
  expect(isAdminLogin("Octo", testEnv({ ADMIN_LOGINS: "first, octo ,third" }))).toBe(true);
  expect(isAdminLogin("other", testEnv({ ADMIN_LOGINS: "first, octo ,third" }))).toBe(false);
});
