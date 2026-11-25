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

Everything saves in the browser first and works offline. With a repository, token and passphrase in **Settings**, it also syncs to `data/habits.enc` on the `data` branch of that repository, so every device you set up sees the same habits. The branch is created on first save and keeps data commits off the branch the site deploys from.

The file is encrypted in the browser (AES-256-GCM, key from your passphrase through PBKDF2-SHA256 with 600,000 iterations) before it is sent. The repository is public, so:

- Anyone can download the file and try passphrases offline. Use four or more random words.
- Commit times are visible, though not what changed.
- A lost passphrase cannot be recovered, and neither can the data.

Each sync reads the file, replays your unsynced edits on top and writes it back, so edits from two devices merge. Edits to the same habit on the same day keep the last one synced.

## Token

Create a fine-grained token limited to this repository with **Contents: Read and write**. It is sent only to `api.github.com`. With **Remember** on, the token and passphrase stay in `localStorage`, which every GitHub Pages site under the same account can read; turn it off to keep them only until the tab closes.

## Develop

No build step.

```sh
npm start   # python3 -m http.server 8000
npm test    # node --test
```
