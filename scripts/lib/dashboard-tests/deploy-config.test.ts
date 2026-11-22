import assert from "node:assert/strict";
import test from "node:test";

import { type RawWranglerConfig, deployConfig } from "../deploy-config.js";
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

test("deploy config without settings is the generic wrangler.toml", () => {
  const config = deployConfig(base, {});
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
  });
  assert.deepEqual(config.routes, [{ pattern: "releasebar.example.com", custom_domain: true }]);
  assert.deepEqual(config.kv_namespaces, [{ binding: "DASHBOARD_CACHE", id: kvId }]);
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.vars, {
    ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5",
    RELEASEDECK_CANONICAL_DOMAIN: "releasebar.example.com",
    ADMIN_LOGINS: "octocat,hubot",
    RELEASEBAR_DO_JURISDICTION: "eu",
  });
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
