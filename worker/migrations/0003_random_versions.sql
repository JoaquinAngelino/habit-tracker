-- Versions become random tokens, so a vault recreated after a wipe or an account deletion never reuses one
-- that a device still holds. Existing versions are kept as text.
CREATE TABLE vaults_next (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  envelope BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO vaults_next (user_id, version, envelope, updated_at) SELECT user_id, CAST(version AS TEXT), envelope, updated_at FROM vaults;
DROP TABLE vaults;
ALTER TABLE vaults_next RENAME TO vaults;
