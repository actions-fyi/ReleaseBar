import { env as runtimeEnv } from "cloudflare:workers";
import { expect, test, vi } from "vitest";

import { claudeText, testEnv } from "./dashboard-test-harness.ts";
import {
  type RawWranglerConfig,
  deployConfig,
  hasDeploySettings,
} from "../shared/deploy-config.ts";
import { claudeSummaryText } from "../worker/release-summary.ts";
import { durableObjectBindings, withLockJurisdiction } from "../worker/store/bindings.ts";

const kvId = "0123456789abcdef0123456789abcdef";
const d1Id = "01234567-89ab-cdef-0123-456789abcdef";
// Every deploy names its D1 database.
const d1 = { RELEASEBAR_D1_DATABASE_ID: d1Id };

const base: RawWranglerConfig = {
  name: "releasebar",
  workers_dev: true,
  vars: { ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5" },
  kv_namespaces: [{ binding: "DASHBOARD_CACHE" }],
  d1_databases: [{ binding: "DB", database_name: "releasebar", migrations_dir: "migrations" }],
};
const d1Databases = [
  { binding: "DB", database_name: "releasebar", migrations_dir: "migrations", database_id: d1Id },
];

test("deploy config refuses to deploy without any setting", () => {
  expect(() => deployConfig(base, {})).toThrow("RELEASEBAR_D1_DATABASE_ID is not set");
});

test("the build applies deployment settings only when the environment has some", () => {
  expect(hasDeploySettings({})).toBe(false);
  expect(hasDeploySettings({ RELEASEBAR_DOMAIN: " " })).toBe(false);
  expect(hasDeploySettings({ RELEASEBAR_ADMIN_LOGINS: "octocat" })).toBe(true);
  expect(hasDeploySettings(d1)).toBe(true);
});

test("deploy config with only a D1 database is the generic wrangler.jsonc with that database", () => {
  const config = deployConfig(base, d1);
  expect(config).toStrictEqual({
    ...base,
    vars: base.vars,
    kv_namespaces: base.kv_namespaces,
    d1_databases: d1Databases,
  });
  expect(config.routes).toBe(undefined);
});

test("deploy config refuses to deploy without a pre-created D1 database", () => {
  for (const settings of [
    { RELEASEBAR_DOMAIN: "releasebar.example.com" },
    { RELEASEBAR_KV_NAMESPACE_ID: kvId, RELEASEBAR_DO_JURISDICTION: "eu" },
  ]) {
    expect(() => deployConfig(base, settings)).toThrow("RELEASEBAR_D1_DATABASE_ID is not set");
  }
});

test("deploy config leaves other D1 bindings alone", () => {
  const config = deployConfig(
    { ...base, d1_databases: [{ binding: "OTHER" }, ...(base.d1_databases ?? [])] },
    { RELEASEBAR_D1_DATABASE_ID: d1Id.toUpperCase() },
  );
  expect(config.d1_databases).toStrictEqual([{ binding: "OTHER" }, ...d1Databases]);
});

test("deploy config applies the deployment's domain, KV namespace, jurisdiction and admins", () => {
  const config = deployConfig(base, {
    ...d1,
    RELEASEBAR_DOMAIN: " ReleaseBar.Example.com ",
    RELEASEBAR_KV_NAMESPACE_ID: kvId.toUpperCase(),
    RELEASEBAR_DO_JURISDICTION: "eu",
    RELEASEBAR_ADMIN_LOGINS: "octocat, hubot",
    RELEASEBAR_WORKERS_DEV: "false",
    RELEASEBAR_ANTHROPIC_BASE_URL: " https://gateway.example.com/anthropic ",
  });
  expect(config.routes).toStrictEqual([{ pattern: "releasebar.example.com", custom_domain: true }]);
  expect(config.kv_namespaces).toStrictEqual([{ binding: "DASHBOARD_CACHE", id: kvId }]);
  expect(config.d1_databases).toStrictEqual(d1Databases);
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
    ...d1,
    RELEASEBAR_SUMMARY_INPUT_CHARS: " 20000 ",
    RELEASEBAR_SUMMARY_TITLE_CHARS: "80",
  });
  expect(config.vars).toStrictEqual({
    ANTHROPIC_SUMMARY_MODEL: "claude-haiku-5-5",
    RELEASE_SUMMARY_INPUT_CHARS: "20000",
    RELEASE_SUMMARY_TITLE_CHARS: "80",
  });
  for (const value of ["999", "400001", "48,000", "-1", "4.8e4"]) {
    expect(
      () => deployConfig(base, { ...d1, RELEASEBAR_SUMMARY_INPUT_CHARS: value }),
      value,
    ).toThrow("from 1000 to 400000");
  }
});

