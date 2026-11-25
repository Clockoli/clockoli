# Time off

Open **Time off** to see when teammates are away, browse the whole year, and add or remove your own time off directly from the calendar.

## Configure the team

Under **Settings → Time repositories → Time off tasks**, an administrator can choose existing tracked tasks by title/URL or paste a task URL. Up to 100 URLs can be configured per repository. Other members can see the list, but only admins can change it. Shared settings are stored in .clockoli/time-off.json on the repository's default branch.

Configuring a PTO task also classifies its historical time entries as time off. Task URLs and descriptions are visible to anyone with repository read access, so avoid private medical or personal details.

## Year calendar and daily details

The annual calendar shows **12 month rows**. Days with exactly one teammate away show their **GitHub avatar**; days with multiple absences show the number of distinct people away. All dates before today are strongly faded and subtly hatched, including days without any PTO. Your own time off has a bright yellow outline.

**Hover over a day** to see the list of teammates in the right panel instantly. **Clicking a day** also selects it for new time off and keeps that day's details visible while the cursor stays inside the calendar. After leaving the calendar, returning to any cell resumes hover previews. The right panel shows each person's small GitHub avatar, name, hours on the right, optional description, and a delete icon only for your own saved records. There are no separate Planned/Taken count headings or task titles in the day details.

Above the calendar, type a GitHub username to see autocomplete suggestions from the locally loaded PTO records and connected account. Select a suggestion to show **only that user's time off** in the year grid and daily details; use the **×** control to show everyone again. Searching makes no GitHub API requests. The year totals at the top right show the number of **distinct days taken and planned** by the selected user, or **your own** days when nobody is selected. If a day has multiple entries, it counts once; a day with any unfinished PTO is counted as planned. The time-repository filter also applies to these totals.

Navigate between years, filter by time repository, or choose **This year**. Successful year scans are cached locally in IndexedDB, and revisiting a year does not make another GitHub request. **Refresh** is the explicit way to fetch updated data. Caches are scoped to the account and configured time repositories; changing PTO settings invalidates them. Incomplete remote reads show a warning and do not replace a complete cached year.

## Add time off

1. Click one or more dates in the annual calendar. Click a selected day again to remove it from the selection. You can also **Shift-click** a range of weekdays; weekends can be selected individually.
2. **Add time off (N days)** counts only selected dates where **you do not already have PTO**, including across your connected time repositories. Dates where you already have PTO stay selected for possible deletion, but do not increase Add's count. If all selected dates already have your PTO, Add stays disabled and its tooltip explains why.
3. Click **Add time off** to open a short dialog containing **only eligible new dates**. Choose the **Time repository** and **Type** (configured PTO task) when there is more than one option. Clockoli automatically selects the only available repository or task and hides its selector. Set **Hours per day** (8 by default) and an optional **Description**. The selected dates are shown for confirmation; there is no second calendar or manual start time.
4. Save. Clockoli immediately queues the complete plan locally. Your teammates will see it after GitHub synchronization. Up to 50 days across a 500-day span can be saved together.

Clockoli automatically chooses a free continuous interval, preferring 09:00 or the next available slot later that day. It checks local time immediately and verifies against GitHub when syncing. If the requested hours cannot fit, it reports a conflict and avoids overlapping or partially saving the plan.

## Remove a day

Hover over or click a day with your own saved time off. In the right-hand details, use the **trash icon beside your entry**, then confirm. **Only that one entry is removed**, even if it belongs to a group spanning many days.

To remove several dates at once, select days in the year calendar. If one or more selected days contain your own saved PTO, a **Delete time off (N days)** button appears alongside Add. The count is the number of selected dates with **your own** PTO, not all selected dates or the number of underlying entries. Confirm to delete all your PTO entries for those dates, including historical and future entries. Other dates in your PTO groups and everyone's else PTO remain untouched. Pending entries cannot be deleted again until their previous sync finishes.

For each repository, the batch is queued locally and saved in **one guarded atomic GitHub commit**, checking the exact task, group ID and timestamps of every targeted entry. If your selection includes multiple repositories, each repository gets its own atomic operation; a failure in one is reported instead of hiding partial success. The **My upcoming time off** list is read-only for navigation; there is no separate Past time off list or editing flow.

## Reporting and billing

PTO is **Planned** until its end timestamp and then becomes **Taken**. Only taken PTO contributes to tracked-time totals; PTO is never billable. Reports includes Work / Time off / Planned totals and the Time type filter. Exports include the time type, and Top tasks excludes time-off tasks from working-time rankings.

Clockoli does not manage allowances, holiday policies, requests or approvals.
