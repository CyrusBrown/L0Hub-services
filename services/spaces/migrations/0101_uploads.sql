-- Uploads in flight, held against the service's total (TOTAL_BYTES) between the transfer's start and its commit.
CREATE TABLE uploads (
  space TEXT NOT NULL,
  id TEXT NOT NULL,
  size INTEGER NOT NULL,
  started INTEGER NOT NULL,
  PRIMARY KEY (space, id)
);
CREATE INDEX uploads_started ON uploads (started);
