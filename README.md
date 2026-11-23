# ReleaseBar 📦 — Know what needs a release.

[![Node.js](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![License](https://img.shields.io/github/license/actions-fyi/ReleaseBar?style=flat-square)](LICENSE)

ReleaseBar is a release-freshness dashboard for public GitHub users and organizations. It combines releases, unreleased commits, repository activity, CI, and open work so maintainers can see which projects need attention.

This is the actions-fyi fork of [steipete/ReleaseBar](https://github.com/steipete/ReleaseBar).

## Install

ReleaseBar runs as a Cloudflare Worker. To deploy your own, see [self-hosting](docs/self-hosting.md). To run the source locally:

```sh
git clone https://github.com/actions-fyi/ReleaseBar.git
cd ReleaseBar
npm ci
```

ReleaseBar requires Node.js 22.12 or newer. Node.js 24 is the version used by CI.

## Quick start

With the development server running (`npm run dev`), open a dashboard for any public GitHub owner, such as `http://127.0.0.1:5173/steipete`, or read the same cached data from the API. On a deployment, use its domain instead.

```sh
curl -fsSL http://127.0.0.1:5173/api/steipete \
  | jq '{owners: [.owners[].login], repositories: (.projects | length), cache: .cache.state}'
```

The response may initially report `partial` or `stale` while deeper release and CI data hydrates in the background.

## Dashboards

| Route              | Shows                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| `/`                | Recently requested public dashboards                                                    |
| `/:owner`          | Release health for one GitHub user or organization                                      |
| `/:owner/activity` | Day, week, or month public activity grouped by repository                               |
| `/:owner/:repo`    | Release cadence, contributors, languages, churn, open work, and recent audience signals |

Dashboard settings can add public owners, organizations, or explicit repositories to the current URL. Query parameters cover shareable filters such as `forks=true`, `archived=true`, `unreleased=false`, `owners=openclaw,steipete`, and `repos=owner/name`.

See the [product guide](docs/product-guide.md) for login, GitHub App, filtering, attention, trust, and repository-detail behavior.

## Freshness and public data

Owner dashboards return lightweight public repository metadata first, then hydrate release, commit, pull-request, and CI data in bounded background batches. Cached data remains visible during GitHub outages or rate limits, and each payload reports whether its data is fresh, stale, partial, warming, or errored.

ReleaseBar ignores private repositories even when a GitHub App installation includes them. Installing the app supplies dedicated GitHub API quota for covered public sources; it does not turn ReleaseBar into a private-repository browser or a GitHub write proxy.

## API

The Worker exposes cached public endpoints for owner dashboards, activity, repository details, audience signals, and public GitHub profile context. Swagger-compatible OpenAPI 3.1 is served at `/openapi.json` on every deployment.

See the [public API reference](docs/api.md) for response shapes, cache semantics, and agent guidance. The [refresh scheduler](docs/refresh-scheduler.md) describes background hydration, retries, quota selection, and webhook-driven refreshes.

## Self-hosting

Static builds use `releasebar.config.json`; the hosted service serves arbitrary public owner routes through the Cloudflare Worker API. See [Self-hosting and operations](docs/self-hosting.md) for configuration, local Worker modes, GitHub App setup, optional AI summaries, Cloudflare bindings, and deployment checks.

## Development

```sh
npm ci
npm run check:static
npm run dev
```

The Vite development server runs on `http://127.0.0.1:5173` and serves the app and the Worker, API routes included, in the Workers runtime.

Product direction and boundaries live in [VISION.md](VISION.md).

## License

MIT. See [LICENSE](LICENSE).
