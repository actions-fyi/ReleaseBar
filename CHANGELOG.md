# Changelog

## Unreleased

- The package manager is now pnpm instead of npm: `packageManager` of `package.json` pins pnpm 12.23.0, `pnpm-lock.yaml` replaces `package-lock.json` with the same versions, and `pnpm-workspace.yaml` lets the build scripts of esbuild and workerd run. Install with `pnpm install --frozen-lockfile` and run the scripts with `pnpm run <name>`. Workers Builds must run `pnpm run deploy` as its deploy command (`pnpm run deploy:preview` for other branches).
- The tests run on the real local bindings of the Workers runtime: the KV namespace, the D1 database, the queue, the assets and the Durable Objects. The fake KV namespace, the fake queue and the hook that gave each Durable Object the calling test's env are gone; a test sets its variables on the runtime's env and observes or fails a binding with a spy on the real one.
- The stack migration is finished. The readers of records nothing writes any more are gone: a session cookie that holds the whole session, a build-progress tombstone under the progress key, build progress in KV without the mark of an outage, and a queue message that carries its refresh target. A job whose snapshot can't be read is retried, not run from the message.
- D1 now checks the shape of the registry's JSON columns when a row is written (`migrations/0004_checks.sql`): the four lists of a dashboard profile and an installation's repository list must be JSON arrays, an owner's metadata snapshot a JSON object. The migration rebuilds the three tables with the same columns and indexes; the deploy log lists it as applied once.
- When the `RateLimiter` Durable Object can't be reached, the client timing endpoint drops the sample and answers 202, and an install callback that arrives without fresh state answers 503 with `Retry-After: 30` and asks GitHub nothing. Both answered 500 before.
- A refresh target nobody has opened for 90 days no longer counts toward the 512 targets one owner or repository may list while it waits to be deleted.
- The admin console's installation sync stays within the 50 D1 queries of the Workers free plan for as many installations as GitHub's listing gives it (999, 40 queries); it passed them at about 400. Installations and refresh targets are written 100 to a batch.
- Workers traces are on for one invocation in twenty (`observability.traces` in `wrangler.jsonc`). Invocation logs stay off and query strings stay redacted.
- The app's fallback API origin is the canonical domain or the page's own origin; on `localhost` it no longer points at port 8787.
- `docs/self-hosting.md` has a "First deploy" section a new deployment can follow by itself, and `docs/data-model.md` describes the finished state, with the KV key families that remain and the limits per invocation.
- The installation registry, the owner metadata and the dashboard profiles are now read and written for all the owners or accounts of a Worker invocation at once, so its D1 queries no longer grow with them: a scheduler tick over 120 owners sends 21 queries instead of 216, a dashboard build 12 whatever the number of owners it shows (36 before with nine), and a sign-in with 30 installed accounts 18 instead of more than 240. An owner's metadata is still written only if nothing else changed it since it was read. `docs/data-model.md` has the numbers per invocation.
- A Worker invocation now sends D1 a bounded number of queries, well under the 50 the Workers free plan allows. A scheduler tick stores the jobs it enqueues in one batch and a webhook stores its jobs 25 to a batch, instead of one statement each. The refresh audit events and GitHub call counts of a request, tick or queue job are written as one batch when its work is done, or every two minutes while it runs, so an event can show in the admin console up to two minutes after it happened. A tick that enqueues 20 jobs went from 54 queries to 14; a webhook page of 200 targets from about 400 to 10.
- The GitHub App installation registry, the owner metadata and the dashboard profiles are now in D1 (`migrations/0003_registry.sql`: tables `installations`, `owner_metadata`, `profiles`) instead of KV. Nothing is carried over: saved dashboard profiles are gone, and the registry and the owner metadata fill again from GitHub by themselves; the admin console's installation sync fills the registry at once. The `OwnerMetadata` Durable Object class and its `OWNER_METADATA` binding are deleted (migration `7c-registry` in `wrangler.jsonc`); a change to an owner's metadata is now written only if the row is still the one that was read, and applied again otherwise, so none is lost. Installations and owner metadata not written for 90 days are ignored and deleted by the scheduled handler, as KV expired them before. The admin console lists the 80 most recently updated installations, where it listed the first 80 by account name.
- The refresh audit log, the GitHub call counts and the sign-in funnel are now in D1 (`migrations/0002_audit.sql`), and the per-minute request limits of the client timing endpoint and the install callback are counted by a new Durable Object class, `RateLimiter` (migration `7b-rate-limits`). Concurrent requests no longer lose counts or pass a limit. The KV entries under `refresh:audit:v2:`, `github:access:v1:`, `auth:funnel:v1:`, `auth:funnel-counter:v1:`, `client:timing:rate:v1:` and `auth:install-callback:rate:v1:` are no longer read or written: the logs and counts start empty after the deploy, and the old entries expire by themselves. The scheduled handler deletes audit rows after 14 days and funnel rows after 90, as KV did. In the admin console, the GitHub access "buckets" now count rows per hour and route.
- Refresh targets, the index of the targets that show an owner or a repository, refresh jobs with their snapshots and delivery records, the scheduler state and profile snapshots are now tables of the D1 database (`migrations/0001_refresh.sql`) instead of KV entries. The deploy creates the tables before it deploys the Worker. Nothing is copied over: the KV entries under `refresh:target:`, `refresh:target-index:`, `refresh:job:`, `refresh:jobs:`, `refresh:job-deliveries:`, `refresh:state:`, `refresh:owner-count-cursor:` and `refresh:profile-snapshot:` are no longer read or written and expire by themselves, and a dashboard is scheduled again once it is opened.
- The Durable Object class `RefreshTargetIndex` and its binding `REFRESH_TARGET_INDEX` are gone: migration `7a-refresh` in `wrangler.jsonc` deletes the class with everything it stored. A webhook now finds the dashboards to refresh with one query, and a dashboard is listed under all of its owners and repositories or under none.
- D1 keeps a row until it is deleted, so each scheduler tick deletes up to 500 rows of each kind that are past their lifetime: refresh targets nobody has opened for 90 days, jobs and delivery records not updated for 14 days, and profile snapshots older than 90 days. A target used to live for as long as it kept being refreshed; it now ends 90 days after its dashboard was last opened.
- The admin console lists the refresh targets that are due soonest, not the first ones by key.
- All access to KV, the queue, the assets and the Durable Objects now goes through a store layer, `worker/store/`, one module per data family. `npm run lint` fails when code outside it names a binding. Nothing is stored differently yet; `docs/data-model.md` says what moves to D1 next.
- The Worker is bound to a D1 database, `DB`, which holds no table yet. Every deploy must name it with the build variable `RELEASEBAR_D1_DATABASE_ID`: create it first (`wrangler d1 create <name> --jurisdiction eu`), because `npm run deploy` now refuses without it rather than let Wrangler create one outside a jurisdiction. `RELEASEBAR_ALLOW_GENERIC` is gone: a deployment with only the database ID set is the generic one. The deploy applies the SQL files of `migrations/` before it deploys the Worker, so the build's API token needs D1 Edit.
- The refresh queue is required. The Worker no longer builds dashboards or runs refresh jobs inside the request when it has no queue, the webhook endpoint no longer answers 503 for one, and the admin console no longer reports a "direct fallback" mode.
- The single `DashboardBuildLock` Durable Object class is replaced by six classes that extend `DurableObject`, are called through typed RPC methods and keep their state in SQLite tables: `BuildCoordinator`, `RefreshTargetIndex`, `OwnerMetadata`, `WebhookAdmission`, `WebhookProcessor` and `SummaryQuota`. Migration `v2` in `wrangler.jsonc` creates them and deletes `DashboardBuildLock` with everything it stored: locks, job reservations, scan checkpoints, webhook deduplication and the AI summary counters start empty after the deploy. The `DASHBOARD_LOCKS` binding is gone; the six new bindings are required, and the Worker no longer handles a missing one. `RELEASEBAR_DO_JURISDICTION` applies to all of them, now also to the objects a webhook reaches while it is processed.
- The app and the Worker are now built by one `vite build` with the Cloudflare Vite plugin, and `npm run dev` serves both from one server in the Workers runtime; `npm run dev:worker` is gone. `npm run deploy` still takes the deployment from `RELEASEBAR_*` variables, which the build now writes into `dist/releasebar/wrangler.json` instead of `wrangler.deploy.json`. Static assets are built to `dist/client`, without the unused `404.html`. Shared code moved from `scripts/lib` to `shared/` and the tests to `test/`; scripts run as TypeScript on Node.js 22.18 or later, without a compile step.
- The Wrangler config is now `wrangler.jsonc`, with `compatibility_date` 2026-11-23 and source maps uploaded on deploy. Binding and runtime types are generated by `npm run types` into `worker-configuration.d.ts`; the Worker no longer handles a missing KV or assets binding.
- Signed-in users get a list of their dashboards in the account menu and the command palette: their own first, then one for each organization they installed the GitHub App on. A user's or organization's dashboard now only lists repositories that account owns, unless the dashboard adds another owner or repository itself.
- AI summaries are now generated only for signed-in users, and each user is limited to 30 generated summaries per hour, with 1,000 per day for all users together. Anonymous visitors and crawlers still get cached summaries; where none is cached they see "Sign in to generate this AI summary." Set the build variables `RELEASEBAR_SUMMARY_USER_HOURLY_LIMIT` and `RELEASEBAR_SUMMARY_GLOBAL_DAILY_LIMIT` to change the limits within their bounds.
- The commit titles a release summary sends the model are now capped whatever the commits hold: 48,000 characters in all and 160 per title by default, keeping the newest commits. Set the build variables `RELEASEBAR_SUMMARY_INPUT_CHARS` and `RELEASEBAR_SUMMARY_TITLE_CHARS` to change them within their bounds.
- A failed AI summary now shows "AI summary failed; retrying later." instead of the provider's raw error response, which visitors could see. The real error goes to the Worker logs (`summary_failed`). The summary is retried after 5 minutes, and the wait doubles with each failure in a row, up to 6 hours.
- AI summaries can use another Messages API endpoint, such as a gateway: set the build variable `RELEASEBAR_ANTHROPIC_BASE_URL` (Worker var `ANTHROPIC_BASE_URL`). Unset, they go to `api.anthropic.com` as before.
- Turned off Workers invocation logs, so request headers, client IPs and locations are no longer stored; the Worker's own logs, exceptions and Issues remain.
- Query strings are now stripped from request URLs in Workers logs and traces, so OAuth codes never reach them.
- Turned on Workers Issues, which groups exceptions and failed invocations; traces stay off.
- `wrangler.jsonc` (formerly `wrangler.toml`) no longer carries a deployment: `npm run deploy` takes the custom domain, KV namespace ID, admin logins and Durable Object jurisdiction from `RELEASEBAR_*` environment variables (Workers Builds build variables). `RELEASEBAR_DO_JURISDICTION` (such as `eu`) keeps every Durable Object in that jurisdiction.
- Moved to `releasebar.actions.fyi`. Page titles, the canonical link, social cards and the frontend's fallback API origin now follow `RELEASEDECK_CANONICAL_DOMAIN` instead of a hard-coded host; when it is unset, pages use the request's host and payloads `localhost`.
- Switched AI summaries from the OpenAI Responses API to the Anthropic Messages API (`claude-haiku-5-5` by default); the Worker now reads `ANTHROPIC_API_KEY` and `ANTHROPIC_SUMMARY_MODEL`.
- Keep login, logout, and install redirects on this site when return paths normalize to protocol-relative URLs. Thanks @SebTardif.
- Refresh compatible formatting, lint, and frontend build tooling. Thanks @dependabot.

