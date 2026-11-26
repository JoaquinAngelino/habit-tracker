# Habit Tracker

A minimal habit tracker in the style of [Daily Standup Generator](https://github.com/JoaquinAngelino/daily-standup-generator). Check habits off each day, see streaks, completion rates and a year heatmap, set goals with a deadline and a pace line, and keep a list of one-off tasks.

In English and Spanish (picked from the browser, switchable in the top bar), and built for phones first. It installs as an app from the browser, or with **Settings → Install app** where the browser allows it.

## Habits

- **Daily**: done or not, every day.
- **Weekly**: N times a week; the streak counts weeks that hit the target.
- **Monthly**: N times a month; the streak counts months that hit the target.
- **Amount**: a number toward a daily target, like 8 glasses or 20 pages.
- **Timer**: minutes toward a daily target. **Start** and **Stop** on **Today** add the time that passed, and it keeps running if the app is closed.
- **Avoid**: log a slip when it happens; every other day counts as clean.

For amounts, weekly and monthly habits, **+** and **−** log more than once a day. **Habits → From a template** adds a common habit already filled in.

### Days off

Daily, amount and timer habits can repeat every day, on some days of the week, or every few days counted from their start date. Any single day can be skipped, and **Habits → Breaks** pauses one habit or all of them between two dates, for a holiday or sick days. Avoid habits keep counting through a break.

A day off does not break the streak or count against the completion rate, and still counts if you log it anyway. For weekly and monthly habits, a week or month that a break touches is off unless its target was met.

### Order, groups and times

The arrows in **Habits** set the order. A habit with a group, such as Morning, is listed with the rest of its group on **Today**, where **Mark all done** checks off the group's daily habits at once. A habit with a time of day shows it, and **Today** lists habits by time.

### Notes and mood

Each habit takes a note per day, and **Today → The day** takes a mood and an energy level from 1 to 5 and a note for the day itself.

### Progress

Besides streaks, rates and the heatmap, **Progress** shows:

- **Week**: what was due and done, against the week before, with tasks finished and average mood.
- **By day of the week**: how often each habit got done on each weekday over the last 90 days.
- **Patterns**: habits that tend to get done or missed on the same days, and habits whose done days have a different average mood. They need about two weeks of history.
- **Year**: check-ins, active days, longest streak and totals for the year.

**Share** on a habit makes a picture of its streak and last six months, shared through the phone's share sheet or downloaded.

A goal counts done days (or the sum, for amounts) from the day it was set until its deadline, and shows whether you are ahead of or behind an even pace.

## Tasks

Things to do, buy or fix, with an optional due date. Tasks due today or overdue also show on **Today**.

A task can have steps to check off, and can repeat daily, weekly or monthly: finishing it opens the next one, due on the first date after today counted from its due date.

## Storage

Everything saves in the browser first and works offline, including opening the app with no connection. **Settings → Sync with** picks where it also syncs, so every device you set up sees the same habits:

- **Account**: sign in with Google or a passkey and your data syncs through the Habit Tracker server (see [Server](#server)).
- **GitHub repository**: syncs to `data/habits.enc` on the `data` branch of a repository you own, with your own token.
- **This device only**: no sync. New visitors start here.

When syncing, the data is compressed and then encrypted in the browser (AES-256-GCM, key from your passphrase through PBKDF2-SHA256 with 600,000 iterations) before it is sent, so neither the server nor GitHub can read it. Use the same passphrase, of at least 8 characters, on every device. A lost passphrase cannot be recovered, and neither can the data. **Settings → Download my data** saves everything as a readable JSON file.

**Settings → Import data** adds a file to what is already there. It takes a file from **Download my data**, or a CSV with a `Date` column and either one column per habit or `habit` and `value` columns. Habits are matched by name and new ones are created. A CSV whose values are all Loop Habit Tracker's codes is read as its `Checkmarks.csv`: 2 is done and 3 is skipped. A check-in log like Habitify's (`Habit`, `Date`) and an export like Streaks' (`title`, `entry_date`, `entry_type`, `quantity`) are read as one row per entry. None of the three has been tried on a real export: the column names come from those apps' help pages and a community converter.

**Settings → Download calendar** saves an `.ics` file with each habit as a repeating event and each open task with a due date, to import into a calendar app. It is a snapshot: later changes need a new download.

The copy on the device itself is compressed but not encrypted, in IndexedDB, with unsynced edits in `localStorage`. The site is served from `joaquinangelino.github.io`, which every GitHub Pages site under that account shares, so those sites can read it too.

Changes save 30 seconds after your last edit, when you leave the app, or with **Sync now**. Changes from other devices arrive when the app opens, when you come back to it after 2 minutes or more, or with **Sync now**. A save goes through only if nobody saved in between; otherwise the newer file is fetched and your unsynced edits are replayed on top of it, so edits from two devices merge. When both change the same thing, the last one synced wins: a habit's entry, skip or note for a day, the day's mood and note together, or a whole habit, task, goal or break. Editing something another device deleted brings it back.

Data that has never synced merges into the first account or repository it syncs with. A device that switches between targets takes each one's data as it is, plus its own unsynced edits. A different Google account never receives data that came from another one: signing in with it starts empty, and the previous account's unsynced edits are dropped.

### GitHub

The `data` branch is created on first save and keeps data commits off the branch the site deploys from. Every save is a commit. The repository can be private; if it is public, anyone can download the file and try passphrases offline (use four or more random words), and commit times are visible.

Create a fine-grained token limited to that repository with **Contents: Read and write**. It is sent only to `api.github.com`.

### Account extras

With an account, **Settings** also offers:

- **Add a passkey**: a second way in to the same account. It works only within 10 minutes of signing in, and signs out the account's other devices, so a stolen session cannot quietly keep access. **Remove passkeys** takes them all off again, under the same 10-minute rule. **New account with a passkey** makes an account with no Google sign-in at all.
- **Create a recovery key**: 24 characters to write down. The passphrase is encrypted with it in the browser and kept on the server, and **Forgot the passphrase?** brings it back. Without a recovery key a lost passphrase is still unrecoverable. A new key replaces the old one, and changing the passphrase needs a new key.
- **Share progress with a link**: the streaks, 30-day rate and last 12 weeks of the habits you tick, on a page anyone with the link can open. It is encrypted with a key that sits after the `#` of the link, which browsers do not send to servers. The page can follow several links at once, under each person's name, so a coach or a group sees everyone's progress together; the list is kept in that browser.
- **Publish a calendar link**: an address calendar apps subscribe to, kept up to date after each sync. It is the one thing stored **unencrypted**: the server and anyone with the link can read the names and times of habits and dated tasks.
- **Remind me at each habit's time**: a notification at the times set on habits, on this device. The server gets the times and the browser's push address, and sends a push with no text. Shown only once the server has push keys (see [Server](#server)).

Links and reminders are refreshed after a sync when what they show has changed. Signing out makes the device forget them but leaves them published; sign in and turn them off to remove them.

### Remember

With **Remember** on, the passphrase, sign-in, email and token stay in `localStorage`; turn it off to keep them only until the tab closes. The habits themselves stay on the device either way, until **Sign out**.

## Server

`worker/` is a Cloudflare Worker with a D1 database behind **Sync with → Account**. It stores each account's Google user ID or passkey and the same encrypted file, so it cannot read anyone's habits. The only readable thing it can hold is a calendar link someone chose to publish.

| Request | Does |
| --- | --- |
| `POST /session` | Trades a Google sign-in for a session token (180 days, renewed while used; at most 20 per account) |
| `DELETE /session` | Signs out |
| `GET /vault` | Returns the encrypted file as raw bytes with its version in `X-Version`, or `204` while the `X-Have` version is still current |
| `PUT /vault` | Saves the bytes if the `X-Version` sent (`0` for none yet) is still current, otherwise `409` with the newer file |

Versions are random, so a vault recreated after a deletion never matches one a device still holds, and they travel in headers so the URL, and with it the browser's cached CORS preflight, stays the same.
| `DELETE /account` | Deletes the account and its data |
| `POST /passkey/challenge` | Returns a challenge, good once and for 5 minutes |
| `POST /passkey/register` | Stores a passkey's public key: for a new account, or for the account of a session that began in the last 10 minutes, whose other sessions then end |
| `GET /passkeys`, `DELETE /passkeys` | Counts an account's passkeys, and removes them all, with the same 10-minute rule, unless a passkey is its only way in |
| `POST /passkey/session` | Trades a passkey signature over a challenge for a session token |
| `PUT /link/feed`, `PUT /link/share` | Publishes the body at an unguessable address and returns its token; again keeps the token |
| `DELETE /link/feed`, `DELETE /link/share` | Takes it down |
| `GET /feed/<token>.ics`, `GET /share/<token>` | Returns it to anyone |
| `PUT /recovery`, `GET /recovery` | Saves and returns the passphrase as encrypted by a recovery key |
| `PUT /reminders` | Sets the minutes of the UTC day at which a push address is sent to; none removes it |

A cron trigger runs every minute and sends a push with no body to the addresses due. Passkeys are registered without attestation, so the server takes the public key as the browser reports it. Push addresses are accepted only on the browsers' own push services.

Reminders need a VAPID key pair: `npx web-push generate-vapid-keys`, then put the public key in `VAPID_PUBLIC_KEY` in both `wrangler.toml` and `src/server.js`, and run `npx wrangler secret put VAPID_PRIVATE_KEY`.

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
