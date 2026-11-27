-- The passkey that opened each session, so a passkey-only account can remove its other passkeys.
-- NULL for Google sessions and sessions from before this.
ALTER TABLE sessions ADD COLUMN passkey_id TEXT;

CREATE INDEX sessions_user ON sessions (user_id);

-- UTC weekdays a reminder fires on: bit n is getUTCDay() n. Existing reminders fire every day.
ALTER TABLE reminders ADD COLUMN days INTEGER NOT NULL DEFAULT 127;
