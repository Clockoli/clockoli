# Settings

Settings controls your GitHub connection, time repositories, interface, project routing, billing preferences, and local backups.

![Settings showing the GitHub account and connected repository](images/settings.png)

The welcome screen appears until you connect your first time repository. Once setup is complete, open **Settings** from Clockoli's page navigation.

## GitHub account

Use this section to sign in, renew your connection, or **Sign out on this browser**.

Signing out removes local credentials but does not revoke GitHub authorization, uninstall the Clockoli App, or delete time in your repository. If a running timer or queued write would be put at risk, Clockoli blocks unsafe account changes.

For initial setup, see [Getting started](getting-started.md).

## Time repositories

Each connected repository offers **Check access**, **Open repository**, **Manage GitHub access**, **Make default**, and **Disconnect repository**.

Disconnecting affects this browser only. It does not delete GitHub data or change another teammate's access. You cannot disconnect while it would strand running or unsynced work.

Select **Add time repository** to connect another destination. Repository cards also show collaborator and invitation controls when you have the required permissions.

See [Time repositories](time-data-repository.md) and [Work as a team](teams.md).

## Local agent activity

You can optionally select the **sessions** folder inside your Codex data directory and the **projects** folder inside your Claude Code data directory. Clockoli asks for read-only directory access. This does not require a GitHub connection or change your agent's files. Each provider has **Pause**, **Scan now**, **Restore access**, and **Forget** controls; Forget removes that provider's saved permission handle and local observations. Chrome may stop granting access when the last Clockoli page closes or after a restart. In that case, open Settings and select **Restore access** from a user gesture; if Chrome offers **Allow on every visit**, choose it to enable persistent access. The initial folder selection may grant access only temporarily. Close all Clockoli pages and reopen Settings to check access; use Restore access rather than selecting the folder again, which clears that provider’s previous observations. Chrome controls whether access persists across restarts.

The technical status shows permission, scan backlog, visited/advanced files, bytes read, blocked files and safe error codes. A scan runs on a best-effort MV3 alarm while Chrome is running; sleep or a closed browser delays it. An incomplete backfill or a blocked file is not complete coverage. This first phase does **not** add an activity dashboard, project mapping, human-wait analysis, invoicing, or GitHub synchronization. Elapsed agent turns can include time spent waiting for human approval and are not billable time.

