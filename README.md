# Habit Tracker

A minimal habit tracker in the style of [Daily Standup Generator](https://github.com/JoaquinAngelino/daily-standup-generator). Check habits off each day, see streaks, completion rates and a year heatmap, set goals with a deadline and a pace line, and keep a list of one-off tasks.

In English and Spanish (picked from the browser, switchable in the top bar), and built for phones first.

## Habits

- **Daily**: done or not, every day.
- **Weekly**: N times a week; the streak counts weeks that hit the target.
- **Monthly**: N times a month; the streak counts months that hit the target.

For amounts, weekly and monthly habits, **+** and **−** log more than once a day.
- **Amount**: a number toward a daily target, like 8 glasses or 20 pages.
- **Avoid**: log a slip when it happens; every other day counts as clean.

A goal counts done days (or the sum, for amounts) from the day it was set until its deadline, and shows whether you are ahead of or behind an even pace.

## Tasks

One-off things to do, buy or fix, with an optional due date. Tasks due today or overdue also show on **Today**.

## Storage

Everything saves in the browser first, compressed in IndexedDB, and works offline. **Settings → Sync with** picks where it also syncs, so every device you set up sees the same habits:

- **Google account**: sign in with Google and your data syncs through the Habit Tracker server (see [Server](#server)).
- **GitHub repository**: syncs to `data/habits.enc` on the `data` branch of a repository you own, with your own token.
- **This device only**: no sync.

Either way the data is compressed and then encrypted in the browser (AES-256-GCM, key from your passphrase through PBKDF2-SHA256 with 600,000 iterations) before it is sent, so neither the server nor GitHub can read it. Use the same passphrase on every device. A lost passphrase cannot be recovered, and neither can the data.

Changes save 30 seconds after your last edit, when you leave the app, or with **Sync now**. Changes from other devices arrive when the app opens, when you come back to it after 2 minutes or more, or with **Sync now**. Each sync reads the stored copy, replays your unsynced edits on top and writes it back only if nobody saved in between, so edits from two devices merge. Edits to the same habit on the same day keep the last one synced. Switching to another account or repository merges what the device already has into it.

### GitHub

The `data` branch is created on first save and keeps data commits off the branch the site deploys from. Every save is a commit. The repository can be private; if it is public, anyone can download the file and try passphrases offline (use four or more random words), and commit times are visible.

Create a fine-grained token limited to that repository with **Contents: Read and write**. It is sent only to `api.github.com`.

### Remember

With **Remember** on, the passphrase, sign-in and token stay in `localStorage`, which every GitHub Pages site under the same account can read; turn it off to keep them only until the tab closes.

## Server

`worker/` is a Cloudflare Worker with a D1 database behind **Sync with → Google account**. It stores each account's Google user ID and the same encrypted file, so it cannot read anyone's habits.

| Request | Does |
| --- | --- |
| `POST /session` | Trades a Google sign-in for a session token (180 days, renewed while used) |
| `DELETE /session` | Signs out |
| `GET /vault?have=N` | Returns the encrypted file as raw bytes with its version in `X-Version`, or `204` while `N` is still current |
| `PUT /vault?version=N` | Saves the bytes if `N` is still current, otherwise `409` with the newer file |
| `DELETE /account` | Deletes the account and its data |

Deploy, from `worker/`:

```sh
npx wrangler login
npx wrangler d1 create habit-tracker --location enam   # put the printed database_id in wrangler.toml
npx wrangler d1 migrations apply habit-tracker --remote
npx wrangler deploy                                     # after setting GOOGLE_CLIENT_ID in wrangler.toml
```

Run it locally with `npx wrangler d1 migrations apply habit-tracker --local` and `npx wrangler dev`.

## Develop

No build step.

```sh
npm start   # python3 -m http.server 8000
npm test    # node --test
```
