-- Step 7a of the stack migration: refresh data (docs/data-model.md).
-- Times are milliseconds since the epoch. `value` and `snapshot` hold JSON.

-- One row per refresh target: a dashboard the scheduler keeps fresh.
CREATE TABLE refresh_targets (
  key TEXT PRIMARY KEY,
  next_due_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  value TEXT NOT NULL
);

-- The admin overview lists the targets that are due soonest.
CREATE INDEX refresh_targets_next_due_at ON refresh_targets (next_due_at);

-- A webhook takes the targets seen most recently first, and targets not seen for the storage
-- lifetime are deleted.
CREATE INDEX refresh_targets_last_seen_at ON refresh_targets (last_seen_at);

-- The target index: one row per target and source. A source is an owner or a repository the
-- target's dashboard shows; a webhook for the source asks which targets to refresh.
CREATE TABLE refresh_target_sources (
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  target_key TEXT NOT NULL,
  PRIMARY KEY (kind, value, target_key)
) WITHOUT ROWID;

-- A target's rows are replaced when it is written and deleted with it.
CREATE INDEX refresh_target_sources_target_key ON refresh_target_sources (target_key);

-- One row per refresh job. `snapshot` is the job as it was enqueued, with its target; `value`
-- is its latest state, null until a delivery has written one.
CREATE TABLE refresh_jobs (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  value TEXT,
  snapshot TEXT
);

-- Jobs are listed newest first.
CREATE INDEX refresh_jobs_created_at ON refresh_jobs (created_at);

-- Jobs not updated for the job lifetime are deleted.
CREATE INDEX refresh_jobs_updated_at ON refresh_jobs (updated_at);

-- One row per delivery of a job to the queue handler: the job as the delivery started.
CREATE TABLE refresh_job_deliveries (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (job_id, attempt)
) WITHOUT ROWID;

-- Deliveries are listed newest first and deleted after the job lifetime.
CREATE INDEX refresh_job_deliveries_updated_at ON refresh_job_deliveries (updated_at);

-- What the scheduler carries from one tick to the next: one row per name.
CREATE TABLE scheduler_state (
  name TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- One row per profile snapshot, keyed by what a target carries as `profileSnapshotKey`.
CREATE TABLE profile_snapshots (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  value TEXT NOT NULL
);

-- Snapshots are deleted after the storage lifetime.
CREATE INDEX profile_snapshots_created_at ON profile_snapshots (created_at);
