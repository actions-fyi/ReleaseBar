# Data model

Where each kind of data lives, and which store module owns it.

The rule: KV holds cached payloads and short-lived entries. Anything queried, listed or counted is in D1. Anything that must be checked and changed in one step is in a Durable Object.

## The store layer

Only `worker/store/` names a binding; `npm run lint` fails otherwise (`scripts/check-store-boundary.ts`). Every other module, the Durable Object classes of `worker/objects/` included, calls a store function. A store function is named for what it does, not for the key or table behind it.

- A store function takes the env a handler passed through `withLockJurisdiction` (`worker/store/bindings.ts`). A Durable Object's own env is the raw one: a class whose work reaches another object scopes it first, as `WebhookProcessor` does.
- A function documented as "not validated" returns what was stored as it is; the caller checks it (`isRefreshTarget`, `isRefreshJob`, `normalizeOwnerMetadataSnapshot`).
- `worker/store/cache.ts` is for data that stays in KV. Data of a table below must not go through it.
- A store module reads the database as `env.DB`, with prepared statements and bound parameters. No module wraps it for the others.

## D1

The schema is the SQL files of `migrations/`, applied in name order by `npm run deploy` before it deploys the Worker, and by the tests before each test (`migrations/README.md`).

### Refresh data

`migrations/0001_refresh.sql`.

| Data                                                         | Table                                                                                                                         | Store module           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Refresh targets                                              | `refresh_targets`: one row per target, keyed by `key`, with `next_due_at` and `last_seen_at` as indexed columns               | `refresh-targets.ts`   |
| Target index: the targets that show an owner or a repository | `refresh_target_sources`: one row per target and source (`kind`, `value`, `target_key`)                                       | `refresh-targets.ts`   |
| Refresh jobs                                                 | `refresh_jobs`: one row per job, with its latest state (`value`) and the job as it was enqueued, with its target (`snapshot`) | `refresh-jobs.ts`      |
| Job delivery records                                         | `refresh_job_deliveries`: one row per job and attempt                                                                         | `refresh-jobs.ts`      |
| Scheduler state                                              | `scheduler_state`: one row per name (`last-tick`, `owner-count-cursor`)                                                       | `scheduler-state.ts`   |
| Profile snapshots                                            | `profile_snapshots`: one row per snapshot, keyed by what a target carries as `profileSnapshotKey`                             | `profile-snapshots.ts` |

- Each table keeps the record as JSON in `value`; the other columns are what a query filters or sorts by. Times are milliseconds.
- A target is written with its source rows in one `batch`, which is one transaction: it is listed under all of its sources or under none.
- The limits are checks in `writeRefreshTarget` and `writeRefreshTargets`: a target over 8 KiB is refused, and so is a new target of a source that lists 512 already. The count takes only targets within their lifetime: one that is past it and not deleted yet holds no place. The count is read before the write, not with it, so targets admitted at the same moment can take a source a few rows over. One statement can't do both for a target with many sources: a statement binds 100 parameters at most.
- A webhook reads the targets of a source with a join, so it gets each target as it is stored now.
- A job's `targetSnapshotKey` (`refresh-job:<id>`) and a target's `profileSnapshotKey` (`profile-snapshot:<owner>:<updatedAt>`) are opaque strings to the callers.
- `BuildCoordinator` (see below) applies each change to a target's scheduling state in one step, and the result is written to `refresh_targets`.
- D1 expires nothing by itself. Each scheduler tick deletes up to 500 rows of each kind that are past their lifetime, the oldest first (`deleteExpiredRefreshData`): targets nobody has seen for 90 days with their source rows, jobs and delivery records not updated for 14 days, profile snapshots written more than 90 days ago. A target past its lifetime that is not deleted yet is not handed to a webhook.
- The listings are queries: the scheduler pages the targets by key (`key > cursor`, the cursor is the last key), the admin overview counts them and takes the ones due soonest, and the jobs and delivery records are read newest first with a limit. No query returns more than 512 rows of at most 8 KiB.

