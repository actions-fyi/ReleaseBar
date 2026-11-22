import assert from "node:assert/strict";
import test from "node:test";

import { claudeText } from "../dashboard-test-harness.js";
import { type RawWranglerConfig, deployConfig } from "../deploy-config.js";
import { claudeSummaryText } from "../../../worker/release-summary.js";
import {
  type DurableObjectNamespace,
  type Env,
  withLockJurisdiction,
} from "../../../worker/runtime.js";

const kvId = "0123456789abcdef0123456789abcdef";

const base: RawWranglerConfig = {
  name: "releasebar",
  workers_dev: true,
  vars: { ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5" },
  kv_namespaces: [{ binding: "DASHBOARD_CACHE" }],
};

test("deploy config refuses to deploy without any setting unless allowed", () => {
  assert.throws(
    () => deployConfig(base, {}),
    (error) => error instanceof Error && error.message.includes("RELEASEBAR_ALLOW_GENERIC"),
  );
});

test("deploy config without settings is the generic wrangler.toml when allowed", () => {
  const config = deployConfig(base, { RELEASEBAR_ALLOW_GENERIC: "true" });
  assert.deepEqual(config, { ...base, vars: base.vars, kv_namespaces: base.kv_namespaces });
  assert.equal(config.routes, undefined);
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
  assert.deepEqual(config.routes, [{ pattern: "releasebar.example.com", custom_domain: true }]);
  assert.deepEqual(config.kv_namespaces, [{ binding: "DASHBOARD_CACHE", id: kvId }]);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.vars, {
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
    RELEASEBAR_SUMMARY_BODY_CHARS: "0",
  });
  assert.deepEqual(config.vars, {
    ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5",
    RELEASE_SUMMARY_INPUT_CHARS: "20000",
    RELEASE_SUMMARY_BODY_CHARS: "0",
  });
  for (const value of ["999", "400001", "48,000", "-1", "4.8e4"]) {
    assert.throws(
      () => deployConfig(base, { RELEASEBAR_SUMMARY_INPUT_CHARS: value }),
      (error) => error instanceof Error && error.message.includes("from 1000 to 400000"),
      value,
    );
  }
});

test("deploy config refuses a jurisdiction without a pre-created KV namespace", () => {
  assert.throws(
    () => deployConfig(base, { RELEASEBAR_DO_JURISDICTION: "eu" }),
    (error) =>
      error instanceof Error && error.message.includes("RELEASEBAR_KV_NAMESPACE_ID is not"),
  );
});

test("deploy config rejects malformed settings", () => {
  assert.throws(() => deployConfig(base, { RELEASEBAR_DOMAIN: "https://x.example.com/" }));
  assert.throws(() => deployConfig(base, { RELEASEBAR_KV_NAMESPACE_ID: "my-namespace" }));
  assert.throws(() => deployConfig(base, { RELEASEBAR_ADMIN_LOGINS: "octocat;hubot" }));
  assert.throws(() => deployConfig(base, { RELEASEBAR_WORKERS_DEV: "yes" }));
  assert.throws(() => deployConfig(base, { RELEASEBAR_ANTHROPIC_BASE_URL: "gateway.example.com" }));
  assert.throws(() => deployConfig(base, { RELEASEBAR_ANTHROPIC_BASE_URL: "http://gateway.test" }));
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
    await claudeSummaryText({ ANTHROPIC_API_KEY: "claude-key" }, request);
    await claudeSummaryText(
      {
        ANTHROPIC_API_KEY: "claude-key",
        ANTHROPIC_BASE_URL: "https://gateway.example.com/anthropic",
      },
      request,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requested, [
    "https://api.anthropic.com/v1/messages",
    "https://gateway.example.com/anthropic/v1/messages",
  ]);
});

function fakeLocks(calls: string[]): DurableObjectNamespace {
  const namespace: DurableObjectNamespace = {
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
  const env = { DASHBOARD_LOCKS: fakeLocks([]) } as Env;
  assert.equal(withLockJurisdiction(env), env);
});

test("lock jurisdiction scopes every Durable Object to the configured jurisdiction", () => {
  const calls: string[] = [];
  const env = { DASHBOARD_LOCKS: fakeLocks(calls), RELEASEBAR_DO_JURISDICTION: "eu" } as Env;
  const scoped = withLockJurisdiction(env);
  assert.equal(scoped.DASHBOARD_LOCKS?.idFromName("lock"), "eu:lock");
  assert.equal(withLockJurisdiction(env).DASHBOARD_LOCKS, scoped.DASHBOARD_LOCKS);
  assert.deepEqual(calls, ["eu"]);
});

test("lock jurisdiction fails loudly on a binding without jurisdictions", () => {
  const locks: DurableObjectNamespace = {
    idFromName: (name) => name,
    get: () => ({ fetch: async () => new Response(null) }),
  };
  assert.throws(() =>
    withLockJurisdiction({ DASHBOARD_LOCKS: locks, RELEASEBAR_DO_JURISDICTION: "eu" } as Env),
  );
});