test("deploy config refuses a jurisdiction without a pre-created KV namespace", () => {
  expect(() => deployConfig(base, { ...d1, RELEASEBAR_DO_JURISDICTION: "eu" })).toThrow(
    "RELEASEBAR_KV_NAMESPACE_ID is not",
  );
});

test("deploy config rejects malformed settings", () => {
  // With a valid D1 database, so that only the malformed setting can be what is refused.
  expect(deployConfig(base, d1).d1_databases).toStrictEqual(d1Databases);
  for (const settings of [
    { RELEASEBAR_DOMAIN: "https://x.example.com/" },
    { RELEASEBAR_KV_NAMESPACE_ID: "my-namespace" },
    { RELEASEBAR_ADMIN_LOGINS: "octocat;hubot" },
    { RELEASEBAR_WORKERS_DEV: "yes" },
    { RELEASEBAR_ANTHROPIC_BASE_URL: "gateway.example.com" },
    { RELEASEBAR_ANTHROPIC_BASE_URL: "http://gateway.test" },
  ]) {
    expect(() => deployConfig(base, { ...d1, ...settings }), JSON.stringify(settings)).toThrow();
  }
  for (const id of ["releasebar", kvId, `${d1Id}0`]) {
    expect(() => deployConfig(base, { RELEASEBAR_D1_DATABASE_ID: id }), id).toThrow(
      "must be the UUID of a D1 database",
    );
  }
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

// Namespaces that record the jurisdiction they are scoped to: the local runtime has none.
// Records which jurisdiction each Durable Object binding of the runtime is asked for. The local
// runtime has no jurisdictions and throws when asked for one, so the call answers with the
// binding itself: locally, every object is in the one place there is.
function observedJurisdictions(): string[] {
  const calls: string[] = [];
  for (const binding of durableObjectBindings) {
    const namespace: DurableObjectNamespace = runtimeEnv[binding];
    vi.spyOn(namespace, "jurisdiction").mockImplementation((jurisdiction) => {
      calls.push(`${binding}:${jurisdiction}`);
      return namespace;
    });
  }
  return calls;
}

test("lock jurisdiction leaves the bindings alone when unset", () => {
  const calls = observedJurisdictions();
  const env = testEnv({});
  expect(withLockJurisdiction(env)).toBe(env);
  expect(calls).toStrictEqual([]);
});

test("lock jurisdiction scopes every Durable Object to the configured jurisdiction", async () => {
  const calls = observedJurisdictions();
  const env = testEnv({ RELEASEBAR_DO_JURISDICTION: "eu" });
  const scoped = withLockJurisdiction(env);
  expect(scoped).not.toBe(env);
  expect(calls).toStrictEqual(durableObjectBindings.map((binding) => `${binding}:eu`));
  // Scoped once for an env, however often it is asked for.
  expect(withLockJurisdiction(env)).toBe(scoped);
  expect(calls.length).toBe(durableObjectBindings.length);
  // The scoped bindings are what the namespaces answered, and reach working objects.
  expect(await scoped.RATE_LIMITER.getByName("lock").reached("client", 1, 1)).toBe(false);
  expect(await scoped.RATE_LIMITER.getByName("lock").reached("client", 1, 1)).toBe(true);
});

test("lock jurisdiction fails loudly on a binding without jurisdictions", () => {
  observedJurisdictions();
  // The real binding, as a runtime without the method would give it.
  const withoutJurisdictions: DurableObjectNamespace = Object.create(runtimeEnv.SUMMARY_QUOTA, {
    jurisdiction: { value: undefined },
  });
  const env = testEnv({
    RELEASEBAR_DO_JURISDICTION: "eu",
    SUMMARY_QUOTA: withoutJurisdictions as Env["SUMMARY_QUOTA"],
  });
  expect(() => withLockJurisdiction(env)).toThrow("SUMMARY_QUOTA has no jurisdictions");
});