### Audit and counters

`migrations/0002_audit.sql`.

| Data                                                                            | Table                                                                                                                    | Store module       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Refresh audit log, with the timings browsers report (`client_dashboard_timing`) | `refresh_audit_events`: one row per event (`id`, `at`, `event`, and the event as JSON in `data`), indexed by `at`        | `refresh-audit.ts` |
| GitHub audit log: calls per hour, route, credentials and result                 | `github_access_counts`: one row per hour and route key, added to by one `INSERT ... ON CONFLICT DO UPDATE`               | `github-access.ts` |
| Sign-in funnel events                                                           | `auth_funnel_events`: one row per event, one column per field, indexed by `at`                                           | `auth-funnel.ts`   |
| Sign-in funnel counters                                                         | `auth_funnel_counts`: one row per day, event, account and status (`_` for none), added to in the same batch as the event | `auth-funnel.ts`   |

- A counter that is only added to and read later is a D1 row. A counter whose value decides the request is in a Durable Object: `RateLimiter` and `SummaryQuota` (see below).
- Both counters are upsert tables, not `COUNT` queries. GitHub calls have no row per call to count: there are too many. The funnel counts could be counted from the events, but the admin console would then read every event of 90 days for each view.
- The refresh audit events and the GitHub calls of one request, scheduler tick or queue job are collected in memory and written as one `batch` when its work is done (`worker/audit-collector.ts`, see "D1 queries per invocation" below).
- Retention: 14 days for `refresh_audit_events` and `github_access_counts`, 90 days for `auth_funnel_events` and `auth_funnel_counts`. D1 expires nothing by itself: the scheduled handler deletes what is older (`worker/audit-retention.ts`), at most 5,000 rows per table and run, oldest first for the events, with one batch for each of the three store modules. What a run leaves, the next one takes, 15 minutes later.
- `listGitHubAccessCounts` reads in pages of 1,000 rows and stops after 20,000; the admin summary logs `access_summary_truncated` when it did. `buckets` of the admin GitHub access summary is the number of rows read, one per hour and route key.

### Registry

`migrations/0003_registry.sql`, and `migrations/0004_checks.sql` for the shape of the JSON columns.

| Data                                                                                                   | Table                                                                                             | Store module        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------- |
| Installation registry, with the repositories each installation may read                                | `installations`: one row per installation, keyed by GitHub's installation id; one row per account | `installations.ts`  |
| Owner metadata: the owner's repository list, with the repositories that turned private or were removed | `owner_metadata`: one row per owner, the snapshot as JSON with a revision                         | `owner-metadata.ts` |
| Dashboard profiles: the owners and repositories a dashboard adds, and the ones it hides                | `profiles`: one row per owner                                                                     | `profiles.ts`       |

