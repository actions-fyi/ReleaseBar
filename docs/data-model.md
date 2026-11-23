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
- The refresh audit events and the GitHub calls of one request, scheduler tick or queue job are collected in memory and written as one `batch` when its work is done (`worker/audit-collector.ts`, see "D1 queries per invocation" below).
- Retention, as the KV entries had it: 14 days for `refresh_audit_events` and `github_access_counts`, 90 days for `auth_funnel_events` and `auth_funnel_counts`. D1 expires nothing by itself: the scheduled handler deletes what is older (`worker/audit-retention.ts`), at most 5,000 rows per table and run, oldest first for the events, with one batch for each of the three store modules. What a run leaves, the next one takes, 15 minutes later.
- `listGitHubAccessCounts` reads in pages of 1,000 rows and stops after 20,000; the admin summary logs `access_summary_truncated` when it did. `buckets` of the admin GitHub access summary is now the number of rows read, one per hour and route key.
- `RateLimiter` deletes the counts of past minutes when a call of a new minute arrives, so an instance holds one row per client of the last two minutes.

## D1 queries per invocation

D1 limits the queries of one Worker invocation: 50 on the Workers free plan, 1,000 on the paid one. A statement sent by itself is one query, and so is a `batch`, whatever the number of its statements. Each statement takes at most 100 bound parameters. So nothing writes a row per item with a statement of its own:

- Jobs are enqueued together (`enqueueRefreshJobs`, `worker/refresh-queue.ts`): the scheduler tick's and a webhook's jobs are stored 25 to a batch (`refreshJobBatchRows`). For each job the order is as for one: reserved, stored, audited, sent to the queue. A job that could not be stored or sent is stored as failed, in one batch with the others that failed, and its reservation is released.
- The audit collector (`worker/audit-collector.ts`) holds the refresh audit events and the GitHub call counts of an invocation and writes them as one batch (`worker/store/audit-batch.ts`) once the handler and its `waitUntil` work have settled. Work that runs long is written every two minutes, and at 200 rows. The fetch, scheduled and queue handlers and `WebhookProcessor` each start one; code called with any other env writes at once.
- The targets of a webhook's owner and repository are read with one batch.

The most queries an invocation sends for the refresh data and the audit tables, at the limits of `worker/config.ts`:

| Invocation                                                            | Queries                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler tick enqueueing 20 jobs, with the deletion of expired rows  | 17: 5 reads, the owner count cursor, 1 batch of jobs, the tick's state, 3 deletions of refresh rows, 3 of audit rows, 2 of registry rows, 1 audit batch |
| Webhook fan-out job, a page of 200 targets                            | 10: the page, 8 batches of jobs, 1 audit batch                                                                                                          |
| `WebhookProcessor` handling 8 coalesced deliveries of 25 targets each | 17: per delivery the targets and 1 batch of jobs, then 1 audit batch                                                                                    |
| Refresh job from the queue                                            | About 12, the audit batch included, and one more audit batch for every two minutes the build runs (6 in the 12 minutes a job may take)                  |
| Dashboard request that stores its target and enqueues a job           | About 10, the audit batch included                                                                                                                      |

When the dashboards' `BuildCoordinator` objects can't be reached, reserving falls back to the list of jobs, which is two more queries for all the jobs enqueued together.

Not in these numbers, and not batched yet: the registry of step 7c is read and written one owner or account at a time. A dashboard build reads the owner metadata of each owner it shows and changes it with a read and a write; a token lookup reads the account's installation; a scheduler tick reads the owner metadata of the owners on its page until 20 are due for a count refresh, and each refresh is about four queries. An invocation that handles many owners can so pass 50 queries.

## Step 7c: auth and registry (done)

Migration file: `migrations/0003_registry.sql`. Durable Object migration tag: `7c-registry`, which deleted the class `OwnerMetadata` and its binding.

| Data                                                                                                   | Table                                                                                             | Store module        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------- |
| Installation registry, with the repositories each installation may read                                | `installations`: one row per installation, keyed by GitHub's installation id; one row per account | `installations.ts`  |
| Owner metadata: the owner's repository list, with the repositories that turned private or were removed | `owner_metadata`: one row per owner, the snapshot as JSON with a revision                         | `owner-metadata.ts` |
| Dashboard profiles: the owners and repositories a dashboard adds, and the ones it hides                | `profiles`: one row per owner                                                                     | `profiles.ts`       |

- Lookups are exact. An account or owner is matched as its slug (`slugOwner`: trimmed, without a leading `@`, lower case) with `=` under SQLite's default `BINARY` collation; no query uses `LIKE` or a prefix.
- `installations`: the primary key is the installation id, and a unique index on `account_login` holds one row per account. A write is one `db.batch`: it deletes the row the account had under another id, then inserts or replaces the row of this id, so a reinstall (new id) or a renamed account (same id) never leaves two rows. Only public repositories are in `repositories`, as before: the sync filters them before it writes.
- JSON columns, each read and written with its row and never queried by item: `installations.repositories`, the four lists of `profiles` (`include_owners`, `include_repos`, `hidden_owners`, `hidden_repos`) and `owner_metadata.snapshot`. A profile is saved whole by its owner. An installation's repository list is replaced whole by the sync, and the check whether it covers a repository reads the installation anyway. Which dashboards show an owner or a repository is not asked of the profiles: that is the target index of step 7a.
- `owner_metadata.snapshot` is one value because every mutation (`merge`, `counts`, `visibility`, `remove`, `restore`) computes a whole snapshot from the whole one before it. No mutation can be lost without the Durable Object: `changeOwnerMetadata` reads the row with its `revision`, a random token, applies the mutation, and writes with one statement, `UPDATE ... WHERE owner = ? AND revision = ?` (or `INSERT ... ON CONFLICT DO NOTHING` when there was no row). D1 runs statements one at a time, so of two writers that read the same revision the second changes no row; it reads again and applies its mutation to what the first stored, up to 12 times, and rejects after that rather than drop the mutation silently. The revision is a token, not a counter, so that a row that expired, was deleted and was written again can't pass for the one read before. `test/registry-store.test.ts` runs conflicting mutations at once.
- A read of owner metadata rejects when the database can't be reached, and the callers that hide private repositories then hide everything, as they did when the object could not be reached. There is no second copy to fall back to.
- Expiry, which KV did by itself: a row of `installations` or `owner_metadata` has `expires_at`, 90 days after its last write. Every read ignores a row past it, and the scheduled handler deletes up to 500 such rows per table and run (`worker/registry-expiry.ts`). Profiles do not expire.
- Limits (D1, as documented in November 2026): a row or a string is at most 2 MB, which bounds an owner's snapshot as it did in the Durable Object's SQLite table; a query binds at most 100 parameters, and no statement here binds more than nine; `listStoredInstallations` reads 100 rows per query.
- The mark that an account has no installation (`auth:installation-miss:v1:<account>`, 10 minutes) and the cached installation token (`auth:installation-token:<id>`, 50 minutes) are in `installations.ts` too and stay in KV. No token is written to D1.
- A session holds a copy of the user's installations; sessions stay in KV.
- An empty `installations` table fills again by itself: a request that needs an account's installation asks GitHub for it and stores it, a sign-in stores the user's installations, and the admin console's installation sync stores all of them.

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
