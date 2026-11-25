-- Envelopes are stored as raw bytes instead of base64 JSON. No real data existed yet, so the old table is dropped.
DROP TABLE vaults;

CREATE TABLE vaults (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  envelope BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