- Lookups are exact. An account or owner is matched as its slug (`slugOwner`: trimmed, without a leading `@`, lower case) with `=` under SQLite's default `BINARY` collation; no query uses `LIKE` or a prefix.
- `installations`: the primary key is the installation id, and a unique index on `account_login` holds one row per account. A write is one `db.batch`: it deletes the row the account had under another id, then inserts or replaces the row of this id, so a reinstall (new id) or a renamed account (same id) never leaves two rows. Only public repositories are in `repositories`, as before: the sync filters them before it writes.
- JSON columns, each read and written with its row and never queried by item: `installations.repositories`, the four lists of `profiles` (`include_owners`, `include_repos`, `hidden_owners`, `hidden_repos`) and `owner_metadata.snapshot`. Each has a `CHECK`: a list column holds a JSON array and a snapshot a JSON object, so a value of another shape is refused when it is written. A profile list that is not an array would otherwise read as empty, and show what the profile hides. A profile is saved whole by its owner. An installation's repository list is replaced whole by the sync, and the check whether it covers a repository reads the installation anyway. Which dashboards show an owner or a repository is not asked of the profiles: that is the target index (`refresh_target_sources`).
- `owner_metadata.snapshot` is one value because every mutation (`merge`, `counts`, `visibility`, `remove`, `restore`) computes a whole snapshot from the whole one before it. No mutation is lost: a change reads the row with its `revision`, a random token, applies the mutation, and writes with one statement, `UPDATE ... WHERE owner = ? AND revision = ?` (or `INSERT ... ON CONFLICT DO NOTHING` when there was no row). D1 runs statements one at a time, so of two writers that read the same revision the second changes no row; it reads again and applies its mutation to what the first stored, up to 12 times, and rejects after that rather than drop the mutation silently. The revision is a token, not a counter, so that a row that expired, was deleted and was written again can't pass for the one read before.
- The changes of many owners are one read and one batch (`changeOwnerMetadataOf`; `changeOwnerMetadata` is the same with one owner). The batch holds that same statement for each owner, each naming the revision read for its owner, and D1 reports for each statement how many rows it changed. So each owner's change applies only if that owner's row is unchanged since it was read, whatever happens to the others in the batch; the owners whose statement changed no row, and only those, are read again and their mutations applied again, up to 12 times each. The result tells for each owner whether its change is stored: one owner that keeps losing does not fail the others, and a caller that needs all of them (`rememberOwnerMetadata`) rejects when one is not. An owner is in a batch once. `test/registry-store.test.ts` runs conflicting mutations at once, alone and in batches, and lets a writer in between a batch's read and its write.
- A read of owner metadata rejects when the database can't be reached, and the callers that hide private repositories then hide everything. There is no second copy to fall back to.
- Expiry: a row of `installations` or `owner_metadata` has `expires_at`, 90 days after its last write. Every read ignores a row past it, and the scheduled handler deletes up to 500 such rows per table and run (`worker/registry-expiry.ts`). Profiles do not expire.
- Limits (D1, as documented in November 2026): a row or a string is at most 2 MB, which bounds an owner's snapshot; a query binds at most 100 parameters, and a lookup of many owners or accounts binds at most 91, a write at most nine; a result is at most 50 MB, so whole snapshots are read 20 to a statement; a `batch` is one transaction and counts as one query of the invocation; `listStoredInstallations` reads 250 rows per query, each with a repository list of at most 1,000 names.
- The mark that an account has no installation and the cached installation token are KV entries, owned by `installations.ts` too. No token is written to D1.
- A session holds a copy of the user's installations; sessions are in KV.
- An empty `installations` table fills again by itself: a request that needs an account's installation asks GitHub for it and stores it, a sign-in stores the user's installations, and the admin console's installation sync stores all of them.

- An installation that is stored with the same content and was written in the last five minutes is not written again (`writeInstallationRegistry`). Every `/api/me` call checks the session's installations; without the skip each would send the batch of writes and the four queries that remember the accounts' dashboards as refresh targets.

## D1 queries per invocation

D1 limits the queries of one Worker invocation: 50 on the Workers free plan, 1,000 on the paid one. A statement sent by itself is one query, and so is a `batch`, whatever the number of its statements. Each statement takes at most 100 bound parameters and 100 KB of SQL, and a batch must finish within 30 seconds; D1 sets no number of statements for a batch. So nothing writes a row per item with a statement of its own:

