Work style: terse.

## Fork

- This is the actions-fyi fork of steipete/ReleaseBar, imported at upstream commit 73fefa1. Keep the diff against upstream small, so its changes stay easy to bring in.
- No GitHub Releases, tags or version bumps here: the fork deploys a service and publishes nothing.

## Deploy

- Canonical prod: Cloudflare Worker + Worker Assets at `releasebar.actions.fyi`. Worker name: `releasebar`.
- Repo/product name: ReleaseBar. Config file: `releasebar.config.json`.
- Not GitHub Pages. No deploy workflow: Cloudflare's GitHub app (Workers Builds) runs `npm run deploy` on every push to `main`. GitHub holds no Cloudflare token.
- `wrangler.toml` stays generic: no domain, admin login, account or resource ID. Deployment values are Workers Builds build variables (`RELEASEBAR_*`, see `docs/self-hosting.md`), which `npm run deploy` writes into the git-ignored `wrangler.deploy.json`.
- Gates on pull requests: the org ruleset workflow Test TypeScript (`typecheck`, `lint`, `format:check`, `build`, `test` scripts) and `.github/workflows/cloudflare.yml` (`wrangler deploy --dry-run`).
- `npm run build` must stay offline. `npm run build:data` fetches real dashboard data from GitHub.
- Wrangler is a locked devDependency. Never run it with `npm exec --yes` or `npx --yes`.
- Prod data lives in the EU: queues and KV namespace created with `--jurisdiction eu`, `RELEASEBAR_DO_JURISDICTION=eu`.
- Local real-data dev: `npm run dev:worker:real` uses Wrangler `--remote` on port 8787 with real secrets.
- Static proof: `npm run check:static`.
- Dependency updates come from Renovate, not Dependabot.
