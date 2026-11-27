-- An account made with a passkey has no Google ID; its users.google_sub holds 'passkey:' and an ID of its own,
-- which keeps the column's NOT NULL and UNIQUE without rebuilding a table other tables point at.
CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE challenges (
  value TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX challenges_expires_at ON challenges (expires_at);

-- Requests per address and route in each time slot, for the routes anyone can call.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  slot INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, slot)
);

-- What an account publishes at an unguessable address: a calendar feed in plain text, or a progress page
-- encrypted with a key only the link carries.
CREATE TABLE links (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, kind)
);

-- The passphrase, encrypted with a recovery key the server never sees.
CREATE TABLE recovery (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Minutes of the day, in UTC, at which a device wants a push. Nothing says what it is for.
CREATE TABLE reminders (
  endpoint TEXT NOT NULL,
  minute INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (endpoint, minute)
);

CREATE INDEX reminders_minute ON reminders (minute);
CREATE INDEX reminders_user ON reminders (user_id);

-- When each session began, so adding a way in can be limited to someone who has just signed in.
-- Sessions from before this are treated as old.
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
