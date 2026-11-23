-- The shape of the JSON columns of the registry tables (migrations/0003_registry.sql), checked
-- when a row is written: a list column holds a JSON array and an owner's snapshot a JSON object.
-- `json_valid` alone let any JSON value in, and the readers assume the shape: a profile list
-- that is not an array of strings reads as an empty list, which would show what the profile
-- hides.
--
-- SQLite can't add a CHECK to a column of an existing table. Each table is built again under a
-- new name with the checks, takes the rows of the old one, and gets its name and its indexes:
-- the same tables, columns and indexes as before, so the Worker that is live while this is
-- applied reads and writes them as it did.
--
-- No row can stop the copy. Every stored value is valid JSON already, by the checks of 0003. A
-- profile list of another shape becomes the empty list it was read as. An installation or an
-- owner's snapshot of another shape was ignored by every read and is not copied: the registry
-- fills again from GitHub (docs/data-model.md).

CREATE TABLE profiles_checked (
  owner TEXT PRIMARY KEY,
  include_owners TEXT NOT NULL
    CHECK (json_valid(include_owners) AND json_type(include_owners) = 'array'),
  include_repos TEXT NOT NULL
    CHECK (json_valid(include_repos) AND json_type(include_repos) = 'array'),
  hidden_owners TEXT NOT NULL
    CHECK (json_valid(hidden_owners) AND json_type(hidden_owners) = 'array'),
  hidden_repos TEXT NOT NULL
    CHECK (json_valid(hidden_repos) AND json_type(hidden_repos) = 'array'),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

INSERT INTO profiles_checked
  (owner, include_owners, include_repos, hidden_owners, hidden_repos, updated_at, updated_by)
SELECT
  owner,
  CASE WHEN json_type(include_owners) = 'array' THEN include_owners ELSE '[]' END,
  CASE WHEN json_type(include_repos) = 'array' THEN include_repos ELSE '[]' END,
  CASE WHEN json_type(hidden_owners) = 'array' THEN hidden_owners ELSE '[]' END,
  CASE WHEN json_type(hidden_repos) = 'array' THEN hidden_repos ELSE '[]' END,
  updated_at,
  updated_by
FROM profiles;

DROP TABLE profiles;
ALTER TABLE profiles_checked RENAME TO profiles;

CREATE TABLE installations_checked (
  id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('user', 'org')),
  account_url TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  repositories TEXT NOT NULL
    CHECK (json_valid(repositories) AND json_type(repositories) = 'array'),
  updated_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

INSERT INTO installations_checked
  (id, account_login, account_type, account_url, avatar_url, repository_selection, repositories,
   updated_at, expires_at)
SELECT
  id, account_login, account_type, account_url, avatar_url, repository_selection, repositories,
  updated_at, expires_at
FROM installations
WHERE json_type(repositories) = 'array';

-- Dropping the table drops its indexes, which frees their names.
DROP TABLE installations;
ALTER TABLE installations_checked RENAME TO installations;

CREATE UNIQUE INDEX installations_account_login ON installations (account_login);
CREATE INDEX installations_updated_at ON installations (updated_at DESC, id);
CREATE INDEX installations_expires_at ON installations (expires_at);

CREATE TABLE owner_metadata_checked (
  owner TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot) AND json_type(snapshot) = 'object'),
  expires_at INTEGER NOT NULL
) STRICT;

INSERT INTO owner_metadata_checked (owner, revision, snapshot, expires_at)
SELECT owner, revision, snapshot, expires_at
FROM owner_metadata
WHERE json_type(snapshot) = 'object';

DROP TABLE owner_metadata;
ALTER TABLE owner_metadata_checked RENAME TO owner_metadata;

CREATE INDEX owner_metadata_expires_at ON owner_metadata (expires_at);