- Refresh Svelte, Bits UI, type checking, formatting, and lint tooling with compatible fixes while preserving Node.js 22.12 support. Thanks @dependabot.

## 0.2.6 - 2026-10-23

**Highlights:** Refresh Bits UI with compatible upstream fixes and update dashboard build tooling.

- Refresh the Svelte checker, UI dependencies, and build tools with compatible upstream fixes. Thanks @dependabot.

## 0.2.5 - 2026-10-16

**Highlights:** Fixed a source-map-js denial-of-service vulnerability (CVE-2026-93749) and updated UI dependencies for interaction and rendering fixes.

- Updated source-map-js to fix denial of service from malicious indexed source maps (CVE-2026-93749). Thanks @dependabot.
- Updated Bits UI and Svelte with upstream interaction and rendering fixes, refreshed the Vite integration and build tools, and updated Node.js type definitions. Thanks @dependabot.
- Updated Vite, Oxfmt, Oxlint, and Node.js type definitions, and refreshed CI and release setup/artifact actions. Thanks @dependabot.

## 0.2.4 - 2026-09-22

**Highlights:** Malformed URLs no longer crash requests, and updated UI dependencies improve accessibility and rendering reliability.

- Reject malformed URL path encoding with a non-cacheable HTTP 400 instead of crashing page, API, and social-card requests; share page route parsing between the browser and Worker.
- Updated Bits UI, Svelte, and Valibot with upstream accessibility, event cleanup, rendering, reactivity, and validation fixes.
- Reworked the README into a concise product and quick-start guide, with detailed behavior and self-hosting operations moved into focused docs.
- Updated Vite, Oxfmt, Oxlint, and Node.js type definitions, and refreshed compatible transitive dependencies.

