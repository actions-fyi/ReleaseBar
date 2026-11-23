Work style: terse.

## Fork

- This is the actions-fyi fork of steipete/ReleaseBar, imported at upstream commit 73fefa1. It no longer follows upstream: the stack migration below replaces the build, the tests and the data layer, so upstream changes are ported by hand if wanted.
- No GitHub Releases, tags or version bumps here: the fork deploys a service and publishes nothing.

## Deploy

- Canonical prod: Cloudflare Worker + Worker Assets at `releasebar.actions.fyi`. Worker name: `releasebar`.
- Repo/product name: ReleaseBar. Config file: `releasebar.config.json`.
- Not GitHub Pages. No deploy workflow: Cloudflare's GitHub app (Workers Builds) runs `npm run deploy` on every push to `main`. GitHub holds no Cloudflare token.
- `wrangler.jsonc` stays generic: no domain, admin login, account or resource ID. Deployment values are Workers Builds build variables (`RELEASEBAR_*`, see `docs/self-hosting.md`), which the Vite build writes into the config it emits for the deploy, `dist/releasebar/wrangler.json` (`vite.config.ts`, `shared/deploy-config.ts`). `npm run deploy` checks them, builds, applies the D1 migrations (`npm run deploy:migrations`, from that file) and runs `wrangler deploy`, which follows `.wrangler/deploy/config.json` to that file.
- One build: `npm run build` is `vite build` with the Cloudflare Vite plugin. It builds the app to `dist/client` and the Worker, from `worker/index.ts`, to `dist/releasebar`. `npm run dev` is `vite dev`: app and Worker on one server, in the Workers runtime. Scripts under `scripts/` run as TypeScript on Node.js, without a compile step; imports name the `.ts` file.
- `worker-configuration.d.ts` is generated: run `npm run types` after changing `wrangler.jsonc` or updating Wrangler. `npm run typecheck` fails when it is stale. Variables and secrets set outside the config are typed in `worker/env.d.ts`.
- Gates on pull requests: the org ruleset workflow Test TypeScript (`typecheck`, `lint`, `format:check`, `build`, `test` scripts) and `.github/workflows/cloudflare.yml` (`wrangler deploy --dry-run` on a fresh checkout: it reads `wrangler.jsonc`, runs its `build.command` and bundles `worker/index.ts` with Wrangler's own bundler, not Vite's).
- `npm run build` must stay offline. `npm run build:data` fetches real dashboard data from GitHub.
- Wrangler is a locked devDependency. Never run it with `npm exec --yes` or `npx --yes`.
- Prod data lives in the EU: queues, KV namespace and D1 database created with `--jurisdiction eu`, `RELEASEBAR_DO_JURISDICTION=eu`.
- Every deploy names its D1 database: `RELEASEBAR_D1_DATABASE_ID`. Without it `npm run deploy` refuses, because Wrangler would create a database for a binding with no ID by itself, outside any jurisdiction.
- D1 schema: SQL files in `migrations/`, applied by `npm run deploy` before the Worker deploy and by the tests before each test. An applied file is never edited. `docs/data-model.md` says which data is in KV, D1 or a Durable Object, and which store module owns it.
- Local real-data dev: `npm run dev:worker:real` uses Wrangler `--remote` on port 8787 with real secrets. It reads `wrangler.jsonc`, not the Vite build's config.
- Static proof: `npm run check:static`.
- Tests: `npm test` runs Vitest with coverage; `vitest.config.ts` has a `workers` project (Workers runtime, bindings from `wrangler.jsonc`) and a `node` project for the files it lists. Tests import the TypeScript sources; no build first. One file or test: `npx vitest run <file> -t <name>`.
- Durable Objects in tests are the real local ones: `testEnv` of `test/dashboard-test-harness.ts` adds the runtime's bindings to a test's env, and `test/reset-storage.ts` empties all storage after each test. A test that gives no queue gets the runtime's local one; a test that asserts on what a queued job did uses `testQueue`, which delivers to the queue handler with the test's env. To make an object busy or failing, spy on the class prototype (`buildLocksHeld`, `objectsUnavailable`, `vi.spyOn(BuildCoordinator.prototype, ...)`); never build a fake namespace.
- Durable Object classes live in `worker/objects/`, one file each. A class change needs a new entry in `migrations` of `wrangler.jsonc`, never an edit of an applied one, and the binding in `durableObjectBindings` of `worker/store/bindings.ts`, which scopes it to the jurisdiction.
- Bindings are named only in `worker/store/`, one module per data family; `npm run lint` fails otherwise (`npm run check:store`). Everything else, the Durable Object classes included, calls a store function, named for what it does. A Durable Object's own env is the raw one: scope it with `withLockJurisdiction` before work that reaches another object.
- Dependency updates come from Renovate, not Dependabot.

## Stack migration

Nothing is in production use, so there is no data migration and no compatibility code: old keys and old Durable Object data are dropped, and legacy fallbacks are deleted, not ported.

Steps, one pull request each, in order; 7a to 7c may run in parallel. Tick a step in the pull request that completes it.

- [x] 1 Ground rules: this section.
- [x] 2 Config and types: `wrangler.jsonc`, types from `wrangler types`, handlers `satisfies ExportedHandler<Env>`.
- [x] 3 Test runner: Vitest in the Workers runtime; tests import TypeScript sources, no compile step.
- [x] 4 Single build: Cloudflare Vite plugin v1, one `vite build`, one `vite dev`; shared code moves from `scripts/lib` to `shared/`.
- [x] 5 Durable Objects: classes that extend `DurableObject`, typed RPC methods, SQLite tables.
- [x] 6 Store layer: `worker/store/` is the only code that touches a binding; D1 binding added.
- [ ] 7a Refresh data to D1: targets, target index, jobs, deliveries, scheduler state, profile snapshots.
- [x] 7b Audit and counters to D1: refresh audit log with client timing, GitHub call counts, sign-in funnel; request rate limits to a Durable Object.
- [ ] 7c Auth and registry to D1: installations, owner metadata, dashboard profiles with their added and hidden owners and repositories.
- [ ] 8 Cleanup: legacy readers and the fake-binding test harness go; docs updated; sampled traces on.

Conventions. Each applies from the step that introduces it; until then the old code stands.

- Target layout: `src/` app, `worker/`, `shared/`, `test/`.
- Binding and runtime types are generated, never hand-written (from 2).
- Durable Objects expose RPC methods; no `stub.fetch` and no URL routing inside one (from 5).
- Only `worker/store/` reads or writes KV, D1, the queue, the assets or a Durable Object (from 6).
- The queue binding is required: no code path for a Worker without it (from 6).
- KV holds cached payloads and short-lived entries only. Anything queried, listed or counted is in D1; anything that must be checked and changed in one step is in a Durable Object (from 7).
- D1, KV and queues are created with `--jurisdiction eu`; a jurisdiction can't be added later.
- Every step leaves `main` deployable and keeps the script names CI calls: `typecheck`, `lint`, `format:check`, `build`, `test`.
- A step stays in its scope: a problem that belongs to a later step is reported, not fixed.
