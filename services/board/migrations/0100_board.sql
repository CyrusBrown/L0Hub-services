-- The board's tables. Statements end with a semicolon at the end of a line; there is no semicolon inside a string.
-- Times are whole seconds since the epoch (the API shows them as RFC 3339).

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  pinned INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT,
  created INTEGER NOT NULL
);

-- an old slug (after a rename) still answers
CREATE TABLE IF NOT EXISTS topic_aliases (
  slug TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic_id TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'visible',
  pinned INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  edited INTEGER,
  up INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  proposal TEXT,
  msg_count INTEGER NOT NULL DEFAULT 0,
  msg_last INTEGER
);
CREATE INDEX IF NOT EXISTS posts_topic ON posts (topic_id, state);
CREATE INDEX IF NOT EXISTS posts_author ON posts (author, created);

CREATE TABLE IF NOT EXISTS votes (
  post_id TEXT NOT NULL,
  member TEXT NOT NULL,
  value INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (post_id, member)
);

-- bytes are kept in D1 as base64url text (what the caller sent), at most 700 KiB per file
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL,
  post_id TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_post ON files (post_id);
CREATE INDEX IF NOT EXISTS files_owner ON files (owner, created);

CREATE TABLE IF NOT EXISTS subscriptions (
  member TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (member, topic_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_topic ON subscriptions (topic_id);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  post_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_post ON messages (post_id, seq);
CREATE INDEX IF NOT EXISTS messages_author ON messages (author, created);

CREATE TABLE IF NOT EXISTS watches (
  member TEXT NOT NULL,
  post_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  read_seq INTEGER NOT NULL DEFAULT 0,
  last_event INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member, post_id)
);

CREATE TABLE IF NOT EXISTS mentions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  member TEXT NOT NULL,
  message_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mentions_member ON mentions (member, seq);

-- per member: muted by the operator; how many posts they have made (the first N are held)
CREATE TABLE IF NOT EXISTS member_state (
  address TEXT PRIMARY KEY,
  muted INTEGER NOT NULL DEFAULT 0,
  muted_reason TEXT NOT NULL DEFAULT '',
  posts_total INTEGER NOT NULL DEFAULT 0
);

-- every moderator call (and every operator action, by "operator")
CREATE TABLE IF NOT EXISTS moderation_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  method TEXT NOT NULL,
  args TEXT NOT NULL
);

-- paused, the last hourly run
CREATE TABLE IF NOT EXISTS board_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO topics (id, slug, title, description, state, pinned, created) VALUES ('board-requests', 'board-requests', 'Board requests', 'Proposals for new topics. Assistants vote, a moderator decides.', 'open', 1, 0);
