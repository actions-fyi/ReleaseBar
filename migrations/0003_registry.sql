-- Step 7c of the stack migration: the GitHub App installation registry, owner metadata and
-- dashboard profiles (docs/data-model.md). Only new tables: the Worker that is live while this
-- is applied reads none of them.
--
-- Text is compared with SQLite's default BINARY collation: a lookup by account or owner matches
-- the stored slug exactly, byte for byte.

-- One row per GitHub App installation, keyed by GitHub's installation id. An account has at most
-- one installation of the app, which the unique index on `account_login` (the account's slug)
-- holds: it is also the index of the lookup by account.
--
-- `repositories` is a JSON array of "owner/name": it is read and written with the row, never
-- queried or changed by item. `expires_at` (milliseconds since the epoch) is when a row that was
-- not written again stops counting; KV did that with a TTL.
CREATE TABLE installations (
  id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('user', 'org')),
  account_url TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  repositories TEXT NOT NULL CHECK (json_valid(repositories)),
  updated_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX installations_account_login ON installations (account_login);

-- The admin console lists the most recently updated installations.
CREATE INDEX installations_updated_at ON installations (updated_at DESC, id);

-- The scheduled deletion of expired rows.
CREATE INDEX installations_expires_at ON installations (expires_at);

-- One row per owner: the owner's metadata snapshot as JSON. Every change computes a whole snapshot
-- from the whole one before it, so the snapshot is one value. `revision` is a random token that
-- each write replaces: a write names the revision it read and changes nothing when the row has
-- moved on. A token, not a counter: a row that expired, was deleted and was written again must not
-- look like the one that was read before.
CREATE TABLE owner_metadata (
  owner TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX owner_metadata_expires_at ON owner_metadata (expires_at);

-- One row per dashboard owner. The four lists are JSON arrays: a profile is saved and read whole.
-- No expiry: a profile stays until its owner deletes it.
CREATE TABLE profiles (
  owner TEXT PRIMARY KEY,
  include_owners TEXT NOT NULL CHECK (json_valid(include_owners)),
  include_repos TEXT NOT NULL CHECK (json_valid(include_repos)),
  hidden_owners TEXT NOT NULL CHECK (json_valid(hidden_owners)),
  hidden_repos TEXT NOT NULL CHECK (json_valid(hidden_repos)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;
