-- The spaces service's tables. Statements end with a semicolon at the end of a line; there is no semicolon inside a string.
-- Times are whole seconds since the epoch (the API shows them as RFC 3339). Nothing here is plaintext: documents are
-- stored as signed, and the service never holds a space key.

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  head TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- a name is unique per creator among the spaces not being deleted
CREATE UNIQUE INDEX IF NOT EXISTS spaces_creator_name ON spaces (creator, name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS spaces_creator ON spaces (creator);

CREATE INDEX IF NOT EXISTS spaces_deleted ON spaces (deleted_at);

CREATE TABLE IF NOT EXISTS space_members (
  space TEXT NOT NULL,
  address TEXT NOT NULL,
  state TEXT NOT NULL,
  since INTEGER NOT NULL,
  since_epoch INTEGER NOT NULL,
  rekey_kid TEXT,
  PRIMARY KEY (space, address)
);

CREATE INDEX IF NOT EXISTS space_members_address ON space_members (address);

-- one space-key document per (space, epoch, member), as signed by the creator
CREATE TABLE IF NOT EXISTS space_keys (
  space TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  member TEXT NOT NULL,
  member_kid TEXT NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space, epoch, member)
);

-- space-version documents, as received (the payload string is what the version id hashes)
CREATE TABLE IF NOT EXISTS versions (
  space TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  doc TEXT NOT NULL,
  author TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS versions_id ON versions (space, id);

CREATE TABLE IF NOT EXISTS version_blobs (
  space TEXT NOT NULL,
  seq INTEGER NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (space, seq, blob)
);

CREATE INDEX IF NOT EXISTS version_blobs_blob ON version_blobs (space, blob);

-- blobs stored in R2 at <space>/<id>
CREATE TABLE IF NOT EXISTS blobs (
  space TEXT NOT NULL,
  id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space, id)
);

CREATE INDEX IF NOT EXISTS blobs_created ON blobs (created_at);

CREATE TABLE IF NOT EXISTS locks (
  space TEXT NOT NULL,
  tag TEXT NOT NULL,
  holder TEXT NOT NULL,
  sealed TEXT NOT NULL,
  taken INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (space, tag)
);

CREATE INDEX IF NOT EXISTS locks_expires ON locks (expires);

-- transfer tickets that were used (the HMAC is the key); rows go when the ticket would have expired anyway
CREATE TABLE IF NOT EXISTS tickets (
  mac TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tickets_expires ON tickets (expires);