- Jobs are enqueued together (`enqueueRefreshJobs`, `worker/refresh-queue.ts`): the scheduler tick's and a webhook's jobs are stored 25 to a batch (`refreshJobBatchRows`). For each job the order is as for one: reserved, stored, audited, sent to the queue. A job that could not be stored or sent is stored as failed, in one batch with the others that failed, and its reservation is released.
- The audit collector (`worker/audit-collector.ts`) holds the refresh audit events and the GitHub call counts of an invocation and writes them as one batch (`worker/store/audit-batch.ts`) once the handler and its `waitUntil` work have settled. Work that runs long is written every two minutes, and at 200 rows. The fetch, scheduled and queue handlers and `WebhookProcessor` each start one; code called with any other env writes at once.
- The targets of a webhook's owner and repository are read with one batch.
- The registry is read and written for all the owners or accounts of an invocation at once. A lookup of many owners, accounts or keys is one batch of `... IN (?, ?, ...)` statements, 90 values to a statement (20 for whole owner snapshots, which are up to 2 MB each and must stay under the 50 MB of a result): only the number of `?` depends on the items, the values are bound, and the match is the exact one of `=`. The store functions are `readStoredOwnerMetadataOf`, `readOwnerCountTimes`, `changeOwnerMetadataOf` (`owner-metadata.ts`), `readStoredInstallationsOf`, `writeStoredInstallations`, `deleteStoredInstallations` (`installations.ts`), `readProfilesOf` (`profiles.ts`), `readStoredRefreshTargetsOf`, `writeRefreshTargets` (`refresh-targets.ts`), `ensureProfileSnapshots` and `appendAuthFunnelEvents`.
- A scheduler tick asks one query which owners of its page are due for a count refresh (`readOwnerCountTimes` reads two fields of each snapshot with `json_extract`, not the snapshots), reads the installations of all the page's accounts once, and stores the counts of the due owners with one read and one batch.
- A dashboard build stores what it saw of its owners with one read and one batch (`rememberOwnerMetadata`), and reads their metadata with one query (`mergeOwnerMetadata`); several cached dashboards are merged with one read for the owners of all of them (`readCachedWithOwnerMetadataOf`).
- A sign-in, an install callback and the installation sync read the stored installations of all the accounts with one query and write the changed ones 100 to a batch (`writeInstallationRegistry`). The dashboards of the accounts are remembered as refresh targets together (`rememberRefreshTargets`): their profiles are one read, the installations they need one read, the stored targets one read, their limits one query, and the targets 100 to a batch.

The most queries an invocation sends, at the limits of `worker/config.ts`. The tests of `test/registry-queries.test.ts` and `test/refresh-store.test.ts` measure them:

| Invocation                                                                                                                             | Queries                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler tick over a page of 120 targets, enqueueing 20 jobs and refreshing 20 owners' counts                                         | 21: 5 reads, the installations of the page's accounts, the owners' count times, the write of the owner count cursor, the read and the batch of the due owners' snapshots, 1 batch of jobs, the tick's state, 3 deletions of refresh rows, 3 of audit rows, 2 of registry rows, 1 audit batch |
| The same tick with no owner to refresh                                                                                                 | 17: 5 reads, the write of the owner count cursor, 1 batch of jobs, the tick's state, 3 deletions of refresh rows, 3 of audit rows, 2 of registry rows, 1 audit batch (16 when no owner was due: the cursor is then not written)                                                              |
| Webhook fan-out job, a page of 200 targets                                                                                             | 10: the page, 8 batches of jobs, 1 audit batch                                                                                                                                                                                                                                               |
| `WebhookProcessor` handling 8 coalesced deliveries of 25 targets each                                                                  | 17: per delivery the targets and 1 batch of jobs, then 1 audit batch                                                                                                                                                                                                                         |
| Refresh job from the queue, whatever the number of owners its dashboard shows                                                          | 12: the job, its delivery record and its target, 3 for the owners' metadata (read, batch of writes, read), 4 for the target's state, the job's state, 1 audit batch; and one more audit batch for every two minutes the build runs (6 in the 12 minutes a job may take)                      |
| Dashboard request served from the cache, for a dashboard seen before                                                                   | 6: the profile, the owner's metadata, 3 for its target (read, whether it is stored, the write), 1 audit batch                                                                                                                                                                                |
| Dashboard request that stores a new target and enqueues a job                                                                          | 8: the same, the limits of the target's sources, the job                                                                                                                                                                                                                                     |
| Install callback for an account with all repositories                                                                                  | 16: 2 funnel events, 7 for the registry (the stored installation, its write, the account's profile, the installations its dashboard needs, 3 for its target), 5 to warm its cache (the same without the installation's read and write), the job, 1 audit batch                               |
| Sign-in of a user with 30 accounts that installed the app for all repositories                                                         | 14 for the registry and the cache warm-up: 7 to store the installations and remember the targets, 7 to warm the caches with 2 batches of 25 jobs. Beyond 100 accounts, 3 more for every 100: the batches of installations and of targets (twice); and 1 more for every 25 jobs               |
| Installation sync from the admin console, with the 999 installations GitHub's listing allows a sync, all new, and 999 stored ones gone | 40: 8 to list the stored installations before and after, 1 deletion, 4 batches of funnel events, 13 for the registry (read, 10 batches of 100 writes, the profiles, the installations again), 12 for the targets (read, limits, 10 batches of 100), the sync's funnel event, 1 audit batch   |

