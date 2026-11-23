// Builds the Wrangler config a deployment uses from the generic wrangler.jsonc and the deployment's
// own settings, so no host, account resource or login has to be committed to the repository.

import { parseWholeNumber, summaryLimitSettings } from "../worker/summary-limits.ts";

export type WranglerRoute = { readonly pattern: string; readonly custom_domain?: boolean };

export type WranglerKvNamespace = { readonly binding: string; readonly id?: string };

export type WranglerD1Database = Readonly<Record<string, unknown>> & {
  readonly binding: string;
  readonly database_id?: string;
};

export type RawWranglerConfig = Readonly<Record<string, unknown>> & {
  readonly workers_dev?: boolean;
  readonly routes?: readonly WranglerRoute[];
  readonly vars?: Readonly<Record<string, string>>;
  readonly kv_namespaces?: readonly WranglerKvNamespace[];
  readonly d1_databases?: readonly WranglerD1Database[];
};

export type DeploySettings = Readonly<Record<string, string | undefined>>;

// The D1 binding of wrangler.jsonc whose database RELEASEBAR_D1_DATABASE_ID names.
export const d1Binding = "DB";

export const deploySettingNames = [
  "RELEASEBAR_DOMAIN",
  "RELEASEBAR_KV_NAMESPACE_ID",
  "RELEASEBAR_D1_DATABASE_ID",
  "RELEASEBAR_DO_JURISDICTION",
  "RELEASEBAR_ADMIN_LOGINS",
  "RELEASEBAR_WORKERS_DEV",
  "RELEASEBAR_ANTHROPIC_BASE_URL",
  "RELEASEBAR_SUMMARY_INPUT_CHARS",
  "RELEASEBAR_SUMMARY_TITLE_CHARS",
  "RELEASEBAR_SUMMARY_USER_HOURLY_LIMIT",
  "RELEASEBAR_SUMMARY_GLOBAL_DAILY_LIMIT",
] as const;

// A bare host name: matches "releasebar.example.com", rejects "https://releasebar.example.com/".
// https://regex101.com/?regex=%5E%28%3F%3D.%7B1%2C253%7D%24%29%28%3F%3A%5Ba-z%5Cd%5D%28%3F%3A%5Ba-z%5Cd-%5D%7B0%2C61%7D%5Ba-z%5Cd%5D%29%3F%5C.%29%2B%5Ba-z%5D%7B2%2C63%7D%24&flags=i&testString=releasebar.example.com
const hostPattern = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i;

// A KV namespace ID, 32 hex digits: matches "0123456789abcdef0123456789abcdef", rejects "my-namespace".
// https://regex101.com/?regex=%5E%5Ba-f%5Cd%5D%7B32%7D%24&flags=i&testString=0123456789abcdef0123456789abcdef
const kvIdPattern = /^[a-f\d]{32}$/i;

// A D1 database ID, a UUID: matches "01234567-89ab-cdef-0123-456789abcdef", rejects "releasebar".
// https://regex101.com/?regex=%5E%5Ba-f%5Cd%5D%7B8%7D%28%3F%3A-%5Ba-f%5Cd%5D%7B4%7D%29%7B3%7D-%5Ba-f%5Cd%5D%7B12%7D%24&flags=i&testString=01234567-89ab-cdef-0123-456789abcdef
const d1IdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

// A jurisdiction name: matches "eu" and "fedramp", rejects "EU-West" and "eu;".
// https://regex101.com/?regex=%5E%5Ba-z%5D%2B%24&testString=eu
const jurisdictionPattern = /^[a-z]+$/;

// GitHub logins separated by commas: matches "octocat,hubot", rejects "octocat hubot".
// https://regex101.com/?regex=%5E%5Ba-z%5Cd-%5D%2B%28%3F%3A%2C%5Ba-z%5Cd-%5D%2B%29*%24&flags=i&testString=octocat%2Chubot
const loginsPattern = /^[a-z\d-]+(?:,[a-z\d-]+)*$/i;

// A boolean flag: matches "true" and "false", rejects "yes" and "1".
// https://regex101.com/?regex=%5E%28%3F%3Atrue%7Cfalse%29%24&testString=true
const booleanPattern = /^(?:true|false)$/;

function setting(settings: DeploySettings, name: (typeof deploySettingNames)[number]): string {
  return settings[name]?.trim() ?? "";
}

