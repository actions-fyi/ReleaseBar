Work style: terse.

## Fork

- This is the actions-fyi fork of steipete/ReleaseBar, imported at upstream commit 73fefa1. It no longer follows upstream: the stack migration below replaces the build, the tests and the data layer, so upstream changes are ported by hand if wanted.
- No GitHub Releases, tags or version bumps here: the fork deploys a service and publishes nothing.

## Deploy

- Canonical prod: Cloudflare Worker + Worker Assets at `releasebar.actions.fyi`. Worker name: `releasebar`.
- Repo/product name: ReleaseBar. Config file: `releasebar.config.json`.
- Not GitHub Pages. No deploy workflow: Cloudflare's GitHub app (Workers Builds) runs `npm run deploy` on every push to `main`. GitHub holds no Cloudflare token.
- `wrangler.jsonc` stays generic: no domain, admin login, account or resource ID. Deployment values are Workers Builds build variables (`RELEASEBAR_*`, see `docs/self-hosting.md`), which `npm run deploy` writes into the git-ignored `wrangler.deploy.json`.
- `worker-configuration.d.ts` is generated: run `npm run types` after changing `wrangler.jsonc` or updating Wrangler. `npm run typecheck` fails when it is stale. Variables and secrets set outside the config are typed in `worker/env.d.ts`.
- Gates on pull requests: the org ruleset workflow Test TypeScript (`typecheck`, `lint`, `format:check`, `build`, `test` scripts) and `.github/workflows/cloudflare.yml` (`wrangler deploy --dry-run`).
- `npm run build` must stay offline. `npm run build:data` fetches real dashboard data from GitHub.
- Wrangler is a locked devDependency. Never run it with `npm exec --yes` or `npx --yes`.
- Prod data lives in the EU: queues and KV namespace created with `--jurisdiction eu`, `RELEASEBAR_DO_JURISDICTION=eu`.
- Local real-data dev: `npm run dev:worker:real` uses Wrangler `--remote` on port 8787 with real secrets.
- Static proof: `npm run check:static`.
- Dependency updates come from Renovate, not Dependabot.

## Stack migration

Nothing is in production use, so there is no data migration and no compatibility code: old keys and old Durable Object data are dropped, and legacy fallbacks are deleted, not ported.

Steps, one pull request each, in order; 7a to 7c may run in parallel. Tick a step in the pull request that completes it.

- [x] 1 Ground rules: this section.
- [x] 2 Config and types: `wrangler.jsonc`, types from `wrangler types`, handlers `satisfies ExportedHandler<Env>`.
- [ ] 3 Test runner: Vitest in the Workers runtime; tests import TypeScript sources, no compile step.
- [ ] 4 Single build: Cloudflare Vite plugin v1, one `vite build`, one `vite dev`; shared code moves from `scripts/lib` to `shared/`.
- [ ] 5 Durable Objects: classes that extend `DurableObject`, typed RPC methods, SQLite tables.
- [ ] 6 Store layer: `worker/store/` is the only code that touches a binding; D1 binding added.
- [ ] 7a Refresh data to D1: targets, target index, jobs, deliveries, scheduler state.
- [ ] 7b Audit and counters to D1: audit logs, sign-in funnel, client timing.
- [ ] 7c Auth and registry to D1: installations, GitHub access, owner metadata, hidden lists.
- [ ] 8 Cleanup: legacy readers and the fake-binding test harness go; docs updated; sampled traces on.

Conventions. Each applies from the step that introduces it; until then the old code stands.

- Target layout: `src/` app, `worker/`, `shared/`, `test/`.
- Binding and runtime types are generated, never hand-written (from 2).
- Durable Objects expose RPC methods; no `stub.fetch` and no URL routing inside one (from 5).
- Only `worker/store/` reads or writes KV, D1 or a Durable Object (from 6).
- KV holds cached payloads and short-lived entries only. Anything queried, listed or counted is in D1; anything that must be checked and changed in one step is in a Durable Object (from 7).
- D1, KV and queues are created with `--jurisdiction eu`; a jurisdiction can't be added later.
- Every step leaves `main` deployable and keeps the script names CI calls: `typecheck`, `lint`, `format:check`, `build`, `test`.
- A step stays in its scope: a problem that belongs to a later step is reported, not fixed.
