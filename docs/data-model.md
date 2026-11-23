# Data model

Where each kind of data lives, and where steps 7a, 7b and 7c of the stack migration (`AGENTS.md`) move it. Until a step lands, its data is where the "Today" column says; a step that is done lists its tables only.

The rule: KV holds cached payloads and short-lived entries. Anything queried, listed or counted is in D1. Anything that must be checked and changed in one step is in a Durable Object.

## The store layer

Only `worker/store/` names a binding; `npm run lint` fails otherwise (`scripts/check-store-boundary.ts`). Every other module, the Durable Object classes of `worker/objects/` included, calls a store function. A store function is named for what it does, not for the key or table behind it, so a step changes the inside of its modules and leaves the callers alone.

- A store function takes the env a handler passed through `withLockJurisdiction` (`worker/store/bindings.ts`). A Durable Object's own env is the raw one: a class whose work reaches another object scopes it first, as `WebhookProcessor` does.
- A function documented as "not validated" returns what was stored as it is; the caller checks it (`isRefreshTarget`, `isRefreshJob`, `normalizeOwnerMetadataSnapshot`).
- `worker/store/cache.ts` is for data that stays in KV. Data of a table below must not go through it.

## Step 7a: refresh data (done)

Migration file: `migrations/0001_refresh.sql`. Durable Object migration tag: `7a-refresh`.

| Data                                                         | Table                                                                                                                         | Store module           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Refresh targets                                              | `refresh_targets`: one row per target, keyed by `key`, with `next_due_at` and `last_seen_at` as indexed columns               | `refresh-targets.ts`   |
| Target index: the targets that show an owner or a repository | `refresh_target_sources`: one row per target and source (`kind`, `value`, `target_key`)                                       | `refresh-targets.ts`   |
| Refresh jobs                                                 | `refresh_jobs`: one row per job, with its latest state (`value`) and the job as it was enqueued, with its target (`snapshot`) | `refresh-jobs.ts`      |
| Job delivery records                                         | `refresh_job_deliveries`: one row per job and attempt                                                                         | `refresh-jobs.ts`      |
| Scheduler state                                              | `scheduler_state`: one row per name (`last-tick`, `owner-count-cursor`)                                                       | `scheduler-state.ts`   |
| Profile snapshots                                            | `profile_snapshots`: one row per snapshot, keyed by what a target carries as `profileSnapshotKey`                             | `profile-snapshots.ts` |

- Each table keeps the record as JSON in `value`; the other columns are what a query filters or sorts by. Times are milliseconds.
- A target is written with its source rows in one `batch`, which is one transaction: it is listed under all of its sources or under none. The class `RefreshTargetIndex` and its binding are gone, and with them the backfill, the key index, the ready marker and the "any-version" and owner listings.
- The limits of the index are checks in `writeRefreshTarget`: a target over 8 KiB is refused, and so is a new target of a source that lists 512 already. The count is read before the write, not with it, so targets admitted at the same moment can take a source a few rows over. The limit on the serialized size of one source's index went with the object that had to hold it in one value.
- A webhook reads the targets of a source with a join, so it gets each target as it is stored now: there is no copy in an index to compare with.
- A job's `targetSnapshotKey` (`refresh-job:<id>`) and a target's `profileSnapshotKey` (`profile-snapshot:<owner>:<updatedAt>`) are opaque strings to the callers.
- `BuildCoordinator` stays (see below): it still applies each change to a target's scheduling state in one step, and the result is written to `refresh_targets`.
- KV expired these entries by itself; D1 does not. Each scheduler tick deletes up to 500 rows of each kind that are past their lifetime, the oldest first (`deleteExpiredRefreshData`): targets nobody has seen for 90 days with their source rows, jobs and delivery records not updated for 14 days, profile snapshots written more than 90 days ago. A target past its lifetime that is not deleted yet is not handed to a webhook.
- The listings are queries: the scheduler pages the targets by key (`key > cursor`, the cursor is the last key), the admin overview counts them and takes the ones due soonest, and the jobs and delivery records are read newest first with a limit. No query returns more than 512 rows of at most 8 KiB.

## Step 7b: audit and counters (done)

Migration file: `migrations/0002_audit.sql`. Durable Object migration tag: `7b-rate-limits`.

| Data                                                                             | Was                                                                                                | Now                                                                                                                                            | Store module       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Refresh audit log, with the timings browsers report (`client_dashboard_timing`)  | KV `refresh:audit:v2:<time>:<id>`                                                                  | `refresh_audit_events`: one row per event (`id`, `at`, `event`, and the event as JSON in `data`), indexed by `at`                              | `refresh-audit.ts` |
| GitHub audit log: calls per hour, route, credentials and result                  | KV `github:access:v1:<hour>:<shard>`                                                               | `github_access_counts`: one row per hour and route key, added to by one `INSERT ... ON CONFLICT DO UPDATE`                                     | `github-access.ts` |
| Sign-in funnel events                                                            | KV `auth:funnel:v1:<time>:<id>`                                                                    | `auth_funnel_events`: one row per event, one column per field, indexed by `at`                                                                 | `auth-funnel.ts`   |
| Sign-in funnel counters                                                          | KV `auth:funnel-counter:v1:<day>:<event>:<account>:<status>`                                       | `auth_funnel_counts`: one row per day, event, account and status (`_` for none), added to in the same batch as the event                       | `auth-funnel.ts`   |
| Request counters that limit a client per minute: client timing, install callback | KV `client:timing:rate:v1:<client>:<minute>` and `auth:install-callback:rate:v1:<client>:<minute>` | Durable Object class `RateLimiter` (`worker/objects/rate-limiter.ts`), one instance per endpoint: the limit is checked and counted in one step | `rate-limits.ts`   |