function check(value: string, pattern: RegExp, message: string): void {
  if (value && !pattern.test(value)) throw new Error(message);
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

// The Worker vars for the summary limits whose build variables are set, checked against
// their bounds.
function summaryLimitVars(settings: DeploySettings): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const { variable, buildVariable, min, max } of summaryLimitSettings) {
    const raw = settings[buildVariable]?.trim() ?? "";
    if (!raw) continue;
    const value = parseWholeNumber(raw);
    if (value === null || value < min || value > max) {
      throw new Error(`${buildVariable} must be a whole number from ${min} to ${max}`);
    }
    vars[variable] = String(value);
  }
  return vars;
}

// Whether the environment asks for a deployment's own config at all.
export function hasDeploySettings(settings: DeploySettings): boolean {
  return deploySettingNames.some((name) => setting(settings, name));
}

export function deployConfig(base: RawWranglerConfig, settings: DeploySettings): RawWranglerConfig {
  const domain = setting(settings, "RELEASEBAR_DOMAIN").toLowerCase();
  const kvId = setting(settings, "RELEASEBAR_KV_NAMESPACE_ID").toLowerCase();
  const d1Id = setting(settings, "RELEASEBAR_D1_DATABASE_ID").toLowerCase();
  const jurisdiction = setting(settings, "RELEASEBAR_DO_JURISDICTION").toLowerCase();
  const admins = setting(settings, "RELEASEBAR_ADMIN_LOGINS").replaceAll(" ", "");
  const workersDev = setting(settings, "RELEASEBAR_WORKERS_DEV").toLowerCase();
  const anthropicBaseUrl = setting(settings, "RELEASEBAR_ANTHROPIC_BASE_URL");

  check(domain, hostPattern, `RELEASEBAR_DOMAIN must be a bare host name, not "${domain}"`);
  check(kvId, kvIdPattern, "RELEASEBAR_KV_NAMESPACE_ID must be a 32-digit hex KV namespace ID");
  check(d1Id, d1IdPattern, "RELEASEBAR_D1_DATABASE_ID must be the UUID of a D1 database");
  check(
    jurisdiction,
    jurisdictionPattern,
    `RELEASEBAR_DO_JURISDICTION "${jurisdiction}" is invalid`,
  );
  check(admins, loginsPattern, "RELEASEBAR_ADMIN_LOGINS must be GitHub logins separated by commas");
  check(workersDev, booleanPattern, 'RELEASEBAR_WORKERS_DEV must be "true" or "false"');
  if (anthropicBaseUrl && !isHttpsUrl(anthropicBaseUrl)) {
    throw new Error("RELEASEBAR_ANTHROPIC_BASE_URL must be an https:// URL");
  }
  const summaryLimits = summaryLimitVars(settings);
  // Every deploy names its D1 database, so a deploy that lost its build variables stops here too,
  // before it drops the deployment's custom domain and admin logins.
  if (!d1Id) {
    throw new Error(
      "RELEASEBAR_D1_DATABASE_ID is not set, so the deploy would let Wrangler create the D1 " +
        "database on its own, outside any jurisdiction, and a jurisdiction can't be added later. " +
        "Create it with `wrangler d1 create <name> --jurisdiction <jurisdiction>` and set its ID.",
    );
  }
  if (jurisdiction && !kvId) {
    throw new Error(
      "RELEASEBAR_DO_JURISDICTION is set but RELEASEBAR_KV_NAMESPACE_ID is not, so the deploy " +
        "would create the KV namespace outside that jurisdiction. Create it with " +
        "`wrangler kv namespace create <name> --jurisdiction <jurisdiction>` and set its ID.",
    );
  }

  const vars: Record<string, string> = {
    ...base.vars,
    ...(domain ? { RELEASEDECK_CANONICAL_DOMAIN: domain } : {}),
    ...(admins ? { ADMIN_LOGINS: admins } : {}),
    ...(jurisdiction ? { RELEASEBAR_DO_JURISDICTION: jurisdiction } : {}),
    ...(anthropicBaseUrl ? { ANTHROPIC_BASE_URL: anthropicBaseUrl } : {}),
    ...summaryLimits,
  };
  const kvNamespaces = (base.kv_namespaces ?? []).map((namespace) =>
    kvId && namespace.binding === "DASHBOARD_CACHE" ? { ...namespace, id: kvId } : namespace,
  );

  const d1Databases = (base.d1_databases ?? []).map((database) =>
    database.binding === d1Binding ? { ...database, database_id: d1Id } : database,
  );

  return {
    ...base,
    ...(workersDev ? { workers_dev: workersDev === "true" } : {}),
    ...(domain ? { routes: [{ pattern: domain, custom_domain: true }] } : {}),
    vars,
    kv_namespaces: kvNamespaces,
    d1_databases: d1Databases,
  };
}
