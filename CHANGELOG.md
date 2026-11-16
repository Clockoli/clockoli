# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-11-16

### 📋 Release Summary

First public release of Clockoli, a browser extension that tracks time on any task URL and writes the records to a private GitHub repository you control. There is no Clockoli account or server: the extension talks directly to GitHub. Each completed entry is one line of JSON in a monthly file, so `git clone` backs up all your time and `git log` shows every synchronized change. This release covers tracking, editing, reports, invoices, shared team repositories and Clockify import. Chrome and other Chromium browsers (102+) are supported; Firefox (140+) and Safari (18+, macOS) builds are previews.

### ⏱️ Tracking

- Start a timer on any HTTP(S) page from the toolbar button, or from the stopwatch on GitHub issue and pull-request pages.
- The page URL identifies the task; a title is optional. Links to the same GitHub issue or pull request count as one task, and GitHub Projects issue panes track the underlying issue.
- One timer runs per GitHub account across repositories and browsers: starting another task saves the current one first.
- Timer changes are saved in the browser first and synchronized with GitHub in the background, so tracking continues while GitHub is offline or rate-limited.
- Live **Today** and **This week** totals, and **Top tasks** to restart recent work.
- GitHub issues and pull requests show each participant's tracked time.
- Optional quick popup instead of the Activity tab, multi-line descriptions up to 2,000 characters, and a confirmation before stopping a timer that ran longer than 12 hours.

### ✏️ Editing time

- Edit entries in Timeline, Calendar or List view. Drag and resize blocks; moving an entry into its neighbour adjusts the neighbour in the same commit.
- Add completed entries in bulk, delete entries, and correct a running timer's start time.
- Merge two task identities that refer to the same work, for example a Clockify import and its GitHub issue.

### 📊 Reports and invoicing

- Reports across personal and organization time repositories, with breakdowns by day, week, month, person, source or task.
- Export CSV or JSON timesheets, or print a report to PDF.
- Effective-dated hourly rates per person for each client. Mixed currencies are converted at each day's exchange rate.
- Numbered invoices with taxes, created from a filtered report and printed or saved as PDF in the browser.
- Rates, clients and invoice details stay in browser storage and are never written to the time repository.

### 👥 Teams

- Teammates track into the same private repository, each on a personal branch, and Reports shows them as one view.
- Repository administrators can invite teammates from Settings.
- Project routing rules send each task URL to the right time repository and client.
- Optional Clockify migration add-on: imports completed history from a signed-in Clockify tab, with a preview and explicit mapping of Clockify people to GitHub accounts.

### ⚙️ Setup and settings

- GitHub sign-in through device flow: you enter a one-time code on github.com, with no token to create or paste. A personal access token remains available for single-repository setups.
- Connect an existing private repository or create one from the Clockoli template.
- Light and dark themes, and a centered or full-width layout.
- Settings backup and restore as a JSON file. Backups exclude GitHub credentials and time records.

### 🔒 Data and privacy

- Records use a versioned, documented format (`schema_version` 1): completed entries in `times/{YYYY-MM}/{login}.jsonl`, the running timer under `active/`.
- Data goes only to GitHub, plus currency codes and dates to the Frankfurter exchange-rate service when a report converts currencies. No analytics.
- GitHub credentials stay in the extension's background code; web pages never receive them.

### 🌐 Browsers and packages

- Chrome and Chromium 102+ through the Chrome Web Store, with automatic updates.
- Firefox 140+ and Safari 18+ (macOS) preview builds attached to the GitHub release. They install manually and do not update automatically.
- Licensed under GPL-3.0-only. Each release includes a matching source archive.

### ⚠️ Known limitations

- No mobile app, no reminders and no side-by-side conflict editor. Some sync conflicts need your action.
- Everyone who tracks time needs a GitHub account. GitHub outages and API rate limits affect Clockoli.
- Git history shows edits, but repository administrators can rewrite it. It is not a tamper-proof audit log.

### 📚 Documentation

- User guides for setup, tracking, editing, reports, invoicing, teams, sync and troubleshooting, plus a separate technical reference for the data format and repository operations (#95).