## 0.2.3 - 2026-08-01

- Refreshed the dashboard design: the UI now ships JetBrains Mono (previously only used for social cards), uppercase micro-labels gained consistent letterspaced styling, dashboard rows show a freshness-colored edge bar and a freshness-tinted state tag, missing commit counts render quietly instead of as large red `n/a`, active filters/periods glow green, big numerals got heavier weights with a subtle phosphor glow, dark mode gained faint CRT scanlines, and the light theme received matching contrast and polish.
- Updated the frontend compiler, build tools, static-analysis tools, type definitions, and CI Node setup to their latest stable releases.
- Refreshed the Cloudflare Workers compatibility date after verifying the newly enabled TLS option validation does not affect ReleaseBar.

## 0.2.2 - 2026-07-04

- Kept GitHub logins alive by storing and rotating GitHub App refresh tokens, so expiring eight-hour user access tokens renew automatically instead of silently degrading until the next login.
- Stopped `/api/me` from rewriting the stored session and installation caches on every request and made those cache writes best-effort, so concurrent tabs (for example after a browser restart) no longer trip Workers KV write limits and render a logged-in user as logged out.

## 0.2.1 - 2026-06-19

- Made anonymous GitHub actions log in first, then detect existing App installations before offering installation for uncovered dashboards.
- Split the Worker, frontend, dashboard library, styles, and tests into bounded domain modules and added a CI guard that keeps maintained files below 1,000 lines.
- Served stale Hot dashboards immediately while a durable background refresh rebuilds them with bounded concurrent cache reads, and replaced deletion-prone webhook invalidation with timestamp markers to remove periodic multi-second stalls.
- Warmed missing, stale, or incomplete public owner caches immediately after GitHub login or App installation so source-owned installation quota can benefit later anonymous viewers.
- Prominently offers GitHub App installation whenever dashboard, repository, activity, trust, or audience requests hit GitHub rate limits, including for already signed-in users and cached quota failures.
- Widened the logged-out GitHub App action so its full label remains visible on desktop while preserving the compact mobile label.
- Reduced shared GitHub quota pressure by partitioning mixed-owner dashboards across per-account GitHub App tokens, bundling App-backed repository core data into GraphQL, revalidating stale REST caches with ETags, coalescing concurrent detail builds, extending webhook-invalidated caches, and deferring nonessential enrichment before the shared bucket becomes critical.
- Updated CI and local tooling to Node.js 24 LTS and refreshed the Worker compatibility date.
- Hid contributor-fork activity when the upstream repository belongs to the activity profile, while preserving unrelated external project work.
- Kept scheduler and admin scans within Workers KV operation limits by rotating bounded current-schema target pages, and reduced authenticated repository work-trend requests from four REST searches to one GraphQL query.
- Kept the admin console responsive by loading scheduler, quota, and installation summaries independently and bounding installation and auth-counter samples while preserving their totals.

