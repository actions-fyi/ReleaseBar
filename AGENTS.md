Work style: terse.

## Fork

- This is the actions-fyi fork of steipete/ReleaseBar, imported at upstream commit 73fefa1. Keep the diff against upstream small, so its changes stay easy to bring in.
- No GitHub Releases, tags or version bumps here: the fork deploys a service and publishes nothing.

## Deploy

- Canonical prod: Cloudflare Worker + Worker Assets from `wrangler.toml`, at `releasebar.actions.fyi`. Worker name: `releasebar`.
- Repo/product name: ReleaseBar. Config file: `releasebar.config.json`.
- Not GitHub Pages. No deploy workflow: Cloudflare's GitHub app (Workers Builds) builds and deploys every push to `main`. GitHub holds no Cloudflare token.
- Gates on pull requests: the org ruleset workflow Test TypeScript (`typecheck`, `lint`, `format:check`, `build`, `test` scripts) and `.github/workflows/cloudflare.yml` (`wrangler deploy --dry-run`).
- `npm run build` must stay offline. `npm run build:data` fetches real dashboard data from GitHub.
- Wrangler is a locked devDependency. Never run it with `npm exec --yes` or `npx --yes`.
- Admin logins: `ADMIN_LOGINS` in `wrangler.toml`. Canonical domain: `RELEASEDECK_CANONICAL_DOMAIN` there, kept in step with the `[[routes]]` pattern; no host is hard-coded elsewhere.
- Local real-data dev: `npm run dev:worker:real` uses Wrangler `--remote` on port 8787 with real secrets.
- Static proof: `npm run check:static`.
- Dependency updates come from Renovate, not Dependabot.
