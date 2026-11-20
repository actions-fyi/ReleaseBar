# Self-hosting and Operations

ReleaseBar is a Svelte frontend and Cloudflare Worker service. The Worker serves the static app shell and public GitHub API routes, while Cloudflare KV, Queues, and a Durable Object coordinate cached dashboard hydration.

## Requirements

- Node.js 22.12 or newer; CI and `.nvmrc` use Node.js 24.
- npm, using the committed `package-lock.json`.
- A Cloudflare account and Wrangler authentication for remote development or deployment.
- A GitHub token for higher API limits when building real dashboard data locally.

Install dependencies and build the app:

```sh
npm ci
npm run build
```

`GITHUB_TOKEN` is optional. GitHub Actions uses its built-in token for data builds that need authenticated GitHub access.

## Configuration

Static builds read `releasebar.config.json`.

| Key                 | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `owners`            | GitHub users or organizations to scan                         |
| `includeForks`      | Include forked repositories                                   |
| `includeArchived`   | Include archived repositories                                 |
| `includeUnreleased` | Include repositories without GitHub releases in static builds |
| `excludeRepos`      | Hide specific `owner/name` repositories                       |
| `canonicalDomain`   | Set the primary dashboard domain                              |

The public Worker service accepts arbitrary public owners through route and query parameters rather than limiting requests to the static configuration.

## Local development

For frontend hot reload:

```sh
npm run dev
```

For a fully local Worker on port 8787:

```sh
npm run dev:worker
```

The Vite app falls back to `http://127.0.0.1:8787` for API calls. Local Worker development does not receive production secrets unless they are provided through local Wrangler configuration.

For local code running on Cloudflare with real secrets and preview KV:

```sh
npm run dev:worker:real
```

Open `http://localhost:8787/steipete` or another owner route.

## Cloudflare resources

`wrangler.toml` binds:

- `dist` as Worker static assets
- `DASHBOARD_CACHE` as KV storage for dashboard, repository, settings, installation, session, and scheduler records
- `DASHBOARD_LOCKS` as a Durable Object for single-flight builds, checkpoints, job reservations, and failure state
- `REFRESH_QUEUE` for bounded background hydration and webhook work

The Worker runs before static assets so `/api/*` stays dynamic and owner routes return the application shell. The Worker is named `releasebar`.

`wrangler.toml` names no account and no KV namespace ID: the deploying Cloudflare account is the one Workers Builds is connected to, and Wrangler creates the `DASHBOARD_CACHE` namespace on the first deploy. The queues `releasebar-refresh` and `releasebar-refresh-dlq` must exist before that deploy (`wrangler queues create <name>`), and the zone of the custom domain in `[[routes]]` must be in the same account.

The shared `GITHUB_TOKEN` is the fallback quota bucket for sources without GitHub App coverage. Installed accounts use their own App quota. ReleaseBar defers optional enrichment before core release-health work when shared GitHub quota becomes constrained. Detailed cache, queue, and retry behavior is in [the refresh scheduler](refresh-scheduler.md).

## GitHub App

Configure these Worker secrets to enable login and installation:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `AUTH_COOKIE_SECRET`

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` enable dedicated installation quota. Without them, users can still sign in, but dashboard rebuilds use the shared server token and cache. `GITHUB_APP_SLUG` is optional and defaults to `releasebar-app`.

Set the GitHub App setup URL to `https://releases.actions.fyi/api/auth/install` and enable redirect-on-update. Set the webhook URL to `https://releases.actions.fyi/api/github/webhook`, use the same webhook secret in GitHub and Cloudflare, and subscribe to Issues, Pull requests, Push, Releases, and Repository events.

Signed webhook payloads up to 2 MiB enter Cloudflare Queue before acknowledgement. Issue and pull-request bursts coalesce into authoritative count refreshes; push and release bursts coalesce into release refreshes. Privacy and archive transitions remain separate so visibility changes apply promptly.

## AI summaries

Set `ANTHROPIC_API_KEY` as a Worker secret to summarize public owner activity and commit titles since the latest release:

```sh
wrangler secret put ANTHROPIC_API_KEY
```

`ANTHROPIC_SUMMARY_MODEL` is optional and defaults to `claude-haiku-5-5`. Summaries run server-side through the Anthropic Messages API, remain subordinate to public source data, and are cached with the model and prompt version.

## Deploy

The production deployment is a Cloudflare Worker with Worker Assets, not GitHub Pages. A local deployment runs:

```sh
npm run build
wrangler deploy
```

Pushes to `main` are built and deployed by Cloudflare's GitHub app (Workers Builds), which runs the `[build]` command of `wrangler.toml` and `wrangler deploy`. No workflow deploys, and GitHub holds no Cloudflare token.

Pull requests are gated by the org's Test TypeScript check, which runs the `typecheck`, `lint`, `format:check`, `build` and `test` scripts, and by `.github/workflows/cloudflare.yml`, which dry-runs the Wrangler deployment without credentials. `npm run build` is the offline build; `npm run build:data` also fetches dashboard data from GitHub.

## Admin

`ADMIN_LOGINS` in `wrangler.toml` is a comma-separated list of GitHub logins that may open `/_admin`. Without it, nobody can.
