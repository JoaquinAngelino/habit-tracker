# Habit Tracker

A minimal habit tracker in the style of [Daily Standup Generator](https://github.com/JoaquinAngelino/daily-standup-generator). Check habits off each day, see streaks, completion rates and a year heatmap, set goals with a deadline and a pace line, and keep a list of one-off tasks.

In English and Spanish (picked from the browser, switchable in the top bar), and built for phones first. It installs as an app from the browser, or with **Settings → Install app** where the browser allows it.

## Habits

- **Daily**: done or not, every day.
- **Weekly**: N times a week; the streak counts weeks that hit the target.
- **Monthly**: N times a month; the streak counts months that hit the target.
- **Amount**: a number toward a daily target, like 8 glasses or 20 pages.
- **Avoid**: log a slip when it happens; every other day counts as clean.

For amounts, weekly and monthly habits, **+** and **−** log more than once a day.

Daily and amount habits can be limited to some days of the week, and any single day can be skipped. A day off does not break the streak or count against the completion rate, and still counts if you log it anyway.

A goal counts done days (or the sum, for amounts) from the day it was set until its deadline, and shows whether you are ahead of or behind an even pace.

## Tasks

One-off things to do, buy or fix, with an optional due date. Tasks due today or overdue also show on **Today**.

## Storage

Everything saves in the browser first and works offline, including opening the app with no connection. **Settings → Sync with** picks where it also syncs, so every device you set up sees the same habits:

- **Google account**: sign in with Google and your data syncs through the Habit Tracker server (see [Server](#server)).
- **GitHub repository**: syncs to `data/habits.enc` on the `data` branch of a repository you own, with your own token.
- **This device only**: no sync. New visitors start here.

When syncing, the data is compressed and then encrypted in the browser (AES-256-GCM, key from your passphrase through PBKDF2-SHA256 with 600,000 iterations) before it is sent, so neither the server nor GitHub can read it. Use the same passphrase, of at least 8 characters, on every device. A lost passphrase cannot be recovered, and neither can the data. **Settings → Download my data** saves everything as a readable JSON file.

The copy on the device itself is compressed but not encrypted, in IndexedDB, with unsynced edits in `localStorage`. The site is served from `joaquinangelino.github.io`, which every GitHub Pages site under that account shares, so those sites can read it too.

Changes save 30 seconds after your last edit, when you leave the app, or with **Sync now**. Changes from other devices arrive when the app opens, when you come back to it after 2 minutes or more, or with **Sync now**. A save goes through only if nobody saved in between; otherwise the newer file is fetched and your unsynced edits are replayed on top of it, so edits from two devices merge. When both change the same thing, the last one synced wins: a day's log entry, or a whole habit, task or goal. Editing something another device deleted brings it back.

Data that has never synced merges into the first account or repository it syncs with. A device that switches between targets takes each one's data as it is, plus its own unsynced edits. A different Google account never receives data that came from another one: signing in with it starts empty, and the previous account's unsynced edits are dropped.

### GitHub

The `data` branch is created on first save and keeps data commits off the branch the site deploys from. Every save is a commit. The repository can be private; if it is public, anyone can download the file and try passphrases offline (use four or more random words), and commit times are visible.

Create a fine-grained token limited to that repository with **Contents: Read and write**. It is sent only to `api.github.com`.

### Remember

With **Remember** on, the passphrase, sign-in, email and token stay in `localStorage`; turn it off to keep them only until the tab closes. The habits themselves stay on the device either way, until **Sign out**.

## Server

`worker/` is a Cloudflare Worker with a D1 database behind **Sync with → Google account**. It stores each account's Google user ID and the same encrypted file, so it cannot read anyone's habits.

| Request | Does |
| --- | --- |
| `POST /session` | Trades a Google sign-in for a session token (180 days, renewed while used; at most 20 per account) |
| `DELETE /session` | Signs out |
| `GET /vault` | Returns the encrypted file as raw bytes with its version in `X-Version`, or `204` while the `X-Have` version is still current |
| `PUT /vault` | Saves the bytes if the `X-Version` sent (`0` for none yet) is still current, otherwise `409` with the newer file |

Versions are random, so a vault recreated after a deletion never matches one a device still holds, and they travel in headers so the URL, and with it the browser's cached CORS preflight, stays the same.
| `DELETE /account` | Deletes the account and its data |

Deploy, from `worker/`:

```sh
npx wrangler login
npx wrangler d1 create habit-tracker --location enam   # put the printed database_id in wrangler.toml
npx wrangler d1 migrations apply habit-tracker --remote
npx wrangler deploy                                     # after setting GOOGLE_CLIENT_ID in wrangler.toml
```

Run it locally with `npx wrangler d1 migrations apply habit-tracker --local` and `npx wrangler dev`. The app calls the URL in `API` in `src/server.js`, and the worker answers only the origins in `ALLOWED_ORIGINS` in `wrangler.toml`.

## Develop

No build step.

```sh
npm start   # python3 -m http.server 8765, an origin the worker allows
npm test    # node --test
```