See [Data, privacy, and security](data-and-privacy.md#local-agent-activity) for the separate storage and backup boundary.

## Interface width

Choose a centered layout or use the available screen width for Activity, Reports, and Top tasks. This preference stays in the current browser and is not included in settings backups.

![Interface width and toolbar behavior settings](images/interface-settings.png)

## Toolbar button

Choose what happens when you select the extension's toolbar icon or the Clockoli stopwatch on GitHub:

- **Open Activity in a new tab** (default): opens or focuses Activity and passes the current page's task URL.
- **Open quick popup**: shows a small tracker with the current timer, description, recent entries, **Stop and save**, and **Open Activity in a new tab**.

The popup has no Timeline, Calendar, or List controls. **Open Activity in a new tab** remains visible even when entries scroll. On GitHub, opening a popup requires Chrome 127+; other supported versions fall back to Activity.

The choice stays in this browser. Until initial setup is complete, Clockoli sends you back to Settings or offers **Set up Clockoli**.

## Projects and routing

Choose a default time repository and optional client for unmatched URLs, and create ordered project rules for other destinations. See [Projects and routing](projects-and-routing.md).

### Activity display

**Recent entries shown in the main panel (days)** accepts 1–31 days (default 7). It only affects the recent-entry display, not the full Activity, Top tasks, or Reports history. Save it with **Save projects and routing**.

## Merge tasks

Use **Merge tasks** to combine records tracked under two task identities, such as a Clockify import and its GitHub issue.

1. Choose the **Period**, **Time repository**, and **People**. Select **All time** if older entries are involved.
2. Choose a **Task to replace**.
3. Choose an existing HTTP(S) task in **Replace with**.
4. Review the **Merge list** and select **Merge**.

![Merge tasks with a task to replace and replacement](images/merge-tasks.png)

Merge updates the selected records in one Git operation. It is not part of the ordinary background sync queue.

## Add-ons

Enable packaged integrations, including [Clockify migration](add-ons.md), and review their optional permissions before enabling them.

## More settings

During onboarding, these sections appear under **More settings**. After setup, they are available on the Settings page.

### Clients (invoice recipients)

Create clients for reports, rate cards, and invoices. Billing contact details are optional if you only need reports.

![Client fields](images/clients.png)

### Billable rates

Each rate belongs to a client and can have effective dates. Rates stay local to this browser. See [Billable rates](billable-rates.md).

### Invoicing

Configure your business details, payment accounts, invoice numbering, due dates, taxes, and notes. See [Invoicing](invoicing.md).

### Backup & restore

![Settings backup and restore controls](images/backup.png)

**Export settings** downloads a JSON backup of local preferences, project routing, client records, billable rates, invoicing details, and credential-free repository references.

Backups **exclude** GitHub credentials, active timers, pending writes, time records, and caches. Activity view, interface width, and toolbar behavior are also browser-specific rather than included in the backup.

**Import settings** validates the file and restores supported settings. Repository routes can be restored only for destinations already connected in this browser; import does not connect GitHub, verify access, add repositories, or replace the current default automatically.

Backups may contain confidential client, rate, and bank details. Store them securely, and export a new backup when you change those settings.

See [Settings backup exclusions](data-and-privacy.md#settings-backup-exclusions).

### Advanced

#### Full local backup

The **GitHub user in local data** label shows the GitHub username saved in this browser, including one restored from another backup. If you have signed out, Clockoli can still show the username recorded in a connected time repository. The label is not a new verification against GitHub.

**Export all local data** downloads a password-encrypted JSON backup containing the complete extension-local IndexedDB database and extension-page browser preferences. This includes the saved GitHub username, GitHub access/refresh tokens or PAT, active timers, pending writes, conflict state, cached records, billing and other local settings. Enter a password of at least eight characters and repeat it in the confirmation field; the two values must match before the file is exported. Store the file and password securely; anyone with both can use the saved GitHub credentials.

**Restore all local data** requires the backup password in the first field, but not the confirmation field. If the password is missing, the file picker stays closed and focus moves to the highlighted password field. Restoring replaces the entire local database and extension-page browser preferences with the selected encrypted backup. Settings and unsynced work in this browser are replaced, not merged. If the current and backed-up GitHub sign-ins have the same verified GitHub user ID and sign-in method, Clockoli keeps the current credentials unless they are known to be expired. When restoring a different GitHub App user's backup over an existing GitHub App sign-in, Clockoli keeps the signed-in user's credentials and restores the backed-up repositories, personal branches and storage usernames. This requires an online, read-only verification of repository write access and branch ownership using the current sign-in (with normal token renewal if needed). The original user's tokens are never used. New time records and their actor metadata belong to the restored storage user, while GitHub requests and commits use the actual signed-in identity. Pending operations are restored and may sync to the restored branches. Settings distinguishes the storage user from the signed-in account. Incompatible sign-in methods or unverifiable identities are rejected without changing local data. A browser without a current sign-in (or a known-expired session of the same account) can still restore the backed-up credentials. Clockoli validates and decrypts the file before changing its IndexedDB database, then reloads the extension. It does not upload the backup to GitHub or change repository data. A restore link is also available during first-time setup, before connecting GitHub.

This is different from the credential-free **Backup & restore** settings feature above. If the backup's GitHub credentials are needed (for example, on a new browser), GitHub access is subject to expiration, revocation and token rotation since the export. A previously used refresh token cannot renew access again; you may need to reconnect. Same-account and fresh-browser restore do not require network access. Cross-account restore requires GitHub access for verification.

#### Diagnostics

**Show queue diagnostics in the tracking panel** displays a local operation log for investigating sync issues. Leave it disabled unless you are troubleshooting.

#### Use a personal access token

A single-repository alternative if the GitHub App cannot be used. See [PAT setup](getting-started.md#use-a-personal-access-token-instead).

#### Recovery and access

- **Clear cache** removes downloaded report files, task indexes, task metadata, saved report/task views, and exchange rates so Clockoli reads fresh data. Your GitHub sign-in, connected repositories, settings, running timer and pending changes remain intact. Recent tracking records, weekly intervals and locally recorded overlap guards are kept as a working set until a successful refresh replaces them; they are needed to prevent overlapping time and safely apply edits, even when there are no pending writes. Cached totals and passive refresh markers are invalidated (pending local views stay available). Reload already open Clockoli pages to fetch fresh data. The first load may take longer; no GitHub data is changed.
- **Reset to defaults** removes the entire local database and browser preferences, including credentials, saved username, running timers, and **unsynced work**. This cannot be undone without a backup. Reconnect to GitHub afterward to use the account's real username.
- **Revoke GitHub sign-in** opens GitHub settings to revoke Clockoli's user authorization. It does not uninstall the GitHub App or delete repository records.

## Appearance

Use the sun/moon control on Clockoli pages to switch between light and dark themes. The choice stays local and is shared across the extension's pages and popup.
