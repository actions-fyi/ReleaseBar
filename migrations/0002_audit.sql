-- Step 7b of the stack migration: audit logs and counters (docs/data-model.md).
-- Only creates tables: the Worker that is live while this is applied reads none of them.

-- The refresh audit log, with the timings browsers report. `data` is the event as JSON; `at` is
-- its ISO time in UTC, which sorts as text. Rows older than 14 days are deleted by the scheduler.
CREATE TABLE refresh_audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX refresh_audit_events_at ON refresh_audit_events (at);

-- GitHub calls per hour ("2026-06-13T12") and route key, which names the area, status,
-- credentials, quota resource and route. Rows older than 14 days are deleted by the scheduler.
CREATE TABLE github_access_counts (
  hour TEXT NOT NULL,
  route_key TEXT NOT NULL,
  area TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  source TEXT NOT NULL,
  account TEXT,
  resource TEXT,
  count INTEGER NOT NULL,
  last_at TEXT NOT NULL,
  last_path TEXT,
  PRIMARY KEY (hour, route_key)
) WITHOUT ROWID;

-- One row per step of a sign-in or an app installation. Rows older than 90 days are deleted by
-- the scheduler.
CREATE TABLE auth_funnel_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  account TEXT,
  installation_id INTEGER,
  repository_selection TEXT,
  status TEXT,
  detail TEXT
);
CREATE INDEX auth_funnel_events_at ON auth_funnel_events (at);

-- Sign-in funnel events per day ("2026-06-13"), event, account and status. An event without an
-- account or a status counts under "_": a primary key column can't tell two NULLs apart. Rows
-- older than 90 days are deleted by the scheduler.
CREATE TABLE auth_funnel_counts (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, event, account, status)
) WITHOUT ROWID;