## 0.2.0 - 2026-06-13

- Condensed owner dashboard activity totals, ranked repositories, metadata, and drill-down navigation into a responsive two-row digest.
- Collapsed repository event logs by default on owner activity pages so the ranked summaries stay compact until expanded.
- Expanded high-signal repository activity summaries to one or two short sentences while compacting the single batched AI request and using a repository-aware output ceiling with a reasoning-model compatibility floor.
- Added `/owner/activity` drill-down pages and a documented `GET /api/:owner/activity` OpenAPI endpoint with day, week, and month views, repository ranking by actual activity volume, grouped event logs, overall AI summaries, and bounded per-repository AI summaries while preserving repositories named `activity` under escaped detail routes.
- Added shared per-owner metadata snapshots with lean 15-minute issue/PR count refreshes, fresh-cache responses before GitHub App token discovery, four-repository release hydration concurrency, independent count/release/CI timestamps, signed GitHub webhooks for issue, pull request, push, release, and archive updates, and stricter archived-repository removal from status views.
- Prioritized webhook-triggered push and release refreshes by recent dashboard activity and skipped eager deep hydration for variants not viewed in the last day, reducing stale archived and fork variant queue and GitHub quota pressure.
- Coalesced per-owner webhook bursts so issue and pull request events for the same repository share one authoritative count refresh, push and release bursts share one release refresh, follower deliveries stop contending behind active processing, and terminal fanout deliveries are acknowledged after durable deduplication cleanup.
- Returned current issue and PR counts before deep release scans when authenticated GitHub quota provides an exact split, marked anonymous REST splits unavailable without per-repository fan-out, moved progressive dashboard hydration to deadline-bounded Queue consumers with Durable Object checkpoints and strongly consistent target backoff state, removed stale cross-request build promises that could freeze scan progress, reduced oversized owner release GraphQL pages without changing prerelease selection, moved audit writes off foreground responses, scoped short upstream backoffs by GraphQL operation, and parallelized admin access-log reads.
- Updated Svelte, Node.js type definitions, Oxfmt, and Oxlint to their latest compatible patch releases.

