import { expect, test } from "vitest";

import { type FakeLocks, claudeText, testEnv } from "./dashboard-test-harness.ts";
import {
  type RawWranglerConfig,
  deployConfig,
  hasDeploySettings,
} from "../shared/deploy-config.ts";
import { claudeSummaryText } from "../worker/release-summary.ts";
import { withLockJurisdiction } from "../worker/runtime.ts";

const kvId = "0123456789abcdef0123456789abcdef";

const base: RawWranglerConfig = {
  name: "releasebar",
  workers_dev: true,
  vars: { ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5" },
  kv_namespaces: [{ binding: "DASHBOARD_CACHE" }],
};

test("deploy config refuses to deploy without any setting unless allowed", () => {
  expect(() => deployConfig(base, {})).toThrow("RELEASEBAR_ALLOW_GENERIC");
});

test("the build applies deployment settings only when the environment has some", () => {
  expect(hasDeploySettings({})).toBe(false);
  expect(hasDeploySettings({ RELEASEBAR_DOMAIN: " " })).toBe(false);
  expect(hasDeploySettings({ RELEASEBAR_ADMIN_LOGINS: "octocat" })).toBe(true);
  expect(hasDeploySettings({ RELEASEBAR_ALLOW_GENERIC: "true" })).toBe(true);
});

test("deploy config without settings is the generic wrangler.jsonc when allowed", () => {
  const config = deployConfig(base, { RELEASEBAR_ALLOW_GENERIC: "true" });
  expect(config).toStrictEqual({ ...base, vars: base.vars, kv_namespaces: base.kv_namespaces });
  expect(config.routes).toBe(undefined);
});

test("deploy config applies the deployment's domain, KV namespace, jurisdiction and admins", () => {
  const config = deployConfig(base, {
    RELEASEBAR_DOMAIN: " ReleaseBar.Example.com ",
    RELEASEBAR_KV_NAMESPACE_ID: kvId.toUpperCase(),
    RELEASEBAR_DO_JURISDICTION: "eu",
    RELEASEBAR_ADMIN_LOGINS: "octocat, hubot",
    RELEASEBAR_WORKERS_DEV: "false",
    RELEASEBAR_ANTHROPIC_BASE_URL: " https://gateway.example.com/anthropic ",
  });
  expect(config.routes).toStrictEqual([{ pattern: "releasebar.example.com", custom_domain: true }]);
  expect(config.kv_namespaces).toStrictEqual([{ binding: "DASHBOARD_CACHE", id: kvId }]);
  expect(config.workers_dev).toBe(false);
  expect(config.vars).toStrictEqual({
    ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5",
    RELEASEDECK_CANONICAL_DOMAIN: "releasebar.example.com",
    ADMIN_LOGINS: "octocat,hubot",
    RELEASEBAR_DO_JURISDICTION: "eu",
    ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
  });
});

test("deploy config sets the release summary limits from their build variables", () => {
  const config = deployConfig(base, {
    RELEASEBAR_SUMMARY_INPUT_CHARS: " 20000 ",
    RELEASEBAR_SUMMARY_TITLE_CHARS: "80",
  });
  expect(config.vars).toStrictEqual({
    ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5",
    RELEASE_SUMMARY_INPUT_CHARS: "20000",
    RELEASE_SUMMARY_TITLE_CHARS: "80",
  });
  for (const value of ["999", "400001", "48,000", "-1", "4.8e4"]) {
    expect(() => deployConfig(base, { RELEASEBAR_SUMMARY_INPUT_CHARS: value }), value).toThrow(
      "from 1000 to 400000",
    );
  }
});

test("deploy config refuses a jurisdiction without a pre-created KV namespace", () => {
  expect(() => deployConfig(base, { RELEASEBAR_DO_JURISDICTION: "eu" })).toThrow(
    "RELEASEBAR_KV_NAMESPACE_ID is not",
  );
});

test("deploy config rejects malformed settings", () => {
  expect(() => deployConfig(base, { RELEASEBAR_DOMAIN: "https://x.example.com/" })).toThrow();
  expect(() => deployConfig(base, { RELEASEBAR_KV_NAMESPACE_ID: "my-namespace" })).toThrow();
  expect(() => deployConfig(base, { RELEASEBAR_ADMIN_LOGINS: "octocat;hubot" })).toThrow();
  expect(() => deployConfig(base, { RELEASEBAR_WORKERS_DEV: "yes" })).toThrow();
  expect(() =>
    deployConfig(base, { RELEASEBAR_ANTHROPIC_BASE_URL: "gateway.example.com" }),
  ).toThrow();
  expect(() =>
    deployConfig(base, { RELEASEBAR_ANTHROPIC_BASE_URL: "http://gateway.test" }),
  ).toThrow();
});

test("Claude summaries go to ANTHROPIC_BASE_URL when it is set", async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(input instanceof Request ? input.url : String(input));
    return Response.json({ content: claudeText("Summary."), stop_reason: "end_turn" });
  };
  const maxTokens = 100;
  const request = { model: "claude-haiku-5-5", maxTokens, system: "s", user: "u" };
  try {
    await claudeSummaryText(
      testEnv({ ANTHROPIC_API_KEY: "claude-key" }),
      request,
      async () => undefined,
    );
    await claudeSummaryText(
      testEnv({
        ANTHROPIC_API_KEY: "claude-key",
        ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
      }),
      request,
      async () => undefined,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(requested).toStrictEqual([
    "https://api.anthropic.com/v1/messages",
    "https://gateway.example.com/anthropic/v1/messages",
  ]);
});

function fakeLocks(calls: string[]): FakeLocks {
  const namespace: FakeLocks = {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => new Response(null) }),
    jurisdiction: (jurisdiction) => {
      calls.push(jurisdiction);
      return { ...namespace, idFromName: (name) => `${jurisdiction}:${name}` };
    },
  };
  return namespace;
}

test("lock jurisdiction leaves the binding alone when unset", () => {
  const env = testEnv({ DASHBOARD_LOCKS: fakeLocks([]) });
  expect(withLockJurisdiction(env)).toBe(env);
});

test("lock jurisdiction scopes every Durable Object to the configured jurisdiction", () => {
  const calls: string[] = [];
  const env = testEnv({ DASHBOARD_LOCKS: fakeLocks(calls), RELEASEBAR_DO_JURISDICTION: "eu" });
  const scoped = withLockJurisdiction(env);
  expect(scoped.DASHBOARD_LOCKS?.idFromName("lock")).toBe("eu:lock");
  expect(withLockJurisdiction(env).DASHBOARD_LOCKS).toBe(scoped.DASHBOARD_LOCKS);
  expect(calls).toStrictEqual(["eu"]);
});

test("lock jurisdiction fails loudly on a binding without jurisdictions", () => {
  const locks: FakeLocks = {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => new Response(null) }),
  };
  expect(() =>
    withLockJurisdiction(testEnv({ DASHBOARD_LOCKS: locks, RELEASEBAR_DO_JURISDICTION: "eu" })),
  ).toThrow();
});
