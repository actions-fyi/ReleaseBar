// Variables and secrets a deployment sets outside wrangler.jsonc: `pnpm run deploy` writes some from
// RELEASEBAR_* build variables, the rest are Worker secrets or dashboard variables (see
// docs/self-hosting.md). Bindings are not declared here: `pnpm run types` generates them into
// worker-configuration.d.ts.
interface DeploymentEnv {
  ADMIN_LOGINS?: string;
  AUTH_COOKIE_SECRET?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  RELEASE_SUMMARY_INPUT_CHARS?: string;
  RELEASE_SUMMARY_TITLE_CHARS?: string;
  SUMMARY_USER_HOURLY_LIMIT?: string;
  SUMMARY_GLOBAL_DAILY_LIMIT?: string;
  RELEASEDECK_CANONICAL_DOMAIN?: string;
  RELEASEBAR_DO_JURISDICTION?: string;
}

interface Env extends DeploymentEnv {}

declare namespace Cloudflare {
  interface Env extends DeploymentEnv {}
}
