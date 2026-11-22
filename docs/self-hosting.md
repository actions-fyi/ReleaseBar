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

| Key                 | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `owners`            | GitHub users or organizations to scan                               |
| `includeForks`      | Include forked repositories                                         |
| `includeArchived`   | Include archived repositories                                       |
| `includeUnreleased` | Include repositories without GitHub releases in static builds       |
| `excludeRepos`      | Hide specific `owner/name` repositories                             |
| `canonicalDomain`   | Optional primary dashboard domain; `RELEASEBAR_DOMAIN` overrides it |

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

`wrangler.toml` is generic: it names no account, custom domain, admin login or resource ID. A deployment supplies its own through environment variables, and `npm run deploy` writes them into `wrangler.deploy.json` (git-ignored) before deploying from it. With Workers Builds, set these as **build variables** (Settings → Build → Variables and secrets) and set the deploy command to `npm run deploy`. For non-production branch builds, use `npm run deploy:preview`.

| Variable                         | Effect                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASEBAR_DOMAIN`              | Custom domain (bare host, such as `releasebar.example.com`); also sets the Worker var `RELEASEDECK_CANONICAL_DOMAIN`. Its zone must be in the deploying account. Unset: no custom domain. |
| `RELEASEBAR_KV_NAMESPACE_ID`     | ID of a pre-created `DASHBOARD_CACHE` namespace. Unset: Wrangler creates one on the first deploy, without a jurisdiction.                                                                 |
| `RELEASEBAR_DO_JURISDICTION`     | Jurisdiction for every `DASHBOARD_LOCKS` Durable Object, such as `eu`. Requires `RELEASEBAR_KV_NAMESPACE_ID`, so KV is never created outside it.                                          |
| `RELEASEBAR_ADMIN_LOGINS`        | Comma-separated GitHub logins for `/_admin` (Worker var `ADMIN_LOGINS`).                                                                                                                  |
| `RELEASEBAR_WORKERS_DEV`         | `true` or `false`: whether the Worker is also served on `workers.dev`. Unset: as in `wrangler.toml`.                                                                                      |
| `RELEASEBAR_ANTHROPIC_BASE_URL`  | `https://` base URL of the Messages API endpoint for AI summaries (Worker var `ANTHROPIC_BASE_URL`), such as a gateway. Unset: `https://api.anthropic.com`.                               |
| `RELEASEBAR_SUMMARY_INPUT_CHARS` | Characters a release summary sends the model in all, from 1,000 to 400,000 (Worker var `RELEASE_SUMMARY_INPUT_CHARS`). Unset: 48,000.                                                     |
| `RELEASEBAR_SUMMARY_TITLE_CHARS` | Characters of each commit title in a release summary, from 20 to 1,000 (Worker var `RELEASE_SUMMARY_TITLE_CHARS`). Unset: 160.                                                            |
| `RELEASEBAR_SUMMARY_BODY_CHARS`  | Characters of each commit message body in a release summary, from 0 (titles only) to 20,000 (Worker var `RELEASE_SUMMARY_BODY_CHARS`). Unset: 1,000.                                      |

`npm run deploy` fails when none of these is set, so a lost build variable can't silently drop a deployment's domain and admins. Set `RELEASEBAR_ALLOW_GENERIC=true` to deploy the generic `wrangler.toml` on purpose.

The queues `releasebar-refresh` and `releasebar-refresh-dlq` must exist before the first deploy. To keep all data in one jurisdiction, create the queues and the KV namespace in it, and set the same jurisdiction for Durable Objects; a jurisdiction can't be changed once a resource exists:

```sh
npx wrangler queues create releasebar-refresh --jurisdiction eu
npx wrangler queues create releasebar-refresh-dlq --jurisdiction eu
npx wrangler kv namespace create releasebar-dashboard-cache --jurisdiction eu
```

Secrets (`GITHUB_TOKEN`, `AUTH_COOKIE_SECRET`, the GitHub App keys, `ANTHROPIC_API_KEY`) are Worker secrets, not build variables: set them under the Worker's Settings → Variables and Secrets or with `wrangler secret put`. Deploys keep them.

No host is compiled in. `RELEASEDECK_CANONICAL_DOMAIN` sets the domain in page titles, the canonical link, social cards, dashboard payloads and the browser's fallback API origin; the app shell passes it to the frontend in a `releasebar:canonical-domain` meta tag. Unset, page titles, the canonical link and social cards use the request's host, while dashboard payloads and scheduled refreshes, which have no request, fall back to `localhost`; set `RELEASEBAR_DOMAIN` in production.

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

Set the GitHub App setup URL to `https://<your-domain>/api/auth/install` and enable redirect-on-update. Set the webhook URL to `https://<your-domain>/api/github/webhook`, use the same webhook secret in GitHub and Cloudflare, and subscribe to Issues, Pull requests, Push, Releases, and Repository events.

Signed webhook payloads up to 2 MiB enter Cloudflare Queue before acknowledgement. Issue and pull-request bursts coalesce into authoritative count refreshes; push and release bursts coalesce into release refreshes. Privacy and archive transitions remain separate so visibility changes apply promptly.

## AI summaries

Set `ANTHROPIC_API_KEY` as a Worker secret to summarize public owner activity and the commits since the latest release:

```sh
wrangler secret put ANTHROPIC_API_KEY
```

`ANTHROPIC_SUMMARY_MODEL` is optional and defaults to `claude-haiku-5-5`. Summaries run server-side through the Anthropic Messages API, remain subordinate to public source data, and are cached with the model and prompt version.

A release summary reads each commit's title and message body, without its closing trailers such as `Signed-off-by`. Anyone can have any public repository summarized, so its input is capped whatever the commits hold: titles take up to half of `RELEASEBAR_SUMMARY_INPUT_CHARS`, newest commits first, and bodies get the rest. `npm run deploy` rejects a limit outside its bounds; a Worker var set directly is clamped to them, and ignored unless it is a whole number. A changed limit applies to summaries made after it, not to cached ones.

To send summaries to another endpoint that speaks the Messages API, such as Cloudflare AI Gateway or a proxy, set the build variable `RELEASEBAR_ANTHROPIC_BASE_URL` (or the Worker var `ANTHROPIC_BASE_URL` directly). The client appends `/v1/messages` to it and sends `ANTHROPIC_API_KEY` in the `x-api-key` header.

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