- A counter that is only added to and read later is a D1 row. A counter whose value decides the request is in a Durable Object. `SummaryQuota` keeps the AI summary limits: they span all users and two windows, which `RateLimiter` does not do.
- Both counters are upsert tables, not `COUNT` queries. GitHub calls have no row per call to count: there are too many. The funnel counts could be counted from the events, but the admin console would then read every event of 90 days for each view.
- GitHub calls of one request or job are collected in memory and written as one `batch`, which D1 counts as one query against the limit per invocation (50 on the free plan, 1,000 on the paid one), while the previous write is under way (`worker/github-audit.ts`). A refresh audit event is still one statement each.
- Retention, as the KV entries had it: 14 days for `refresh_audit_events` and `github_access_counts`, 90 days for `auth_funnel_events` and `auth_funnel_counts`. D1 expires nothing by itself: the scheduled handler deletes what is older (`worker/audit-retention.ts`), at most 5,000 rows per table and run, oldest first for the events. What a run leaves, the next one takes, 15 minutes later.
- `listGitHubAccessCounts` reads in pages of 1,000 rows and stops after 20,000; the admin summary logs `access_summary_truncated` when it did. `buckets` of the admin GitHub access summary is now the number of rows read, one per hour and route key.
- `RateLimiter` deletes the counts of past minutes when a call of a new minute arrives, so an instance holds one row per client of the last two minutes.

## Step 7c: auth and registry

Migration file: `migrations/0003_registry.sql`. Durable Object migration tag: `7c-registry`.

| Data                                                                                                   | Today                                                                                   | Target table                         | Store module        |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------ | ------------------- |
| Installation registry, with the repositories each installation may read                                | KV `auth:installation:v1:<account>`                                                     | `installations`: one row per account | `installations.ts`  |
| Owner metadata: the owner's repository list, with the repositories that turned private or were removed | Durable Object `OwnerMetadata` per owner, with a copy in KV `owner-metadata:v1:<owner>` | `owner_metadata`: one row per owner  | `owner-metadata.ts` |
| Dashboard profiles: the owners and repositories a dashboard adds, and the ones it hides                | KV `profile:v1:<owner>`                                                                 | `profiles`: one row per owner        | `profiles.ts`       |

- The step deletes the class `OwnerMetadata` and its binding. The object exists to apply one mutation at a time and to reconcile its copy with KV; with one row in D1 there is nothing to reconcile, but a mutation is still a read, a change and a write. The step must keep a `remove` or `restore` (a repository turning private or public) from being lost to a concurrent write, for example with a version column that the update checks.
- The mark that an account has no installation (`auth:installation-miss:v1:<account>`, 10 minutes) and the cached installation token (`auth:installation-token:<id>`, 50 minutes) are in `installations.ts` too and stay in KV.
- A session holds a copy of the user's installations; sessions stay in KV.

## What stays in KV

Through `cache.ts`, addressed by the cache key the owner of the data builds:

- Dashboard payloads, the hot dashboard with its index and its invalidation mark.
- Built projects (`repo:v2:`), repository details and their parts, activity, audience, trust profiles, social cards, AI summaries, resolved owners.
- Short-lived entries: the manual refresh cooldown, the shared GitHub quota cooldowns, the GraphQL backoff, and the build progress and its tombstone that stand in when a dashboard's coordinator can't be reached.

Through `sessions.ts`: sign-in sessions, which expire with the session.

## What stays in a Durable Object

| Class              | One per    | Holds                                                                                                                        | Store module           |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `BuildCoordinator` | dashboard  | Build lock, build progress, the reservation of the target's refresh job with its dirty marker, the target's scheduling state | `build-coordinator.ts` |
| `RateLimiter`      | endpoint   | Requests per client and minute, for the endpoints that limit them (step 7b)                                                  | `rate-limits.ts`       |
| `SummaryQuota`     | deployment | AI summary counters per user and hour, and for all users per day                                                             | `summary-quota.ts`     |
| `WebhookAdmission` | deployment | The GitHub deliveries already put on the queue                                                                               | `webhooks.ts`          |
| `WebhookProcessor` | owner      | Pending and processed deliveries, and the lease of the job that drains them                                                  | `webhooks.ts`          |

`WebhookAdmission` and `WebhookProcessor` send to the queue from inside the object, through `queue.ts`: the admission records a delivery only once the queue has it, and the processor releases its lease only once the queue has a job for what is still pending.

## Working on 7a, 7b and 7c at the same time

- Each step changes only the store modules its table above names, and adds only its own migration file. No file refers to a table of another step, and no foreign key crosses steps: Wrangler applies the files in name order, whatever order the steps merge in.
- An applied migration file is never edited. A fix is a new file with the next free number after `0003`.
- A change to the Durable Object classes is a new entry at the **end** of `migrations` in `wrangler.jsonc`, with the step's tag above. Rebase onto `main` before merging and keep the entry last: an entry placed before one that is already applied is never applied.
- Files every step touches, where a rebase is expected: `wrangler.jsonc` (`migrations`, `durable_objects.bindings`), `worker-configuration.d.ts` (run `npm run types` again), `worker/store/bindings.ts` (the list of object bindings), `AGENTS.md`, `CHANGELOG.md` and this file.
- A store module reads the database as `env.DB`. No module wraps it for the others.
- Tests: `testEnv` gives a test's env the local database of the Workers runtime, and `test/reset-storage.ts` applies the files of `migrations/` to it before each test and empties it after. A test that needs rows inserts them through the store functions or `env.DB`.
- `npm run deploy` applies the migrations before it deploys the Worker, so a migration must leave the Worker that is live working: add tables and columns first, and remove what the old code read in a later deploy.