## 0.1.0 - 2026-06-11

- Bound GitHub OAuth callbacks to the initiating browser and capped return targets to prevent session-swapping attacks and oversized authorization requests.
- Kept asynchronously loaded GitHub connection state reactive so configured deployments show the install or connect action instead of a stale unavailable label.
- Kept dashboards from getting stuck on empty repositories by skipping check-run hydration when GitHub has no commit to check, and stopped passing the Actions `GITHUB_TOKEN` into deploy builds that do not need it.
- Stopped classifying human audience logins that merely end in `bot` as automation when GitHub account metadata does not identify them as bots. Thanks @devYRPauli.
- Clarified trust score tooltips for owner, organization, contributor, and stargazer signals. Thanks @vincent-peng.
- Made dashboard search match separate terms across repository metadata and release names. Thanks @tanish19078.
- Kept light-mode trust panels on theme-aware surfaces instead of dark translucent backgrounds. Thanks @shubh73.
- Kept verified crawlers and bot user agents from scheduling dashboard, repository, discover, trust, and activity refresh work while still serving cached or cold data.
- Made GitHub token-use audit counters durable so admin quota views reflect live Worker requests instead of only console logs.
- Recorded GitHub App install callbacks even when users start from GitHub's public app page, added install/login funnel counters, and exposed install sync coverage in the admin console.
- Routed public GitHub connection actions through GitHub App installation instead of OAuth sign-in, while still remembering installed app quota for anonymous dashboards.
- Kept the mobile status/action bar within the viewport in narrow embedded browsers by using fixed control columns and a shorter GitHub connect label.
- Reduced repository detail GitHub API usage by caching contributors, languages, releases, live status probes, stats, and issue/PR search counts across rebuilds, with short backoff for warming stats endpoints.
- Reduced crawler and scheduler GitHub quota waste with cache-only bot misses, repo-wide stats warmup backoff, longer issue/PR count caches, and dormant shared-target throttling.
- Deferred queued scheduler jobs during GitHub GraphQL backoff instead of recording avoidable failures.
- Hardened scheduler dashboard rebuilds against empty successful GitHub API responses.
- Added GitHub token-use monitoring to the admin console and reduced shared-token pressure with quota pause guards, GraphQL backoff, smaller discovery release batches, and capped shared owner scans.
- Improved mobile dashboards with fixed viewport scaling, a single-row status/theme/login header, denser repository cards, and softer light-mode row colors.
- Pointed social preview metadata at PNG cards and lengthened preview titles for better crawler compatibility.
- Embedded social card avatars into generated SVGs and added a monogram fallback when avatar fetching fails.
- Reduced GitHub Hot shared-token use by hydrating only release metadata instead of full per-repo commit, compare, pull request, and CI details.
- Reduced GitHub dashboard hydration work by using owner GraphQL commit/status data, prioritizing issue/PR-sorted rows, caching owner identity, and storing hourly GitHub access counters in KV.
- Split dashboard GraphQL hydration into a cheap owner metadata query plus a small CI rollup detail query to avoid large-owner GraphQL 502s.
- Placed dashboard cache status before the manual refresh button so the refresh action no longer interrupts the status text.
- Improved the mobile dashboard layout with scrollable filter/sort rails, compact repository cards, and tighter header/search controls.
- Added a manual dashboard refresh button that refreshes cheap issue and PR counts first, then continues release hydration in the background.
- Replaced the generic `</>` favicon with a green release-tag silhouette so the tab icon reads as ReleaseBar at 16px and aligns with the release/version brand.
- Added browser-side dashboard timing beacons for cached boot renders, API fetches, and streamed updates so client latency can be compared with Worker background tail duration.
- Logged dashboard sync, progressive refresh, stream delivery, and discover hydration phases so fast visible data and slower GitHub scans can be studied separately.
- Documented the refresh scheduler's target, queue, quota, retry, and admin audit behavior.
- Hardcoded admin access to @steipete and moved the admin console link into dashboard settings.
- Added a quota-aware background refresh scheduler with Cloudflare Queue wiring, cron ticks, audit logs, and an admin console for inspecting refresh targets and jobs.
- Refreshed live owner dashboard streams when issue or PR totals change so active dev sorting can reorder rows during background updates.
- Prioritized owner dashboard repository counts so issue and PR totals render before release and CI hydration finishes.
- Loosened repository evidence spacing between names and language labels.
- Hide repeated external-link markers in repository table cells until hover or keyboard focus.
- Kept the owner trust overview action aligned with the factors action by placing the trust tier before the button.
- Use compact sort arrows in dashboard table headers so narrow metric columns stay on one line.
- Show repository GitHub, release, issue, and PR links immediately while detail data loads.
- Reduced owner dashboard layout shift by rendering route-owner hero avatars before cached dashboard data arrives and reserving a stable account-menu width.
- Simplified owner trust navigation by removing the overview tab buttons and trimming the trust snapshot copy.
- Matched the trust tab's content spacing to the overview tab.
- Added a logged-in account menu and command palette shortcut for opening your own dashboard.
- Embed cached public dashboard and repository payloads in served app shells so warm routes render without an initial loading panel.
- Added OpenAPI/Swagger JSON endpoints for the public trust and audience APIs.
- Refined trust UI labels, audience percentage summaries, contributor score pills, and external-link markers.
- Documented the public REST API contract for cached trust profiles and repository audience signals, including agent PR-triage guidance.
- Added repository audience analysis from recent public stargazers, with week/month filters, cached trust/klout dimensions, public org signals, and recent repo evidence.
- Added bounded GitHub trust profiles to owner pages with account age, score dimensions, public orgs, and recent repository evidence.
- Added weighted trust-score factors so profile scores show the age, profile, org, reach, builder, recency, and account-safety inputs behind the number.
- Rebalanced trust scoring around trust, builder, reach, and positive account safety, dropping repository fit from the surfaced score.
- Added GitHub App-only audience backfill for repository stargazer trust caches, keeping batch warming off shared API quota.
- Moved detailed trust scoring into a profile tab and kept a compact trust snapshot on the main owner page.
- Skipped release hydration on unsynced public dashboards so stargazer profile links do not burn shared GitHub API quota.
- Clarify repository activity summaries by showing the selected activity range instead of a misleading commit count.
- Show repository names in full in repository detail hero titles, with owner context kept in the breadcrumb/avatar.
- Renamed the header wordmark and page-title suffix from `ReleaseBar` to `release.bar` to match the domain.
- Added a light mode theme with a sun/moon toggle in the top-right header; defaults to dark and persists per browser.
- Reused source-owned GitHub App installation quota for anonymous public dashboard refreshes and added structured token-use audit logs.
- Switched AI summaries to OpenAI's `chat-latest` API alias for GPT-5.5 Instant.
- Added recent-work AI summaries to repository detail pages, including unreleased repositories and a since-release toggle for released repositories.
- Made working-on AI summaries focus on concrete work instead of restating that the data came from GitHub activity.
- Linked working-on repository chips to ReleaseBar repository detail pages and tightened the activity heading spacing.
- Added a cached working-on activity block to owner dashboards with day, week, and month AI summaries from public GitHub events.
- Renamed the repository commit graph heading from last 52 weeks to last year.
- Made repository detail owner names less eager to truncate when the full owner/repo title can fit.
- Simplified the footer credit to a quieter Peter Steinberger link.
- Let repository detail metrics shrink to fit their card width before truncating long release tags.
- Retried warming repository detail statistics after 30 seconds instead of waiting five minutes.
- Kept long repository detail titles from overlapping the account controls by truncating owner and repository names in the hero.
- Added optional AI summaries of commit titles since the latest release on repository detail pages.
- Hid the code churn panel when GitHub code-frequency stats are unavailable.
- Fetched deeper repository release history so prerelease-heavy projects can still show recent stable releases.
- Rebuilt repository detail caches for the expanded release and stats metadata.
- Added owner avatars to repository detail hero headings.
- Made repository detail stat values shrink for long release names before truncating.
- Split repository detail releases into recent stable and prerelease groups.
- Fixed the repository detail grid so the final stats panel spans the full width instead of leaving an empty cell.
- Limited inline need-attention row text to repositories with an existing release and more than 200 commits since that release.
- Restored the package emoji in the README heading.
- Added clearer public dashboard profile state, public-only settings copy, need-attention reasons, scan progress, richer repo detail cadence/work trends, command actions, mobile row cards, longer stale cache retention, and broader deploy smoke checks.
- Refreshed README and agent notes for ReleaseBar routing, cache behavior, deploys, and renamed config.
- Updated project metadata and links for the renamed `steipete/ReleaseBar` repository.
- Added a footer with Peter Steinberger, GitHub, and MIT license links.
- Simplified the dev-mode toggle so the selected border carries the state without a duplicate checkbox glyph.
- Show visible repository rows before release data finishes scanning, then progressively hydrate them.
- Added avatar, release version, and commits-since-release detail to social cards.
- Added compact owner avatars to mixed-owner repository lists.
- Added GitHub owner avatars to owner dashboard hero headings.
- Added pointer cursors to account menu entries.
- Reduced oversized dashboard and repository detail headline typography.
- Fixed GitHub App install detection for signed-in users and stopped prompting installs for unrelated third-party repos.
- Made the account menu size to its content and softened oversized dashboard headlines.
- Added obvious GitHub, release, issue, and PR links to repository detail pages.
- Scanned release data for every repository shown on the GitHub Hot root dashboard instead of only the first batch.
- Kept the GitHub App menu state stable immediately after installation while GitHub installation data catches up.
- Added repo detail breadcrumbs back to the owner dashboard.
- Improved repository commit graph hover states with styled, keyboard-accessible tooltips.
- Added repository detail pages with cached releases, contributors, language mix, commit graphs, and churn stats.
- Clarified GitHub Hot release scan placeholders while background hydration is queued or skipped.
- Added a stars table column, repository topic tags, clearer GitHub Hot placeholders, and automatic release scanning for the top Hot repositories.
- Improved responsive table and settings controls, including a compact `since` header and centered settings close button.
- Let fresh public dashboard API responses use a short edge cache and compact JSON payloads.
- Kept dashboard cache entries longer, limited very old stale fallbacks, and auto-refreshed stale dashboards while rebuilds finish.
- Renamed the table `since` header to `commits since`.
- Combined the version and release table columns and removed version sorting.
- Added a GitHub Hot root dashboard backed by cached GitHub repository search, with today/week/month/year and language filters.
- Show signed-in GitHub avatars in the account menu trigger.
- Linked single-owner dashboard subtitles to the GitHub user or organization.
- Progressively cache API owner scans in 12-repository batches so huge organizations show rows while the dashboard keeps updating.
- Improved version-column wrapping so long release tags do not collide with release dates in dev mode.
- Made project owners link to their ReleaseBar dashboards while repository names still open GitHub.
- Show cached partial source data while cold combined dashboards rebuild in the background.
- Added owner-only public dashboard defaults so saved sources and visibility apply at clean owner URLs.
- Added a close button to the dashboard settings panel.
- Kept the dashboard timestamp compact and moved cache/quota details into an accessible tooltip.
- Exposed GitHub API quota source, remaining calls, and reset time in dashboard cache status.
- Reduced GitHub API fanout with GraphQL repository metadata, KV-backed repo fragments, and Durable Object rebuild locking.
- Made repository language tags clickable filters and exposed language filters in the command palette.
- Added a dedicated loading state while empty dashboards are still being fetched and cached.
- Improved account dropdown menu vertical alignment and item spacing.
- Replaced GitHub Pages deploys with automatic Cloudflare Worker deploys and live asset smoke checks.
- Added URL-restored dashboard view state for search, filters, sort order, and dev columns.
- Added a `need attention` dashboard filter for hot and busy repositories, with the metric tile acting as a shortcut.
- Migrated the app shell to Svelte/Vite with keyboard-accessible account dropdowns, a Cmd-K command palette, and tighter ReleaseBar-themed controls.
- Hardened GitHub auth, cache, and rate-limit handling with validated API payloads, cached installation tokens, scoped visibility settings, and PR commit linting.
- Raised owner dashboard builds from 8 to 200 recent public repositories with progressive 12-repository batches and visible progress.
- Filtered GitHub App selected repositories to public repos before auth state, coverage checks, or dashboards can use them.
- Fixed GitHub App install redirects to use the real `releasebar-app` app slug while keeping `release.bar` OAuth callbacks.
- Changed the root dashboard to `ReleaseBar Hot`, built from cached public dashboards instead of the maintainer snapshot.
- Replaced raw GitHub rate-limit failures with dashboard-shaped quota guidance.
- Changed the canonical public domain to `release.bar` and renamed the public dashboard to ReleaseBar.
- Added a combined GitHub connection flow that detects GitHub App installations and prompts installation for dedicated API quota only when needed.
- Removed the always-on GitHub App install action from the account menu and tightened account menu styling.
- Moved GitHub login state into a top-right account menu with settings and logout actions.
- Added GitHub App login endpoints and settings UI state for signed-in users and app installation.
- Added customizable public dashboard sources for extra owners and explicit repositories, plus dynamic owner social preview cards.
- Added Worker static-asset hosting so owner routes can return the app shell with HTTP 200 once the domain is proxied through Cloudflare.
- Added route-aware owner dashboards, local visibility settings, and a cached Worker API for generic public GitHub dashboards.
- Added favicon and social preview card assets.
- Prevented cached dashboard data from showing archived repositories.
- Hid archived repositories from the dashboard.
- Updated the header owner label to `@steipete`.
- Added a dev mode toggle for open issues, open pull requests, and latest CI status.
- Skipped repositories that do not have any GitHub releases.
- Added CI for static checks and dependency updates.
- Added TypeScript sources, Oxlint/Oxfmt checks, sortable dashboard columns, and day-level relative dates.
