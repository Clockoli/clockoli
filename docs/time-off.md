# Time off

Plan, review, and change your team's absences on the **Time off** page. Clockoli stores PTO as ordinary time entries without adding leave balances or approval workflows.

## Configure your team

Under **Settings → Time repositories**, open a repository's **Time off tasks** section. A repository administrator can search for tracked tasks by title/URL, select an existing task or paste its URL, and save up to 100 PTO task URLs. Other repository members can view the list. Each repository's list is shared via `.clockoli/time-off.json` on its default branch.

Because this configuration reclassifies existing time entries, changing the list also changes historical PTO reporting. Task URLs and descriptions are visible to anyone with read access to the time repository. Avoid sensitive medical or personal information.

## Plan or record PTO

Open **Time off → My time off → Add time off**.

1. Choose a **Time repository** and **Type** (one of its configured PTO tasks). When there is only one configured task, Clockoli selects it automatically.
2. Enter **From** and **To**. Both past and future dates are supported.
3. Set **Hours per day** (8 by default) and **Start time** (09:00 by default). Weekend days are excluded by default; enable **Include weekends** if needed.
4. Review the **Days included** list. Uncheck individual dates or adjust a day's hours.
5. Optionally add a description, then select **Add time off**.

One plan adds one ordinary entry per selected day and tags the entries with the same `metadata.clockoli.timeOffGroupId`. This makes the plan editable as one group; the repository's storage schema stays unchanged. Clockoli supports up to 50 selected days per save and a date-range picker of up to 121 calendar days.

PTO is placed **at the exact selected hours**. Unlike the normal Multiple days free-slot planner, it is never silently moved into another time of day to avoid an overlap. If time off conflicts with work or another entry, edit the conflicting time first.

## Review and change your PTO

**My time off** groups a new PTO plan into one card with dates, days, hours and status. Select **Edit** to change its dates, included days, daily hours or description. Select **Cancel** to remove the planned days. Each edit or cancellation is one locally queued group operation and one guarded GitHub commit when synchronized.

For an absence in progress, **Edit remaining** and **Cancel remaining** leave completed days intact. To correct already taken time off, select **Correct** deliberately. Older PTO records without a group ID remain individual cards; Clockoli does not guess which neighboring records belong to a single absence.

Local changes are accepted immediately and synchronized in the background. Changes appear to teammates after the GitHub sync succeeds. GitHub conflicts are kept for review rather than overwriting another change.

## Team calendar

Open **Time off → Team calendar** to browse weeks and see PTO recorded by people in your connected time repositories. Switch repositories or navigate to past/future weeks. Select a marked day to see its task, hours and description. Teammates can view each other's absences but can edit only their own time.

If the remote read is incomplete, Clockoli warns that the calendar may be missing entries.

## Reporting and billing

A future PTO entry is **Planned** until its end timestamp. After that point, it becomes **Taken** automatically. Only taken PTO contributes to Total tracked and the Time off total; it never contributes to Work or billable amounts.

Reports retains Work / Time off / Planned totals and the Time type chart filter. CSV and JSON exports include the time type. PTO tasks are excluded from Top tasks working-time rankings, although their time entries remain visible in Activity.

Clockoli does not manage leave allowances, requests, holiday policies or approvals.