When the dashboards' `BuildCoordinator` objects can't be reached, reserving falls back to the list of jobs, which is two more queries for all the jobs enqueued together.

An owner's metadata that another invocation changes between the read and the batch costs one more read and one more batch, for the owners it happened to only (see `owner_metadata` below); a batch gives up on such an owner after 12 tries.

### Other subrequests

D1's limit is its own. Besides it, an invocation on the free plan may make 50 subrequests to hosts outside Cloudflare and 1,000 to Cloudflare's own services, such as KV, D1, Queues and Durable Objects; on the paid plan 10,000, which a Worker can raise. (Cloudflare's Workers limits page, November 2026: "Subrequests per invocation" and "Subrequests to internal services".)

- Internal: a scheduler tick reads the cached dashboard of each target of its page from KV (up to 120 reads), up to about 10 more KV entries for the quota pauses, and the cached installation token of each owner whose counts it refreshes (up to 20), writes one KV entry, sends up to 20 queue messages and calls the `BuildCoordinator` object of each job: about 200 with its D1 queries, within the 1,000. A dashboard build reads and writes KV about 40 times for 9 owners. A sign-in reads one cached dashboard and sends one queue message for each account, and calls the `BuildCoordinator` object of each account's dashboard three times.
- External: the calls to GitHub. A tick asks GitHub for the counts of up to 20 owners, with a token minted for each owner whose installation token is not cached. A refresh job's calls depend on the repositories of its batch. The installation sync asks GitHub for a page of 100 installations at a time and, for each installation of selected repositories, for its token and its repository pages: on the free plan that passes 50 at about 20 such installations, whatever D1 allows.

## KV

One namespace, `DASHBOARD_CACHE`. It holds cached payloads and short-lived entries only: what can be built again from GitHub or expires by itself. Nothing in it is queried or counted; the only listings are by prefix, to delete a repository's or an owner's cached entries after a webhook, and to find cached dashboards for the hot dashboard when its index is short.

Through `cache.ts`, addressed by the cache key the owner of the data builds. Every entry is written with a lifetime:

| Key family                                                                                                         | Holds                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `dashboard:v6:`                                                                                                    | Dashboard payloads, one per dashboard variant                                                                                |
| `hot:v3`, `hot:v3:invalidated-at`, `hot:index:v3`                                                                  | The hot dashboard, its invalidation mark and the index of the dashboards it is built from                                    |
| `repo:v2:`                                                                                                         | Built projects, which dashboard builds share                                                                                 |
| `owner:v1:`                                                                                                        | Resolved owners                                                                                                              |
| `repo-detail:v4:`, `repo-detail:aux:v2:`                                                                           | Repository details and the GitHub responses they are built from                                                              |
| `repo-activity:v1:`, `owner-activity:v2:`                                                                          | Activity                                                                                                                     |
| `repo-activity-summary:v4:`, `owner-activity-summary:v4:`, `release-summary:v1:`                                   | AI summaries                                                                                                                 |
| `repo-audience:v5:`, `audience-user:v1:`, `audience-user-orgs:v1:`, `audience-user-repos:v2:`, `trust-profile:v4:` | Audience and trust profiles                                                                                                  |
| `social-repo:v3:`                                                                                                  | Social card data                                                                                                             |
| `discover:v4:`                                                                                                     | Discovery listings                                                                                                           |
| `refresh:manual:v1:`                                                                                               | The manual refresh cooldown                                                                                                  |
| `github:budget:v1:shared:`, `github:backoff:v2:graphql:`                                                           | The shared GitHub quota cooldowns and the GraphQL backoff                                                                    |
| `progress:v1:`, `progress:tombstone:v1:`                                                                           | The build progress while a dashboard's coordinator object can't be reached, and the mark that a build's progress was cleared |

The version in a key is part of the key: a change of shape takes a new version, and the entries of the old one expire unread.

Through `installations.ts`: `auth:installation-miss:v1:<account>`, the mark that GitHub knows no installation for an account (10 minutes), and `auth:installation-token:<id>`, the cached installation token (50 minutes).

Through `sessions.ts`: `auth:session:<id>`, a sign-in session, which expires with the session.

## Durable Objects

| Class              | One per    | Holds                                                                                                                        | Store module           |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `BuildCoordinator` | dashboard  | Build lock, build progress, the reservation of the target's refresh job with its dirty marker, the target's scheduling state | `build-coordinator.ts` |
| `RateLimiter`      | endpoint   | Requests per client and minute, for the endpoints that limit them: client timing and the install callback                    | `rate-limits.ts`       |
| `SummaryQuota`     | deployment | AI summary counters per user and hour, and for all users per day                                                             | `summary-quota.ts`     |
| `WebhookAdmission` | deployment | The GitHub deliveries already put on the queue                                                                               | `webhooks.ts`          |
| `WebhookProcessor` | owner      | Pending and processed deliveries, and the lease of the job that drains them                                                  | `webhooks.ts`          |

- The classes are in `worker/objects/`, one file each, with typed RPC methods and SQLite storage. A change to the classes is a new entry at the end of `migrations` in `wrangler.jsonc`, never an edit of an applied one.
- `WebhookAdmission` and `WebhookProcessor` send to the queue from inside the object, through `queue.ts`: the admission records a delivery only once the queue has it, and the processor releases its lease only once the queue has a job for what is still pending.
- `RateLimiter` deletes the counts of past minutes when a call of a new minute arrives, so an instance holds one row per client of the last two minutes.
- When an object can't be reached, each caller does something defined:
  - `BuildCoordinator`: the build lock, the job reservation and the dirty marker fall back to maps of the isolate, the progress to KV (`progress:v1:`), and a target's state to the row in D1.
  - `RateLimiter`: the client timing endpoint drops the sample and answers 202 as usual; an install callback that would ask GitHub about an installation answers 503 with `Retry-After`. Without the limiter nothing bounds either.
  - `SummaryQuota`: no summary is generated.
  - `WebhookAdmission`, `WebhookProcessor`: the delivery is not acknowledged, and GitHub or the queue delivers it again.

## Changing the schema

- An applied migration file is never edited. A change is a new file with the next free number.
- `npm run deploy` applies the migrations before it deploys the Worker, so a migration must leave the Worker that is live working: add tables and columns first, and remove what the old code read in a later deploy.
- SQLite can't add a `CHECK` to an existing column or drop one. `migrations/0004_checks.sql` shows the rebuild: a new table with the constraint, the rows copied, the old table dropped, the new one renamed, the indexes created again, all in one file, with the same table, columns and indexes at the end.
- D1, KV namespaces and queues are created with `--jurisdiction eu`; a jurisdiction can't be added later.
- Tests run on the local bindings of the Workers runtime. `test/reset-storage.ts` applies the files of `migrations/` to the local database before each test and empties all storage after it. A test that needs rows inserts them through the store functions or the database.
