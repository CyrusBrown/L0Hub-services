-- The framework's own tables (@l0wservices/core). Every statement ends with a semicolon at the end of a line, and
-- there is no semicolon inside a string. A service's own migrations start at 0100 when they are kept as files.

CREATE TABLE IF NOT EXISTS l0w_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- small key/value state: the pinned hub key
CREATE TABLE IF NOT EXISTS l0w_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- the members connected to this service (a service-hello was accepted)
CREATE TABLE IF NOT EXISTS l0w_members (
  address TEXT PRIMARY KEY,
  our_token_id TEXT NOT NULL,
  release TEXT NOT NULL DEFAULT '',
  roles TEXT NOT NULL DEFAULT '[]',
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- delivery tokens this service issued (to a member): looked up by id on every envelope that carries one
CREATE TABLE IF NOT EXISTS l0w_tokens_issued (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  holder_kid TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS l0w_tokens_issued_holder ON l0w_tokens_issued (holder);

-- the delivery token a member gave this service (the signed document), attached to everything sent to that member
CREATE TABLE IF NOT EXISTS l0w_tokens_held (
  address TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  token TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- envelope ids seen per sender (kept 9 days)
CREATE TABLE IF NOT EXISTS l0w_seen (
  from_addr TEXT NOT NULL,
  id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (from_addr, id)
);

CREATE INDEX IF NOT EXISTS l0w_seen_at ON l0w_seen (seen_at);

-- the last seq used per recipient
CREATE TABLE IF NOT EXISTS l0w_seq (
  address TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

-- sealed, signed envelopes waiting for a 2xx (resent as the same bytes; next_at is the next attempt)
CREATE TABLE IF NOT EXISTS l0w_outbox (
  id TEXT PRIMARY KEY,
  to_addr TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  host TEXT NOT NULL,
  envelope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_status INTEGER
);

CREATE INDEX IF NOT EXISTS l0w_outbox_due ON l0w_outbox (next_at);

-- one row per call handled (no arguments, no results)
CREATE TABLE IF NOT EXISTS l0w_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  from_addr TEXT NOT NULL,
  method TEXT NOT NULL,
  ok INTEGER NOT NULL,
  code TEXT,
  ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS l0w_calls_at ON l0w_calls (at);

-- verified directory entries (5 minute cache; also the highest seq seen per identity, which never goes back)
CREATE TABLE IF NOT EXISTS l0w_directory (
  address TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  entry TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
