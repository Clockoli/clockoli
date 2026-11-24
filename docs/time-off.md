# Time off

Open **Time off** to see team absences for the whole year, inspect who is away each day, and plan or edit your own PTO in the calendar.

## Configure the team

Under **Settings → Time repositories → Time off tasks**, an administrator can choose an existing tracked task by title/URL or paste a task URL. Up to 100 URLs can be configured per repository. Members can see the list, but only admins can change it. The shared settings live in .clockoli/time-off.json on the repository's default branch.

This configuration also classifies historical entries on those tasks as time off. GitHub repository readers can see task URLs and descriptions; avoid sensitive personal or medical details.

## Year calendar

The calendar displays **12 months, one row per month**. Each day shows the **number of unique GitHub users** away, not the number of time entries. Colors indicate the number of teammates off; dates in the past have a softer appearance. Your own time off gets a blue outline. Clicking a date opens its details on the right, including GitHub avatars, time-off type, hours, and whether each entry is **Planned** or **Taken**.

Use the year arrows and repository filter to browse team availability. Team data is loaded from accessible time repositories, so a partial or failed GitHub read displays a warning rather than implying that missing colleagues are present.

## Add and edit time off

Select **Add time off** to open the side editor. Choose the time repository and a configured time-off task. Click individual days in the small month calendar, or Shift-click to select a range of weekdays. Click a weekend directly to include it. Selected days also appear as a blue preview in the year calendar; you can click dates there while editing. Navigate months without losing the selection.

New days default to **8 hours**. Change a day's hours directly inside its calendar cell, or change **Hours for new days** for subsequent selections. Add an optional description and select **Add time off**. Up to 50 selected days across a 500-day span can be saved together.

Clockoli chooses a free continuous interval automatically, preferring **09:00** or the next available time later that day. It checks locally known work immediately and verifies again against GitHub while syncing. If the hours cannot fit, it reports a conflict instead of silently overlapping work or making a partial write.

**My time off** remains accessible below the day details on the right. Use **Edit** or **Delete planned** on your own group. When an absence has both past and future days, only its future days can be edited or deleted; taken days are preserved. To deliberately correct or delete historical time off, use **Correct** or **Delete taken**.

One plan stores an ordinary time entry per selected day with a shared metadata.clockoli.timeOffGroupId. Edits/deletions are queued locally and synchronized in **one guarded atomic GitHub commit**, including changes spanning months. Teammates cannot change each other's time off.

## Reporting

PTO is **Planned** until its end timestamp and then becomes **Taken**. Only taken PTO contributes to tracked-time totals; PTO is never billable. Reports provides Work / Time off / Planned totals and a Time type filter. Exports include the time type, and Top tasks excludes time-off tasks from work rankings.

Clockoli does not manage leave allowances, holiday policies, requests, or approvals.
