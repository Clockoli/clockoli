# Team time off

Clockoli tracks time off using **ordinary task URLs and time entries**. No new work-record format or approval system is needed.

## Configure a repository

Under **Settings → Time repositories**, expand the relevant repository and open **Time off tasks**. A GitHub repository administrator can enter up to 100 canonical HTTP(S) task URLs, one per line. For example, a shared GitHub issue named *Time off*. Ordinary repository members can view the list.

Clockoli stores the shared list in `.clockoli/time-off.json` on that repository's default branch. The list is specific to the time repository: the same URL in another repository is not automatically PTO. Changing the list also changes how existing records are classified in reports. Each change checks the GitHub file revision to prevent silently overwriting another administrator's update.

All repository readers can see stored task URLs, descriptions, and Git history. Avoid recording sensitive medical or personal details.

## Record or plan time off

Select **Add time**, choose or paste a configured PTO URL, and enter a description such as `Vacation`, `Sick leave`, or `Public holiday`. The description is free text; it does not control time-off classification.

Use **Multiple days** to select individual dates (including nonconsecutive days) and the hours per day. For time-off tasks, Clockoli also accepts future dates. Individual completed entries can be scheduled ahead, but a running timer cannot start in the future. Regular work entries remain restricted to past/current times.

PTO uses the same free-slot placement and overlap prevention as other time entries. If the planned PTO overlaps an existing work session, review the day and correct the entries. All time off is non-billable in reports and invoices.

## Team calendar and reports

Open **Reports → Team time off** to see each person's time off by week, including future weeks. It reads teammates' personal branches in the connected time repositories. The calendar shows a warning if it cannot read all available branches.

A time-off entry whose end is in the future is **Planned PTO**. Only after its end time does Clockoli count the entry as **Time off taken**. Taken PTO contributes to **Total tracked** and the separate **Time off** total, but not **Work** or billable amount. Planned PTO appears in the separate Planned total and team calendar, not in Total tracked.

Reports provides a **Time type** filter and a **Time type** chart grouping. Exported CSV and JSON timesheets include the classified time type. The underlying entry remains an ordinary Clockoli work record, so existing per-user branches and standard time-entry editing continue to apply.

Clockoli does not yet manage PTO balances, requests, or approvals.
